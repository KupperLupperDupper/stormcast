//! One mirroring session: push the server, open the adb tunnel, start the server and
//! forward the video stream to the web view over a Tauri channel.

use crate::adb::Adb;
use crate::error::AppError;
use crate::{h264, protocol};
use std::collections::VecDeque;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Child;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Must match the pinned server exactly, or the server refuses to start.
const SERVER_VERSION: &str = env!("SCRCPY_SERVER_VERSION");
const DEVICE_SERVER_PATH: &str = "/data/local/tmp/scrcpy-server.jar";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SERVER_LOG_LINES: usize = 20;

// First byte of every message to the web view. Keep in sync with src/player.ts.
const MSG_HELLO: u8 = 0;
const MSG_SESSION: u8 = 1;
const MSG_CONFIG: u8 = 2;
const MSG_FRAME: u8 = 3;
const MSG_END: u8 = 4;
/// Tag, flags and PTS in front of the frame data.
const FRAME_PREFIX: usize = 10;

/// The running session, if any. One device is mirrored at a time.
#[derive(Default)]
pub struct MirrorState {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl MirrorState {
    /// Starts a session in the background. Progress, errors and the end of the
    /// stream are reported on the channel, so the UI can cancel at any time.
    pub async fn start(&self, app: AppHandle, serial: String, channel: Channel<Response>) {
        let mut task = self.task.lock().await;
        if let Some(previous) = task.take() {
            previous.abort();
        }
        *task = Some(tokio::spawn(run(app, serial, channel)));
    }

    /// Stops the session. Dropping it kills the server process and closes the socket.
    pub async fn stop(&self) {
        if let Some(task) = self.task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

async fn run(app: AppHandle, serial: String, channel: Channel<Response>) {
    let (code, detail) = match mirror(&app, &serial, &channel).await {
        Ok(()) => (
            "stream_ended",
            "the device closed the video stream".to_string(),
        ),
        Err(error) => (error.code, error.detail),
    };
    log::info!("mirroring {serial} ended: {code}: {detail}");
    let end = serde_json::json!({ "code": code, "detail": detail });
    let _ = channel.send(Response::new(message(MSG_END, end.to_string().as_bytes())));
}

async fn mirror(
    app: &AppHandle,
    serial: &str,
    channel: &Channel<Response>,
) -> Result<(), AppError> {
    let adb = Adb::locate(app)?;
    let server = server_path(app)?;
    let mut session = connect(&adb, serial, &server).await?;
    log::info!("mirroring {serial} ({})", session.device_name);
    let hello = serde_json::json!({ "deviceName": session.device_name });
    send(channel, message(MSG_HELLO, hello.to_string().as_bytes()))?;
    forward(&mut session.video, channel).await
}

struct Session {
    video: TcpStream,
    device_name: String,
    /// Kept for the whole session; dropping it kills `adb shell` and with it the server.
    _server: Child,
}

async fn connect(adb: &Adb, serial: &str, server: &Path) -> Result<Session, AppError> {
    let server_file = server.to_string_lossy();
    adb.run(&["-s", serial, "push", &server_file, DEVICE_SERVER_PATH])
        .await?;

    // Reverse tunnel: we listen, the server on the device connects to us.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let scid = new_scid();
    let socket = format!("localabstract:scrcpy_{scid:08x}");
    adb.run(&["-s", serial, "reverse", &socket, &format!("tcp:{port}")])
        .await?;
    let mut tunnel = ReverseTunnel {
        adb: adb.clone(),
        serial: serial.to_string(),
        socket,
        open: true,
    };

    let class_path = format!("CLASSPATH={DEVICE_SERVER_PATH}");
    let scid_arg = format!("scid={scid:08x}");
    let mut server = adb.spawn(&[
        "-s",
        serial,
        "shell",
        &class_path,
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SERVER_VERSION,
        &scid_arg,
        "log_level=info",
        "audio=false",
        "control=false",
        "video_codec=h264",
    ])?;
    let server_log = ServerLog::attach(&mut server);

    let accepted = tokio::select! {
        accepted = tokio::time::timeout(CONNECT_TIMEOUT, listener.accept()) => accepted,
        status = server.wait() => {
            let status = status.map_or_else(|error| error.to_string(), |status| status.to_string());
            return Err(AppError::new(
                "server_failed",
                server_log.summary(&format!("the scrcpy server exited ({status})")),
            ));
        }
    };
    let mut video = match accepted {
        Ok(Ok((stream, _))) => stream,
        Ok(Err(error)) => return Err(error.into()),
        Err(_) => {
            return Err(AppError::new(
                "connect_timeout",
                server_log.summary("the device did not connect within 15 s"),
            ));
        }
    };
    // The tunnel is only needed to set up the connection.
    tunnel.close().await;
    video.set_nodelay(true)?;

    let mut meta = [0u8; protocol::DEVICE_NAME_LEN];
    video.read_exact(&mut meta).await?;
    let device_name = protocol::parse_device_name(&meta);
    let codec = video.read_u32().await?;
    if codec != protocol::CODEC_H264 {
        return Err(AppError::new(
            "unsupported_codec",
            format!(
                "expected h264, got {}",
                protocol::codec_name(codec).unwrap_or("an unknown codec")
            ),
        ));
    }
    Ok(Session {
        video,
        device_name,
        _server: server,
    })
}

/// Reads scrcpy packets and forwards them until the device closes the stream.
async fn forward(video: &mut TcpStream, channel: &Channel<Response>) -> Result<(), AppError> {
    let mut header = [0u8; protocol::HEADER_LEN];
    loop {
        match video.read_exact(&mut header).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        match protocol::parse_header(&header)? {
            protocol::Header::Session { width, height, .. } => {
                let mut body = [0u8; 8];
                body[..4].copy_from_slice(&width.to_be_bytes());
                body[4..].copy_from_slice(&height.to_be_bytes());
                send(channel, message(MSG_SESSION, &body))?;
            }
            protocol::Header::Media {
                config: true, size, ..
            } => {
                let mut config = vec![0u8; size as usize];
                video.read_exact(&mut config).await?;
                let codec = h264::codec_string(&config)
                    .ok_or_else(|| AppError::new("bad_stream", "config packet without an SPS"))?;
                send(channel, config_message(&codec, &config))?;
            }
            protocol::Header::Media {
                key_frame,
                pts,
                size,
                ..
            } => {
                // Read straight into the message buffer to avoid a copy.
                let mut msg = Vec::with_capacity(FRAME_PREFIX + size as usize);
                msg.push(MSG_FRAME);
                msg.push(u8::from(key_frame));
                msg.extend_from_slice(&pts.to_be_bytes());
                msg.resize(FRAME_PREFIX + size as usize, 0);
                video.read_exact(&mut msg[FRAME_PREFIX..]).await?;
                send(channel, msg)?;
            }
        }
    }
}

fn message(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(1 + body.len());
    msg.push(tag);
    msg.extend_from_slice(body);
    msg
}

/// `[tag][codec length][codec][SPS/PPS]`. The web view keeps the SPS/PPS so it can
/// restart its decoder at any key frame.
fn config_message(codec: &str, config: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(2 + codec.len() + config.len());
    msg.push(MSG_CONFIG);
    msg.push(u8::try_from(codec.len()).unwrap_or(u8::MAX));
    msg.extend_from_slice(codec.as_bytes());
    msg.extend_from_slice(config);
    msg
}

fn send(channel: &Channel<Response>, msg: Vec<u8>) -> Result<(), AppError> {
    channel
        .send(Response::new(msg))
        .map_err(|error| AppError::new("ui_closed", error.to_string()))
}

fn server_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("STORMCAST_SERVER_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("scrcpy-server"));
    }
    // Development builds use the copy downloaded by `npm run fetch-deps`.
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/scrcpy-server"
    )));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            AppError::new(
                "server_missing",
                format!("scrcpy-server {SERVER_VERSION} was not found; run `npm run fetch-deps`"),
            )
        })
}

/// A random 31-bit id, so several sessions can run on one device at the same time.
fn new_scid() -> u32 {
    let random = RandomState::new().build_hasher().finish();
    (random as u32) & 0x7fff_ffff
}

/// Removes the `adb reverse` rule once connected, or when the session is dropped early.
struct ReverseTunnel {
    adb: Adb,
    serial: String,
    socket: String,
    open: bool,
}

impl ReverseTunnel {
    async fn close(&mut self) {
        if !std::mem::take(&mut self.open) {
            return;
        }
        let args = [
            "-s",
            self.serial.as_str(),
            "reverse",
            "--remove",
            self.socket.as_str(),
        ];
        if let Err(error) = self.adb.run(&args).await {
            log::warn!("could not remove the adb tunnel {}: {error}", self.socket);
        }
    }
}

impl Drop for ReverseTunnel {
    fn drop(&mut self) {
        if self.open {
            self.adb
                .run_detached(&["-s", &self.serial, "reverse", "--remove", &self.socket]);
        }
    }
}

/// Logs the server's output and keeps the last lines for error messages.
#[derive(Clone, Default)]
struct ServerLog(Arc<StdMutex<VecDeque<String>>>);

impl ServerLog {
    fn attach(server: &mut Child) -> Self {
        let log = Self::default();
        if let Some(stdout) = server.stdout.take() {
            tokio::spawn(log.clone().collect(stdout));
        }
        if let Some(stderr) = server.stderr.take() {
            tokio::spawn(log.clone().collect(stderr));
        }
        log
    }

    async fn collect(self, pipe: impl AsyncRead + Unpin) {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end().to_string();
            log::info!(target: "scrcpy_server", "{line}");
            let mut buffer = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if buffer.len() == SERVER_LOG_LINES {
                buffer.pop_front();
            }
            buffer.push_back(line);
        }
    }

    fn summary(&self, what: &str) -> String {
        let buffer = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if buffer.is_empty() {
            return what.to_string();
        }
        let lines: Vec<&str> = buffer.iter().map(String::as_str).collect();
        format!("{what}. Server output:\n{}", lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_message_carries_codec_and_sps_pps() {
        let msg = config_message("avc1.64002A", &[0, 0, 0, 1, 0x67]);
        assert_eq!(msg[0], MSG_CONFIG);
        assert_eq!(msg[1], 11);
        assert_eq!(&msg[2..13], b"avc1.64002A");
        assert_eq!(&msg[13..], &[0, 0, 0, 1, 0x67]);
    }

    #[test]
    fn message_prefixes_the_tag() {
        assert_eq!(message(MSG_END, b"{}"), vec![MSG_END, b'{', b'}']);
    }

    #[test]
    fn scid_fits_in_31_bits() {
        for _ in 0..100 {
            assert!(new_scid() <= 0x7fff_ffff);
        }
    }

    #[test]
    fn server_log_summary_includes_the_last_lines() {
        let log = ServerLog::default();
        assert_eq!(log.summary("failed"), "failed");
        log.0.lock().unwrap().push_back("ERROR: boom".into());
        assert_eq!(log.summary("failed"), "failed. Server output:\nERROR: boom");
    }
}
