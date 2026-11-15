# Arkitektur: stormcast

Systemet, som det er bygget (PRJ-06), efter arc42 og C4 i kort form. Hvorfor står i [DECISIONS.md](DECISIONS.md), og hvad der er i gang, i [BACKLOG.md](BACKLOG.md). Rettes i samme commit som en ændring af lag eller mapper.

## 1. Formål og kontekst
Stormcast spejler skærmen fra en Android-enhed til en Windows-pc over et USB-kabel, lader brugeren styre enheden fra pc'en og spiller enhedens lyd på pc'en. Den taler med brugeren ved pc'en og med Android-enheden (USB-fejlsøgning slået til) gennem `adb`, som følger med i releases. Intet installeres på enheden. Trådløs forbindelse er planlagt (B-004).

## 2. Byggeklodser
```text
Android-enhed                  USB (adb reverse)   Windows-pc, Tauri 2
server/ (Java, app_process)  <================>  src-tauri/ (Rust)  <== IPC ==>  src/ (TypeScript, web-UI)
fanger skærm og lyd,                              adb, session,                  WebCodecs og canvas,
injicerer input                                   protokol, H.264                Web Audio, input
```
- **Telefonserveren** (`server/`): Java 8-syntaks uden biblioteker, kopieret til enheden og startet med `app_process`; den sletter sin jar ved start. Skjulte Android-API'er kun i `DisplayCapture.java`, `InputInjector.java` og `AudioCapture.java`, hver med en fallback (ADR-002).
- **Rust-kernen** (`src-tauri/`): `mirror.rs` styrer én session: adb push, `adb reverse` til en lokal TCP-port, start af serveren og videostrømmen til web-UI'et. `protocol.rs` er appens side af protokollen, `h264.rs` fortæller decoderen, at der ingen reordering er (ADR-003), og `appearance.rs` vælger skin.
- **Web-UI'et** (`src/`): `player.ts` afkoder med WebCodecs og tegner på canvas, `audio.ts` afspiller lyden med Web Audio, og `control.ts` gør input til styringsbeskeder. Det taler med Rust-kernen gennem Tauris IPC (`ipc.ts`).

## 3. Struktur
```text
server/      telefonserveren (Java) og dens protokoltest
src-tauri/   Rust-kernen, Tauri-konfigurationen og ikonerne
src/         web-UI'et; designværdierne i src/styles/tokens.css
protocol/    testvektorerne, som Java- og Rust-testene deler
scripts/     byg af serveren, hentning af adb, kontrasttjek og release-noter
docs/        BRAIN, BACKLOG, LOG, ARCHITECTURE, DECISIONS, PROTOCOL og DESIGN-BRIEF
.github/     CI, release-workflow og Dependabot
```

## 4. Data og flow
- **Billede:** skærmen → enhedens hardware-encoder → H.264 uden B-frames → protokollen over USB → WebCodecs på grafikkortet → canvas, hvor det nyeste billede vinder.
- **Lyd:** det, enheden spiller → 48 kHz stereo PCM med PTS på billedets ur (ADR-004) → Web Audio, planlagt nogle titals millisekunder fremme.
- **Input og udklipsholder:** web-UI'et → styringsbeskeder → Rust koder dem → serveren injicerer dem. Tekst kopieret på enheden kommer tilbage til pc'ens udklipsholder (højst 256 KiB).
- **Protokollen** er version 3 og beskrevet i [PROTOCOL.md](PROTOCOL.md): hver besked er type, længde og indhold, og ukendte typer springes over.
- Intet gemmes på enheden. Appen husker, om lyden spiller på pc'en.

## 5. Kvalitetskrav
- Første billede efter ca. et sekund (0.1.0; 1,3 s på en rigtig tablet, ADR-003).
- Lyd i synk med billedet (ui-rulebookens PERF-06). Røgtesten måler tiden fra input til billede og lydens forskydning (`STORMCAST_SMOKE_RESULT`).
- Telefonbilledet ligger aldrig under glas eller andre lag.
- UI'et følger UI-rulebooken; kontrasten tjekkes med `npm run check:contrast`.

## 6. Byg, test og drift
- Kommandoerne står i [BRAIN.md](BRAIN.md), og CI (`.github/workflows/ci.yml`) kører de samme tjek.
- Release: tagget `vX.Y.Z` matcher `version` i `package.json`. `release.yml` bygger installer og portabel zip, skriver `SHA256SUMS.txt`, attesterer bygget og udgiver med versionens afsnit i `CHANGELOG.md` som noter.
- Filerne er ikke kodesigneret endnu (B-006).

## 7. Risici og teknisk gæld
- Skjulte Android-API'er kan ændre sig fra version til version; derfor ligger de i tre filer med fallback (ADR-002).
- Uden kodesignering advarer SmartScreen første gang (B-006).

## 8. Ordliste
- **Server:** telefonserveren i `server/`, ikke en netværksserver.
- **Session:** én optagelse med en bestemt størrelse og rotation; den starter igen, når skærmen roterer eller skifter størrelse.
- **Skin:** glas eller solid (`appearance.rs`).
- **PTS:** præsentationstidsstempel; lyd og billede bruger samme ur.
- **Røgtest:** `STORMCAST_SMOKE=1`, der måler input til billede og lydens forskydning på en tilsluttet enhed.
