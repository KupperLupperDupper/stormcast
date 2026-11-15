# Stormcast

Windows-app, der spejler en Android-skærm over USB. Kortet over projektet, kommandoerne og fælderne står i `docs/BRAIN.md`, som importeres herunder; status står i `docs/BACKLOG.md` og `docs/LOG.md`.

@~/docs/ui-rulebook/RULEBOOK.md
Følg projects: @~/docs/projects/PROJECTS.md
@docs/BRAIN.md

## Regler
- En protokolændring ændrer `docs/PROTOCOL.md`, `protocol/vectors.txt`, Java og Rust i samme commit, og testene i begge ender skal være grønne.
- Nye skjulte Android-kald hører til i `DisplayCapture.java`, `InputInjector.java` eller `AudioCapture.java` og skal have en fallback.
- Serveren slår aldrig B-frames til. Appen fortæller decoderen, at der ingen reordering er (`h264.rs`), ellers holder decoderen billeder tilbage.
- App-ID og Java-pakke er `com.stormitron.stormcast`; udgiveren er Stormitron.
- Telefonbilledet må aldrig ligge under glas eller andre lag.
- Release: skriv versionens afsnit i `CHANGELOG.md` til brugerne (release-noterne kommer derfra), og tagget `vX.Y.Z` skal matche `version` i `package.json`.
