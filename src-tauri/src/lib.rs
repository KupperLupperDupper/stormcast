//! Stormcast mirrors and controls an Android screen from Windows over USB.
//!
//! The Rust side finds `adb`, starts Stormcast's server on the device, forwards the H.264
//! stream to the web view, which decodes it with WebCodecs (`src/player.ts`), and the
//! device's sound, which it plays with Web Audio (`src/audio.ts`), and sends the web view's
//! input back to the device (`src/control.ts`).

mod adb;
mod appearance;
mod error;
mod h264;
mod mirror;
mod protocol;

use appearance::{Appearance, Skin};
use error::AppError;
use mirror::{MirrorState, ServerOptions};
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// What the web view needs before it renders anything.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Startup {
    appearance: Appearance,
    /// `STORMCAST_SMOKE=1`: mirror the first ready device, report and exit.
    smoke: bool,
}

#[tauri::command]
fn get_startup(startup: State<'_, Startup>) -> Startup {
    startup.inner().clone()
}

#[tauri::command]
async fn list_devices(app: AppHandle) -> Result<Vec<adb::Device>, AppError> {
    adb::Adb::locate(&app)?.devices().await
}

/// `audio`: play the device's sound on the PC from the start.
#[tauri::command]
async fn start_mirror(
    app: AppHandle,
    state: State<'_, MirrorState>,
    startup: State<'_, Startup>,
    serial: String,
    audio: bool,
    on_packet: Channel<Response>,
) -> Result<(), AppError> {
    let options = ServerOptions {
        audio,
        // The smoke test listens for a tone from the device.
        tone: startup.smoke,
    };
    state.start(app, serial, options, on_packet).await;
    Ok(())
}

#[tauri::command]
async fn stop_mirror(state: State<'_, MirrorState>) -> Result<(), AppError> {
    state.stop().await;
    Ok(())
}

/// The web view sends one batch at a time, so the messages reach the device in order.
#[tauri::command]
async fn send_control(
    state: State<'_, MirrorState>,
    messages: Vec<protocol::Control>,
) -> Result<(), AppError> {
    state.send_control(messages).await
}

#[tauri::command]
fn smoke_report(app: AppHandle, report: serde_json::Value) {
    let ok = report["ok"].as_bool().unwrap_or(false);
    log::info!(
        "smoke test {}: {report}",
        if ok { "passed" } else { "failed" }
    );
    println!("STORMCAST_SMOKE_RESULT {report}");
    app.exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup = Startup {
        appearance: appearance::detect(),
        smoke: std::env::var("STORMCAST_SMOKE").is_ok_and(|value| value == "1"),
    };

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(MirrorState::default())
        .setup(move |app| {
            log::info!("appearance: {:?}", startup.appearance);
            let glass = startup.appearance.skin == Skin::Glass;
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Stormcast")
                .inner_size(1120.0, 760.0)
                .min_inner_size(480.0, 420.0)
                // TYP-02: Ctrl + plus/minus scales the whole UI, also to 200 %.
                .zoom_hotkeys_enabled(true)
                .transparent(glass);
            if glass {
                // Fluent Acrylic behind the whole window. Windows itself falls back to a
                // solid colour when the window is inactive or energy saver is on.
                window = window.effects(EffectsBuilder::new().effect(Effect::Acrylic).build());
            }
            window.build()?;
            app.manage(startup.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup,
            list_devices,
            start_mirror,
            stop_mirror,
            send_control,
            smoke_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stormcast");
}
