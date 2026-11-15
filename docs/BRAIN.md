# Brain: stormcast

Kortet over projektet (PRJ-02): hvad systemet er, og hvor tingene er. Det importeres i `CLAUDE.md` og indlæses i hver session, så det holdes under 60 linjer og peger frem for at forklare. Status står i [BACKLOG.md](BACKLOG.md) og [LOG.md](LOG.md), aldrig her. Er noget forkert, rettes det i samme commit som ændringen.

## Hvad det er
Windows-app, der spejler og styrer en Android-skærm over USB og spiller enhedens lyd på pc'en. Tauri 2: Rust i `src-tauri/`, TypeScript og CSS i `src/`, og vores egen telefonserver i Java i `server/`. Mere i [ARCHITECTURE.md](ARCHITECTURE.md); brugerens side i [README.md](../README.md).

## Hvor tingene er
Javakoden ligger i `server/src/main/java/com/stormitron/stormcast/server/`; Java-filerne nedenfor ligger dér.

| Skal du … | Så se |
|---|---|
| forstå helheden | [ARCHITECTURE.md](ARCHITECTURE.md) |
| vide, hvorfor noget er, som det er | [DECISIONS.md](DECISIONS.md) |
| se, hvad der er i gang, og hvad der er næste | [BACKLOG.md](BACKLOG.md) |
| fortsætte arbejdet fra sidst | de øverste indlæg i [LOG.md](LOG.md) |
| ændre protokollen | [PROTOCOL.md](PROTOCOL.md), `protocol/vectors.txt`, `Protocol.java` og `src-tauri/src/protocol.rs`, alle i samme commit |
| fange skærm, input, udklipsholder eller lyd på enheden | `DisplayCapture.java`, `InputInjector.java` og `AudioCapture.java`: de eneste med skjulte Android-API'er |
| gøre appens styringsbeskeder til input på enheden | `Controller.java` |
| sende lyden og give den PTS på billedets ur | `AudioStreamer.java` og `AudioTiming.java` |
| styre en session: adb push, reverse-tunnel, start af serveren og video til web-UI'et | `src-tauri/src/mirror.rs`; beskedformatet til web-UI'et deles med `src/player.ts` |
| ændre H.264-opsætningen eller decoderens reordering | `src-tauri/src/h264.rs` |
| vælge skin (glas eller solid) | `src-tauri/src/appearance.rs`: glas på Windows 11 build 22621+ med gennemsigtighed slået til |
| afkode og tegne billedet | `src/player.ts`: WebCodecs og canvas; det nyeste billede vinder |
| afspille lyden på pc'en | `src/audio.ts`: Web Audio, blokke planlagt lidt fremme, en buffer, der vokser ved underløb, og måling af lyd mod billede |
| ændre mus, touch, hjul eller tastatur | `src/control.ts`; Rust koder beskederne i `src-tauri/src/protocol.rs` |
| ændre farver, afstande og andre designværdier | `src/styles/tokens.css` (tre lag, TOK-01, TOK-02); `src/styles/app.css` bruger kun lag 2 og 3 |
| ændre en tekst i UI'et | `src/strings.ts` |
| se stil, risici og afvigelser | [DESIGN-BRIEF.md](DESIGN-BRIEF.md) |
| udgive en version | [README.md](../README.md#releases) og versionens afsnit i `CHANGELOG.md` |

## Kør og test
- `npm run tauri dev`: kør appen. Den bygger også telefonserveren.
- `npm run build:server`: serverens protokoltests og byg; kræver JDK 17+ og Android SDK.
- `npm run build` og `npm run check:contrast`.
- I `src-tauri/`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` og `cargo test`.
- Røgtest på en tilsluttet, låst op enhed: `$env:STORMCAST_SMOKE = "1"; npm run tauri dev`. Den trykker Seneste apps og Tilbage, lytter efter en testtone fra enheden og skriver `STORMCAST_SMOKE_RESULT` med tiden fra input til billede og lydens forskydning mod billedet.
- `$env:STORMCAST_SKIN = "solid"` eller `"glass"` tvinger et skin.
- Før commit også `node ~/docs/projects/tools/check.mjs .`

## Fælder
- Javakoden er Java 8-syntaks uden biblioteker, men bygges med JDK 17+.
- CI kører de samme tjek som ovenfor (`.github/workflows/ci.yml`).
