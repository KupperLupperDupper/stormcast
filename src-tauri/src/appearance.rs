//! Chooses the skin: glass on Windows 11, solid on Windows 10 and whenever the user has
//! turned transparency effects off.

use serde::Serialize;

/// Windows 11 22H2, the first build with the documented system backdrop API.
pub const GLASS_MIN_BUILD: u32 = 22621;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Skin {
    Glass,
    Solid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub skin: Skin,
    pub windows_build: u32,
    pub transparency_effects: bool,
    /// Why this skin was chosen, for logs and bug reports.
    pub reason: String,
}

pub fn detect() -> Appearance {
    let windows_build = windows_build();
    let transparency_effects = transparency_effects_enabled();
    let forced = std::env::var("STORMCAST_SKIN").ok();
    let (skin, reason) = choose(windows_build, transparency_effects, forced.as_deref());
    Appearance {
        skin,
        windows_build,
        transparency_effects,
        reason,
    }
}

/// `STORMCAST_SKIN=glass|solid` overrides the choice, to test either design anywhere.
pub fn choose(build: u32, transparency_effects: bool, forced: Option<&str>) -> (Skin, String) {
    match forced {
        Some("glass") => return (Skin::Glass, "forced by STORMCAST_SKIN".into()),
        Some("solid") => return (Skin::Solid, "forced by STORMCAST_SKIN".into()),
        _ => {}
    }
    if build < GLASS_MIN_BUILD {
        (
            Skin::Solid,
            format!("Windows build {build} is older than {GLASS_MIN_BUILD}"),
        )
    } else if !transparency_effects {
        (Skin::Solid, "transparency effects are turned off".into())
    } else {
        (
            Skin::Glass,
            format!("Windows build {build} with transparency effects"),
        )
    }
}

#[cfg(windows)]
fn windows_build() -> u32 {
    use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|build| build.trim().parse().ok())
        .unwrap_or(0)
}

/// Settings > Personalisation > Colours > Transparency effects.
#[cfg(windows)]
fn transparency_effects_enabled() -> bool {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_value::<u32, _>("EnableTransparency"))
        .map(|value| value != 0)
        .unwrap_or(true)
}

#[cfg(not(windows))]
fn windows_build() -> u32 {
    0
}

#[cfg(not(windows))]
fn transparency_effects_enabled() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_10_gets_the_solid_skin() {
        assert_eq!(choose(19045, true, None).0, Skin::Solid);
    }

    #[test]
    fn windows_11_gets_glass() {
        assert_eq!(choose(22621, true, None).0, Skin::Glass);
        assert_eq!(choose(26200, true, None).0, Skin::Glass);
    }

    #[test]
    fn transparency_off_falls_back_to_solid() {
        assert_eq!(choose(26200, false, None).0, Skin::Solid);
    }

    #[test]
    fn the_environment_can_force_a_skin() {
        assert_eq!(choose(19045, false, Some("glass")).0, Skin::Glass);
        assert_eq!(choose(26200, true, Some("solid")).0, Skin::Solid);
        assert_eq!(choose(26200, true, Some("other")).0, Skin::Glass);
    }
}
