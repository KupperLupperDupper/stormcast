//! Device details for the diagnostics panel (B-008), read with one `adb shell` call: build
//! properties, the display, the battery, memory, storage and uptime. No server and no hidden
//! APIs, so it works without mirroring.

use crate::adb::Adb;
use crate::error::AppError;
use serde::Serialize;

/// Prints `key=value` lines and the raw output of `wm`, `dumpsys battery`, `/proc` and `df`.
const SCRIPT: &str = "\
echo manufacturer=$(getprop ro.product.manufacturer); \
echo model=$(getprop ro.product.model); \
echo android=$(getprop ro.build.version.release); \
echo sdk=$(getprop ro.build.version.sdk); \
echo patch=$(getprop ro.build.version.security_patch); \
echo abi=$(getprop ro.product.cpu.abi); \
wm size; wm density; dumpsys battery; \
grep MemTotal /proc/meminfo; \
echo df=$(df -k /data | tail -1); \
echo uptime=$(cat /proc/uptime)";

/// What is known about a device. Every field is optional: a device may not report it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub android: Option<String>,
    pub sdk: Option<u32>,
    pub security_patch: Option<String>,
    pub abi: Option<String>,
    pub screen_width: Option<u32>,
    pub screen_height: Option<u32>,
    /// The density in use: the override when there is one.
    pub density: Option<u32>,
    /// Percent.
    pub battery_level: Option<u32>,
    /// "charging", "discharging", "notCharging" or "full".
    pub battery_status: Option<&'static str>,
    /// "good", "overheat", "dead", "overVoltage", "failure" or "cold".
    pub battery_health: Option<&'static str>,
    pub battery_temperature_c: Option<f32>,
    /// "usb", "ac" or "wireless" when the battery is charged from it.
    pub power_source: Option<&'static str>,
    pub memory_mb: Option<u64>,
    pub storage_total_mb: Option<u64>,
    pub storage_free_mb: Option<u64>,
    pub uptime_seconds: Option<u64>,
}

pub async fn device_info(adb: &Adb, serial: &str) -> Result<DeviceInfo, AppError> {
    Ok(parse_device_info(
        &adb.run(&["-s", serial, "shell", SCRIPT]).await?,
    ))
}

pub fn parse_device_info(output: &str) -> DeviceInfo {
    let mut info = DeviceInfo::default();
    let mut physical_density = None;
    let mut override_density = None;
    let mut level = None;
    let mut scale = None;
    for line in output.lines().map(str::trim) {
        let Some((key, value)) = line.split_once(['=', ':']) else {
            continue;
        };
        let value = value.trim();
        let text = || (!value.is_empty()).then(|| value.to_string());
        match key.trim() {
            "manufacturer" => info.manufacturer = text(),
            "model" => info.model = text(),
            "android" => info.android = text(),
            "sdk" => info.sdk = value.parse().ok(),
            "patch" => info.security_patch = text(),
            "abi" => info.abi = text(),
            "Physical size" | "Override size" => {
                // The override, which comes second, is what the screen uses.
                if let Some((width, height)) = value.split_once('x') {
                    info.screen_width = width.parse().ok();
                    info.screen_height = height.parse().ok();
                }
            }
            "Physical density" => physical_density = value.parse().ok(),
            "Override density" => override_density = value.parse().ok(),
            "level" => level = value.parse::<u32>().ok(),
            "scale" => scale = value.parse::<u32>().ok(),
            "status" => info.battery_status = battery_status(value),
            "health" => info.battery_health = battery_health(value),
            "temperature" => {
                info.battery_temperature_c = value.parse::<f32>().ok().map(|tenths| tenths / 10.0)
            }
            "AC powered" if value == "true" => info.power_source = Some("ac"),
            "USB powered" if value == "true" => info.power_source = Some("usb"),
            "Wireless powered" if value == "true" => info.power_source = Some("wireless"),
            "MemTotal" => info.memory_mb = kilobytes(value).map(|kb| kb / 1024),
            "df" => {
                // filesystem, 1K-blocks, used, available, use%, mounted on
                let fields: Vec<&str> = value.split_whitespace().collect();
                if fields.len() >= 4 {
                    info.storage_total_mb = fields[1].parse::<u64>().ok().map(|kb| kb / 1024);
                    info.storage_free_mb = fields[3].parse::<u64>().ok().map(|kb| kb / 1024);
                }
            }
            "uptime" => {
                info.uptime_seconds = value
                    .split_whitespace()
                    .next()
                    .and_then(|seconds| seconds.parse::<f64>().ok())
                    .map(|seconds| seconds as u64)
            }
            _ => {}
        }
    }
    info.density = override_density.or(physical_density);
    info.battery_level = match (level, scale) {
        (Some(level), Some(scale)) if scale > 0 => Some(level * 100 / scale),
        (level, _) => level,
    };
    info
}

/// BatteryManager.BATTERY_STATUS_*.
fn battery_status(code: &str) -> Option<&'static str> {
    match code {
        "2" => Some("charging"),
        "3" => Some("discharging"),
        "4" => Some("notCharging"),
        "5" => Some("full"),
        _ => None,
    }
}

/// BatteryManager.BATTERY_HEALTH_*.
fn battery_health(code: &str) -> Option<&'static str> {
    match code {
        "2" => Some("good"),
        "3" => Some("overheat"),
        "4" => Some("dead"),
        "5" => Some("overVoltage"),
        "6" => Some("failure"),
        "7" => Some("cold"),
        _ => None,
    }
}

/// "7439756 kB" as a number of kilobytes.
fn kilobytes(value: &str) -> Option<u64> {
    value.split_whitespace().next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The script's output on a OnePlus LE2123 with Android 14, which overrides its density.
    const ONEPLUS: &str = "\
manufacturer=OnePlus
model=LE2123
android=14
sdk=34
patch=2025-04-01
abi=arm64-v8a
Physical size: 1080x2412
Physical density: 480
Override density: 420
Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Dock powered: false
  Max charging current: 500000
  status: 5
  health: 2
  present: true
  level: 100
  scale: 100
  voltage: 4434
  temperature: 241
  technology: Li-poly
MemTotal:        7439756 kB
df=/dev/block/dm-79 107067084 61316632 45619380 58% /data/misc/apexdata/com.android.art/dalvik-cache
uptime=1613439.87 8828917.82
";

    #[test]
    fn reads_a_phone() {
        assert_eq!(
            parse_device_info(ONEPLUS),
            DeviceInfo {
                manufacturer: Some("OnePlus".into()),
                model: Some("LE2123".into()),
                android: Some("14".into()),
                sdk: Some(34),
                security_patch: Some("2025-04-01".into()),
                abi: Some("arm64-v8a".into()),
                screen_width: Some(1080),
                screen_height: Some(2412),
                density: Some(420),
                battery_level: Some(100),
                battery_status: Some("full"),
                battery_health: Some("good"),
                battery_temperature_c: Some(24.1),
                power_source: Some("usb"),
                memory_mb: Some(7265),
                storage_total_mb: Some(104557),
                storage_free_mb: Some(44550),
                uptime_seconds: Some(1_613_439),
            }
        );
    }

    #[test]
    fn reads_a_tablet_on_battery() {
        let output = "\
manufacturer=LENOVO
model=TB311FU
android=16
sdk=36
patch=
Physical size: 1200x1920
Physical density: 240
  AC powered: false
  USB powered: false
  status: 3
  level: 37
  scale: 50
  temperature: 197
";
        let info = parse_device_info(output);
        assert_eq!(info.security_patch, None);
        assert_eq!(info.density, Some(240));
        assert_eq!(info.battery_level, Some(74));
        assert_eq!(info.battery_status, Some("discharging"));
        assert_eq!(info.power_source, None);
        assert_eq!(info.battery_temperature_c, Some(19.7));
        assert_eq!(info.memory_mb, None);
    }

    #[test]
    fn uses_an_override_size() {
        let info = parse_device_info("Physical size: 1440x3200\nOverride size: 1080x2400\n");
        assert_eq!(
            (info.screen_width, info.screen_height),
            (Some(1080), Some(2400))
        );
    }

    #[test]
    fn ignores_what_it_does_not_know() {
        assert_eq!(
            parse_device_info("garbage\n\nstatus: 9\n"),
            DeviceInfo::default()
        );
    }
}
