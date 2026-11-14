use std::fs;

fn main() {
    // scrcpy-server.json is the one source for the pinned server version. The client
    // passes this version to the server, which refuses to start on any mismatch.
    println!("cargo:rerun-if-changed=scrcpy-server.json");
    let pin: serde_json::Value = serde_json::from_str(
        &fs::read_to_string("scrcpy-server.json").expect("read scrcpy-server.json"),
    )
    .expect("parse scrcpy-server.json");
    let version = pin["version"]
        .as_str()
        .expect("scrcpy-server.json has a version");
    println!("cargo:rustc-env=SCRCPY_SERVER_VERSION={version}");

    tauri_build::build()
}
