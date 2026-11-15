# Beslutninger: stormcast

Arkitekturbeslutninger (ADR, PRJ-06): én pr. beslutning, der er dyr at lave om, nyeste nederst. En ADR rettes ikke bagefter. En ny ADR erstatter den, og den gamle får status "Erstattet af ADR-…". ADR-002 til ADR-004 er skrevet ned 2026-11-15 ud fra commit-beskederne og dokumentationen; begrundelser, der ikke stod dér, er ikke gættet.

## ADR-001 · Projektet holdes sporbart med projects
- **Dato og status:** 2026-11-15 · Accepteret
- **Kontekst:** Flere sessioner, ofte på flere maskiner, arbejder på projektet og skal vide, hvad systemet er, hvad der er i gang, og hvorfor koden ser ud, som den gør.
- **Beslutning:** Kortet, status, historikken, arkitekturen og beslutningerne står i fem filer i `docs/` efter `~/docs/projects`. Backlog-punkter og beslutninger har faste ID'er, som commits nævner.
- **Begrundelse:** Status i git følger projektet til alle maskiner, kortet sparer søgninger, og ID'erne gør det muligt at gå fra kode til begrundelse.
- **Fravalgt:** Status i `CLAUDE.md`, hvor den bliver forældet og indlæses hver gang, og i Claudes hukommelse, som kun findes på én maskine.
- **Konsekvenser:** Hver arbejdsgang slutter med en opdateret backlog og et logindlæg, og `check.mjs` kører før commit.

## ADR-002 · Egen telefonserver og egen protokol i stedet for scrcpy-serveren
- **Dato og status:** 2026-11-14 · Accepteret (commit cf60291)
- **Kontekst:** Appen brugte scrcpy-serveren på telefonen.
- **Beslutning:** En Java-server uden biblioteker, startet med `app_process`, og en egen versioneret protokol (docs/PROTOCOL.md) med testvektorer, som både Java- og Rust-testene tjekker (`protocol/vectors.txt`).
- **Begrundelse:** Protokollen er vores egen og testes i begge ender, og serveren kan stilles til lav forsinkelse (ADR-003).
- **Fravalgt:** At beholde scrcpy-serveren. Commit-beskeden nævner ikke andre grunde end dem ovenfor.
- **Konsekvenser:** De skjulte Android-API'er er vores at vedligeholde; de ligger i tre filer med fallback. En protokolændring rører dokumentationen, vektorerne og begge ender i samme commit.

## ADR-003 · Ingen B-frames, og decoderen får at vide, at der ingen reordering er
- **Dato og status:** 2026-11-14 · Accepteret (commit cf60291)
- **Kontekst:** En decoder, der venter på reordering, holder billeder tilbage.
- **Beslutning:** Serveren slår B-frames fra, og appen skriver SPS om, så decoderen viser hvert billede med det samme (`src-tauri/src/h264.rs`).
- **Begrundelse:** På en rigtig tablet kom første billede efter 1,3 s i stedet for 5,9 s.
- **Fravalgt:** Encoderens standard med B-frames.
- **Konsekvenser:** Reglen står i `CLAUDE.md`, og en ændring af encoderen skal holde B-frames slået fra.

## ADR-004 · Lyden sendes som ukomprimeret PCM
- **Dato og status:** 2026-11-15 · Accepteret (commit c5117c2)
- **Kontekst:** Enhedens lyd skal spille på pc'en i synk med billedet.
- **Beslutning:** Serveren fanger det, enheden spiller (REMOTE_SUBMIX), som 48 kHz stereo PCM og sender det i protokol version 3; appen afspiller det med Web Audio på billedets ur.
- **Begrundelse:** Ukomprimeret PCM koster under 2 Mbit/s over USB og giver ingen kodningsforsinkelse.
- **Fravalgt:** Komprimeret lyd, som ville give kodningsforsinkelse.
- **Konsekvenser:** Lyd kræver Android 12 eller nyere, og enheden er tavs, mens lyden fanges.
