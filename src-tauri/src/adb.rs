//! Finding and running `adb`.

use crate::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::process::{Child, Command};

const RUN_TIMEOUT: Duration = Duration::from_secs(30);
const ADB_EXE: &str = if cfg!(windows) { "adb.exe" } else { "adb" };
/// Keeps `adb` from flashing a console window when started from the GUI.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone)]
pub struct Adb {
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub serial: String,
    /// adb state: "device" when ready, otherwise "unauthorized", "offline", …
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
}

impl Adb {
    /// Uses the bundled adb first, then `ADB`, the Android SDK and `PATH`.
    pub fn locate(app: &AppHandle) -> Result<Self, AppError> {
        let bundled = app
            .path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join("platform-tools").join(ADB_EXE));
        find_adb(bundled).map(|path| Self { path }).ok_or_else(|| {
            AppError::new(
                "adb_not_found",
                "adb was not found next to Stormcast, in ADB, ANDROID_HOME, ANDROID_SDK_ROOT or on PATH",
            )
        })
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(&self.path);
        command.args(args).stdin(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    /// Runs a short adb command and returns its standard output.
    pub async fn run(&self, args: &[&str]) -> Result<String, AppError> {
        let output = tokio::time::timeout(RUN_TIMEOUT, self.command(args).output())
            .await
            .map_err(|_| AppError::new("adb_failed", format!("adb {} timed out", args.join(" "))))?
            .map_err(|error| AppError::new("adb_failed", format!("could not run adb: {error}")))?;
        if !output.status.success() {
            return Err(classify_failure(
                args,
                &String::from_utf8_lossy(&output.stderr),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Starts a long-running adb command. The process is killed when the handle is dropped.
    pub fn spawn(&self, args: &[&str]) -> Result<Child, AppError> {
        self.command(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| AppError::new("adb_failed", format!("could not start adb: {error}")))
    }

    /// Runs an adb command in the background and ignores the result. For clean-up in `Drop`.
    pub fn run_detached(&self, args: &[&str]) {
        let mut command = std::process::Command::new(&self.path);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        std::thread::spawn(move || {
            let _ = command.status();
        });
    }

    pub async fn devices(&self) -> Result<Vec<Device>, AppError> {
        Ok(parse_devices(&self.run(&["devices", "-l"]).await?))
    }
}

fn find_adb(bundled: Option<PathBuf>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = bundled.into_iter().collect();
    if let Some(path) = std::env::var_os("ADB") {
        candidates.push(PathBuf::from(path));
    }
    for variable in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(sdk) = std::env::var_os(variable) {
            candidates.push(Path::new(&sdk).join("platform-tools").join(ADB_EXE));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(ADB_EXE)));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            Path::new(&local)
                .join("Android")
                .join("Sdk")
                .join("platform-tools")
                .join(ADB_EXE),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Parses `adb devices -l`. Daemon messages (lines starting with `*`) are skipped.
pub fn parse_devices(output: &str) -> Vec<Device> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && !line.starts_with('*') && !line.starts_with("List of devices")
        })
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let mut model = None;
            let mut product = None;
            for part in parts {
                match part.split_once(':') {
                    Some(("model", value)) => model = Some(value.replace('_', " ")),
                    Some(("product", value)) => product = Some(value.to_string()),
                    _ => {}
                }
            }
            Some(Device {
                serial,
                state,
                model,
                product,
            })
        })
        .collect()
}

fn classify_failure(args: &[&str], stderr: &str) -> AppError {
    let lower = stderr.to_lowercase();
    let code = if lower.contains("unauthorized") {
        "device_unauthorized"
    } else if lower.contains("offline") || lower.contains("not found") {
        "device_offline"
    } else {
        "adb_failed"
    };
    AppError::new(
        code,
        format!("adb {} failed: {}", args.join(" "), stderr.trim()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devices_and_skips_daemon_messages() {
        let output = "\
* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
0A1B2C3D               device product:TB311FU_EEA model:TB311FU device:TB311FU transport_id:3
emulator-5554          offline transport_id:1
R5CT1234567            unauthorized usb:1-1 transport_id:4
192.168.1.20:5555      device product:panther model:Pixel_7 device:panther transport_id:5

";
        let devices = parse_devices(output);
        assert_eq!(devices.len(), 4);
        assert_eq!(
            devices[0],
            Device {
                serial: "0A1B2C3D".into(),
                state: "device".into(),
                model: Some("TB311FU".into()),
                product: Some("TB311FU_EEA".into()),
            }
        );
        assert_eq!(devices[1].state, "offline");
        assert_eq!(devices[2].state, "unauthorized");
        assert_eq!(devices[2].model, None);
        assert_eq!(devices[3].model.as_deref(), Some("Pixel 7"));
    }

    #[test]
    fn parses_an_empty_list() {
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn classifies_adb_failures() {
        let args = ["-s", "X", "push"];
        assert_eq!(
            classify_failure(&args, "adb: device unauthorized.").code,
            "device_unauthorized"
        );
        assert_eq!(
            classify_failure(&args, "adb: device offline").code,
            "device_offline"
        );
        assert_eq!(
            classify_failure(&args, "adb: device 'X' not found").code,
            "device_offline"
        );
        assert_eq!(classify_failure(&args, "something else").code, "adb_failed");
    }
}
