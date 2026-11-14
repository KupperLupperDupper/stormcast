# Stormcast

Windows-app, der spejler en Android-skærm over USB. Tauri 2: Rust i `src-tauri/`, TypeScript og CSS i `src/`, og vores egen telefonserver i Java i `server/`.

@~/docs/ui-rulebook/RULEBOOK.md

## Hvor ting ligger
- `server/`: telefonserveren (Java 8-syntaks, ingen biblioteker). `DisplayCapture.java` er det eneste sted med skjulte Android-API'er.
- `docs/PROTOCOL.md` og `protocol/vectors.txt`: protokollen mellem server og app, og testvektorerne, som både Java- og Rust-testene bruger.
- `src-tauri/src/protocol.rs`: appens side af protokollen.
- `src-tauri/src/mirror.rs`: én session med adb push, reverse-tunnel, start af serveren og videostrømmen til web-UI'et. Beskedformatet til web-UI'et deles med `src/player.ts`.
- `src-tauri/src/appearance.rs`: vælger skin. Glas på Windows 11 build 22621+ med gennemsigtighed slået til, ellers solid.
- `src/player.ts`: afkodning med WebCodecs og tegning på canvas; det nyeste billede vinder.
- `src/styles/tokens.css`: alle designværdier i tre lag (TOK-01, TOK-02). `src/styles/app.css` bruger kun lag 2 og 3.
- `src/strings.ts`: al tekst i UI'et.
- `docs/DESIGN-BRIEF.md`: stil, tokens, risici og afvigelser.

## Kommandoer
- `npm run tauri dev`: kør appen. Den bygger også telefonserveren.
- `npm run build:server`: serverens protokoltests og byg; kræver JDK 17+ og Android SDK.
- `npm run build` og `npm run check:contrast`.
- I `src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` og `cargo test`.
- Røgtest på en tilsluttet enhed: `$env:STORMCAST_SMOKE = "1"; npm run tauri dev`. Den skriver `STORMCAST_SMOKE_RESULT`.
- `$env:STORMCAST_SKIN = "solid"` eller `"glass"` tvinger et skin.

## Regler
- En protokolændring ændrer `docs/PROTOCOL.md`, `protocol/vectors.txt`, Java og Rust i samme commit, og testene i begge ender skal være grønne.
- Nye skjulte Android-kald hører til i `DisplayCapture.java` og skal have en fallback.
- Serveren slår aldrig B-frames til. Appen fortæller decoderen, at der ingen reordering er (`h264.rs`), ellers holder decoderen billeder tilbage.
- App-ID og Java-pakke er `com.stormitron.stormcast`; udgiveren er Stormitron.
- Telefonbilledet må aldrig ligge under glas eller andre lag.
- Release: tagget `vX.Y.Z` skal matche `version` i `package.json`.
