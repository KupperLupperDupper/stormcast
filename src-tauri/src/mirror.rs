//! One mirroring session: push our server to the device, open the adb tunnel, start the
//! server, forward its video and audio to the web view over a Tauri channel, and send the web
//! view's control messages back on the same connection.

use crate::adb::Adb;
use crate::error::AppError;
use crate::{h264, protocol};
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Child;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Built from `server/` by `npm run build:server`.
const SERVER_FILE: &str = "stormcast-server.jar";
const DEVICE_SERVER_PATH: &str = "/data/local/tmp/stormcast-server.jar";
const SERVER_CLASS: &str = "com.stormitron.stormcast.server.Server";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SERVER_LOG_LINES: usize = 20;
/// The same copied text again within this time is the same copy.
const REPEATED_COPY_WINDOW: Duration = Duration::from_secs(1);

// First byte of every message to the web view. Keep in sync with src/player.ts.
const MSG_HELLO: u8 = 0;
const MSG_SESSION: u8 = 1;
const MSG_CONFIG: u8 = 2;
const MSG_FRAME: u8 = 3;
const MSG_END: u8 = 4;
const MSG_AUDIO_CONFIG: u8 = 5;
const MSG_AUDIO: u8 = 6;
const MSG_AUDIO_OFF: u8 = 7;
const MSG_DEVICE_STATE: u8 = 8;

/// How the server starts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ServerOptions {
    /// Capture audio from the start.
    pub audio: bool,
    /// Play a test tone on the device once audio capture runs (the smoke test).
    pub tone: bool,
}

impl ServerOptions {
    /// `key=value` arguments for the server (docs/PROTOCOL.md).
    fn args(self) -> Vec<String> {
        let mut args = vec![format!("audio={}", u8::from(self.audio))];
        if self.tone {
            args.push("tone=1".into());
        }
        args
    }
}

/// The running sessions, one per device by serial (B-007): several devices are mirrored at once.
#[derive(Default)]
pub struct MirrorState {
    sessions: Mutex<HashMap<String, Running>>,
}

struct Running {
    task: JoinHandle<()>,
    control: ControlLink,
}

impl Running {
    /// Dropping the task kills the server process and closes the socket.
    async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
        self.control.detach().await;
    }
}

impl MirrorState {
    /// Starts a session for the device in the background, in place of one it already has.
    /// Progress, errors and the end of the stream are reported on the channel, so the UI can
    /// cancel at any time. Other devices' sessions go on.
    pub async fn start(
        &self,
        app: AppHandle,
        serial: String,
        options: ServerOptions,
        channel: Channel<Response>,
    ) {
        let mut sessions = self.sessions.lock().await;
        if let Some(previous) = sessions.remove(&serial) {
            previous.stop().await;
        }
        let control = ControlLink::default();
        let task = tokio::spawn(run(app, serial.clone(), options, channel, control.clone()));
        sessions.insert(serial, Running { task, control });
    }

    /// Stops the device's session, if it has one.
    pub async fn stop(&self, serial: &str) {
        let running = self.sessions.lock().await.remove(serial);
        if let Some(running) = running {
            running.stop().await;
        }
    }

    /// Sends control messages to the device in this order. Without a session they are dropped.
    pub async fn send_control(
        &self,
        serial: &str,
        messages: Vec<protocol::Control>,
    ) -> Result<(), AppError> {
        let mut bytes = Vec::new();
        for message in messages {
            if matches!(message, protocol::Control::Paste) {
                for message in paste_from_pc().await {
                    message.encode(&mut bytes)?;
                }
            } else {
                message.encode(&mut bytes)?;
            }
        }
        let control = self
            .sessions
            .lock()
            .await
            .get(serial)
            .map(|running| running.control.clone());
        match control {
            Some(control) => control.send(&bytes).await,
            None => Ok(()),
        }
    }
}

/// The sending half of the session's connection, which carries the control messages.
#[derive(Clone, Default)]
struct ControlLink(Arc<Mutex<Option<OwnedWriteHalf>>>);

impl ControlLink {
    async fn attach(&self, writer: OwnedWriteHalf) {
        *self.0.lock().await = Some(writer);
    }

    /// Dropping the writer closes the connection once the reading half is gone too.
    async fn detach(&self) {
        self.0.lock().await.take();
    }

    async fn send(&self, bytes: &[u8]) -> Result<(), AppError> {
        let mut writer = self.0.lock().await;
        let Some(stream) = writer.as_mut() else {
            return Ok(());
        };
        if let Err(error) = stream.write_all(bytes).await {
            // The connection is gone; the video side reports why.
            writer.take();
            return Err(AppError::new("control_failed", error.to_string()));
        }
        Ok(())
    }
}

async fn run(
    app: AppHandle,
    serial: String,
    options: ServerOptions,
    channel: Channel<Response>,
    control: ControlLink,
) {
    let result = mirror(&app, &serial, options, &channel, &control).await;
    control.detach().await;
    let (code, detail) = match result {
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
    options: ServerOptions,
    channel: &Channel<Response>,
    control: &ControlLink,
) -> Result<(), AppError> {
    let adb = Adb::locate(app)?;
    let server = server_path(app)?;
    let session = connect(&adb, serial, &server, options).await?;
    log::info!(
        "mirroring {serial}: {} (server {})",
        session.hello.device,
        session.hello.server
    );
    let hello = serde_json::json!({ "deviceName": session.hello.device });
    send(channel, message(MSG_HELLO, hello.to_string().as_bytes()))?;
    let (mut video, writer) = session.video.into_split();
    control.attach(writer).await;
    forward(&mut video, channel).await
}

struct Session {
    video: TcpStream,
    hello: protocol::Hello,
    /// Kept for the whole session; dropping it kills `adb shell` and with it the server.
    _server: Child,
}

async fn connect(
    adb: &Adb,
    serial: &str,
    server: &Path,
    options: ServerOptions,
) -> Result<Session, AppError> {
    let server_file = server.to_string_lossy();
    adb.run(&["-s", serial, "push", &server_file, DEVICE_SERVER_PATH])
        .await?;

    // Reverse tunnel: we listen, and the server on the device connects to us.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let socket_name = format!("stormcast_{:08x}", new_socket_id());
    let tunnel_socket = format!("localabstract:{socket_name}");
    adb.run(&[
        "-s",
        serial,
        "reverse",
        &tunnel_socket,
        &format!("tcp:{port}"),
    ])
    .await?;
    let mut tunnel = ReverseTunnel {
        adb: adb.clone(),
        serial: serial.to_string(),
        socket: tunnel_socket,
        open: true,
    };

    let class_path = format!("CLASSPATH={DEVICE_SERVER_PATH}");
    let version = protocol::VERSION.to_string();
    let socket_arg = format!("socket={socket_name}");
    let option_args = options.args();
    let mut args = vec![
        "-s",
        serial,
        "shell",
        &class_path,
        "app_process",
        "/",
        SERVER_CLASS,
        &version,
        &socket_arg,
    ];
    args.extend(option_args.iter().map(String::as_str));
    let mut server = adb.spawn(&args)?;
    let server_log = ServerLog::attach(&mut server, serial);

    let accepted = tokio::select! {
        accepted = tokio::time::timeout(CONNECT_TIMEOUT, listener.accept()) => accepted,
        status = server.wait() => {
            let status = status.map_or_else(|error| error.to_string(), |status| status.to_string());
            return Err(AppError::new(
                "server_failed",
                server_log.summary(&format!("the server exited ({status})")),
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

    let mut preamble = [0u8; protocol::PREAMBLE_LEN];
    video.read_exact(&mut preamble).await?;
    protocol::check_preamble(&preamble)?;
    let header = read_header(&mut video).await?.ok_or_else(|| {
        AppError::new(
            "server_failed",
            "the device closed the connection before saying hello",
        )
    })?;
    let payload = read_payload(&mut video, header.length).await?;
    let hello = match header.kind {
        protocol::TYPE_HELLO => protocol::parse_hello(&payload)?,
        protocol::TYPE_ERROR => return Err(protocol::parse_error(&payload).into()),
        other => {
            return Err(AppError::new(
                "bad_stream",
                format!("expected hello, got message type {other}"),
            ));
        }
    };
    if hello.codec != "h264" {
        return Err(AppError::new(
            "unsupported_codec",
            format!("the server offers {}", hello.codec),
        ));
    }
    Ok(Session {
        video,
        hello,
        _server: server,
    })
}

/// Forwards the server's messages to the web view until the device closes the stream.
async fn forward(
    video: &mut (impl AsyncRead + Unpin),
    channel: &Channel<Response>,
) -> Result<(), AppError> {
    // A device can report one copy twice; the PC's clipboard history gets it once.
    let mut last_copy: Option<(String, Instant)> = None;
    while let Some(header) = read_header(video).await? {
        let payload = read_payload(video, header.length).await?;
        match header.kind {
            protocol::TYPE_SESSION => {
                let session = protocol::parse_session(&payload)?;
                log::info!(
                    "video session {}x{}, rotation {}",
                    session.width,
                    session.height,
                    session.rotation
                );
                send(channel, session_message(session.width, session.height))?;
            }
            protocol::TYPE_CONFIG => {
                log::info!("encoder config {}", hex(&payload));
                // Tell the decoder there is no reordering, or it holds frames back.
                let config = h264::low_latency_config(&payload).unwrap_or_else(|| {
                    log::warn!("could not rewrite the SPS; the decoder may hold frames back");
                    payload.clone()
                });
                let codec = h264::codec_string(&config)
                    .ok_or_else(|| AppError::new("bad_stream", "config without an SPS"))?;
                send(channel, config_message(&codec, &config))?;
            }
            protocol::TYPE_FRAME => {
                send(channel, frame_message(&protocol::parse_frame(&payload)?))?;
            }
            protocol::TYPE_AUDIO_CONFIG => {
                send(
                    channel,
                    audio_config_message(&protocol::parse_audio_config(&payload)?),
                )?;
            }
            protocol::TYPE_AUDIO => {
                protocol::parse_audio(&payload)?;
                send(channel, message(MSG_AUDIO, &payload))?;
            }
            protocol::TYPE_AUDIO_OFF => {
                let reason = protocol::parse_audio_off(&payload)?;
                log::info!(
                    "audio stopped on the device: {}",
                    protocol::audio_off_reason(reason)
                );
                send(channel, message(MSG_AUDIO_OFF, &[reason]))?;
            }
            protocol::TYPE_DEVICE_STATE => {
                let flags = protocol::parse_device_state(&payload)?;
                log::info!("device state: {}", protocol::describe_device_state(flags));
                send(channel, message(MSG_DEVICE_STATE, &[flags]))?;
            }
            protocol::TYPE_ERROR => return Err(protocol::parse_error(&payload).into()),
            protocol::TYPE_CLIPBOARD => {
                let text = protocol::parse_clipboard(&payload);
                let repeated = last_copy
                    .as_ref()
                    .is_some_and(|(last, at)| *last == text && at.elapsed() < REPEATED_COPY_WINDOW);
                if !repeated {
                    last_copy = Some((text.clone(), Instant::now()));
                    copy_to_pc(text);
                }
            }
            // Skipped, so a newer server with more message types still works.
            _ => {}
        }
    }
    Ok(())
}

/// The next message header, or `None` when the device closed the stream.
async fn read_header(
    video: &mut (impl AsyncRead + Unpin),
) -> Result<Option<protocol::Header>, AppError> {
    let mut bytes = [0u8; protocol::HEADER_LEN];
    match video.read_exact(&mut bytes).await {
        Ok(_) => protocol::parse_header(&bytes).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn read_payload(
    video: &mut (impl AsyncRead + Unpin),
    length: u32,
) -> Result<Vec<u8>, AppError> {
    let mut payload = vec![0u8; length as usize];
    video.read_exact(&mut payload).await?;
    Ok(payload)
}

/// What Ctrl+V sends: the PC's clipboard text, set on the device and pasted. Without text on the
/// PC, the device pastes its own clipboard, as Ctrl+V does there.
async fn paste_from_pc() -> Vec<protocol::Control> {
    let text = pc_clipboard_text().await.unwrap_or_default();
    if text.len() > protocol::MAX_CLIPBOARD {
        log::warn!(
            "the PC's clipboard holds {} bytes, more than the {} that can be pasted",
            text.len(),
            protocol::MAX_CLIPBOARD
        );
        return Vec::new();
    }
    if text.is_empty() {
        return [protocol::KeyAction::Down, protocol::KeyAction::Up]
            .map(|action| protocol::Control::Key {
                action,
                keycode: protocol::KEYCODE_PASTE,
                repeat: 0,
                meta_state: 0,
            })
            .to_vec();
    }
    vec![protocol::Control::SetClipboard { text, paste: true }]
}

/// The text on the PC's clipboard, if it holds any.
async fn pc_clipboard_text() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        arboard::Clipboard::new().and_then(|mut clipboard| clipboard.get_text())
    })
    .await
    .ok()?
    .ok()
}

/// Puts text copied on the device on the PC's clipboard. The text itself is never logged.
fn copy_to_pc(text: String) {
    tokio::task::spawn_blocking(move || {
        let characters = text.chars().count();
        match arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(text)) {
            Ok(()) => log::info!("copied {characters} characters from the device to the PC"),
            Err(error) => log::warn!("could not copy to the PC's clipboard: {error}"),
        }
    });
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

fn message(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(1 + body.len());
    msg.push(tag);
    msg.extend_from_slice(body);
    msg
}

/// `[tag][u32 width][u32 height]`
fn session_message(width: u32, height: u32) -> Vec<u8> {
    let mut msg = Vec::with_capacity(9);
    msg.push(MSG_SESSION);
    msg.extend_from_slice(&width.to_be_bytes());
    msg.extend_from_slice(&height.to_be_bytes());
    msg
}

/// `[tag][codec length][codec][SPS/PPS]`. The web view keeps the SPS/PPS, so it can restart
/// its decoder at any key frame.
fn config_message(codec: &str, config: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(2 + codec.len() + config.len());
    msg.push(MSG_CONFIG);
    msg.push(u8::try_from(codec.len()).unwrap_or(u8::MAX));
    msg.extend_from_slice(codec.as_bytes());
    msg.extend_from_slice(config);
    msg
}

/// `[tag][flags][u64 pts][data]`
fn frame_message(frame: &protocol::Frame<'_>) -> Vec<u8> {
    let mut msg = Vec::with_capacity(10 + frame.data.len());
    msg.push(MSG_FRAME);
    msg.push(u8::from(frame.key_frame));
    msg.extend_from_slice(&frame.pts.to_be_bytes());
    msg.extend_from_slice(frame.data);
    msg
}

/// `[tag][u32 sample rate][u8 channels]` for PCM the web view can play, otherwise audio off:
/// the server and the app ship together, so another format is a bug.
fn audio_config_message(config: &protocol::AudioConfig) -> Vec<u8> {
    let playable = config.codec == protocol::AUDIO_CODEC_PCM_S16LE
        && config.sample_rate > 0
        && (1..=2).contains(&config.channels);
    if !playable {
        log::warn!("the device sends audio the app cannot play: {config:?}");
        return message(MSG_AUDIO_OFF, &[protocol::AUDIO_OFF_FAILED]);
    }
    log::info!(
        "audio {} Hz, {} channels",
        config.sample_rate,
        config.channels
    );
    let mut msg = Vec::with_capacity(6);
    msg.push(MSG_AUDIO_CONFIG);
    msg.extend_from_slice(&config.sample_rate.to_be_bytes());
    msg.push(config.channels);
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
        candidates.push(dir.join(SERVER_FILE));
    }
    // Development builds use the jar from `npm run build:server`.
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(SERVER_FILE),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            AppError::new(
                "server_missing",
                format!("{SERVER_FILE} was not found; run `npm run build:server`"),
            )
        })
}

/// A random 31-bit id, so several sessions can run on one device at the same time.
fn new_socket_id() -> u32 {
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
    /// Each line in the app's log starts with the device's serial, as several run at once.
    fn attach(server: &mut Child, serial: &str) -> Self {
        let log = Self::default();
        if let Some(stdout) = server.stdout.take() {
            tokio::spawn(log.clone().collect(stdout, serial.to_string()));
        }
        if let Some(stderr) = server.stderr.take() {
            tokio::spawn(log.clone().collect(stderr, serial.to_string()));
        }
        log
    }

    async fn collect(self, pipe: impl AsyncRead + Unpin, serial: String) {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim_end().to_string();
            log::info!(target: "stormcast_server", "{serial}: {line}");
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
    fn session_message_carries_the_size() {
        assert_eq!(
            session_message(1200, 1920),
            vec![MSG_SESSION, 0, 0, 0x04, 0xb0, 0, 0, 0x07, 0x80]
        );
    }

    #[test]
    fn config_message_carries_codec_and_sps_pps() {
        let msg = config_message("avc1.64002A", &[0, 0, 0, 1, 0x67]);
        assert_eq!(msg[0], MSG_CONFIG);
        assert_eq!(msg[1], 11);
        assert_eq!(&msg[2..13], b"avc1.64002A");
        assert_eq!(&msg[13..], &[0, 0, 0, 1, 0x67]);
    }

    #[test]
    fn frame_message_keeps_flags_pts_and_data() {
        let frame = protocol::Frame {
            key_frame: true,
            pts: 1_234_567,
            data: &[0, 0, 0, 1, 0x65],
        };
        assert_eq!(
            frame_message(&frame),
            vec![
                MSG_FRAME, 1, 0, 0, 0, 0, 0, 0x12, 0xd6, 0x87, 0, 0, 0, 1, 0x65
            ]
        );
    }

    #[test]
    fn audio_config_message_carries_rate_and_channels() {
        let pcm = |sample_rate, channels| protocol::AudioConfig {
            codec: protocol::AUDIO_CODEC_PCM_S16LE,
            sample_rate,
            channels,
        };
        assert_eq!(
            audio_config_message(&pcm(48_000, 2)),
            vec![MSG_AUDIO_CONFIG, 0, 0, 0xbb, 0x80, 2]
        );
        let unplayable = vec![MSG_AUDIO_OFF, protocol::AUDIO_OFF_FAILED];
        assert_eq!(audio_config_message(&pcm(48_000, 6)), unplayable);
        let opus = protocol::AudioConfig {
            codec: 1,
            ..pcm(48_000, 2)
        };
        assert_eq!(audio_config_message(&opus), unplayable);
    }

    #[test]
    fn server_options_become_arguments() {
        assert_eq!(ServerOptions::default().args(), ["audio=0"]);
        let smoke = ServerOptions {
            audio: true,
            tone: true,
        };
        assert_eq!(smoke.args(), ["audio=1", "tone=1"]);
    }

    #[test]
    fn message_prefixes_the_tag() {
        assert_eq!(message(MSG_END, b"{}"), vec![MSG_END, b'{', b'}']);
    }

    #[test]
    fn socket_id_fits_in_31_bits() {
        for _ in 0..100 {
            assert!(new_socket_id() <= 0x7fff_ffff);
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
