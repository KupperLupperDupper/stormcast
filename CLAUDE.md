# Stormcast

Windows-app, der spejler en Android-skærm over USB. Tauri 2: Rust i `src-tauri/`, TypeScript og CSS i `src/`.

@~/docs/ui-rulebook/RULEBOOK.md

## Hvor ting ligger
- `src-tauri/scrcpy-server.json`: den låste scrcpy-server (version, URL, SHA-256). Klient og server skal have præcis samme version.
- `src-tauri/src/protocol.rs`: scrcpy-protokollen for den låste version (headers, device meta).
- `src-tauri/src/mirror.rs`: én session med adb push, reverse-tunnel, start af serveren og videostrømmen til web-UI'et. Beskedformatet deles med `src/player.ts`.
- `src-tauri/src/appearance.rs`: vælger skin. Glas på Windows 11 build 22621+ med gennemsigtighed slået til, ellers solid.
- `src/player.ts`: afkodning med WebCodecs og tegning på canvas; det nyeste billede vinder.
- `src/styles/tokens.css`: alle designværdier i tre lag (TOK-01, TOK-02). `src/styles/app.css` bruger kun lag 2 og 3.
- `src/strings.ts`: al tekst i UI'et.
- `docs/DESIGN-BRIEF.md`: stil, tokens, risici og afvigelser.

## Kommandoer
- `npm run fetch-deps` én gang, derefter `npm run tauri dev`.
- `npm run build` og `npm run check:contrast`.
- I `src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` og `cargo test`.
- Røgtest på en tilsluttet enhed: `$env:STORMCAST_SMOKE = "1"; npm run tauri dev`. Den skriver `STORMCAST_SMOKE_RESULT`.
- `$env:STORMCAST_SKIN = "solid"` eller `"glass"` tvinger et skin.

## Regler
- Ny scrcpy-version: læs `doc/develop.md` og `Streamer.java` for netop den version, ret `protocol.rs` og testene, og opdater `scrcpy-server.json` med version og SHA-256 fra `SHA256SUMS.txt`.
- Telefonbilledet må aldrig ligge under glas eller andre lag.
- Release: tagget `vX.Y.Z` skal matche `version` i `package.json`.
