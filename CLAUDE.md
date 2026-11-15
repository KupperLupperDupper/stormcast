# Stormcast

Windows app that mirrors an Android screen over USB. The project map, the commands and the pitfalls are in `docs/BRAIN.md`, imported below; status is in `docs/BACKLOG.md` and `docs/LOG.md`. All documentation is in English.

@~/docs/ui-rulebook/RULEBOOK.md
Follow projects: @~/docs/projects/PROJECTS.md
@docs/BRAIN.md

## Rules
- A protocol change changes `docs/PROTOCOL.md`, `protocol/vectors.txt`, Java and Rust in the same commit, and the tests on both sides must pass.
- New hidden Android calls belong in `DisplayCapture.java`, `InputInjector.java` or `AudioCapture.java` and must have a fallback.
- The server never turns B-frames on. The app tells the decoder there is no reordering (`h264.rs`); otherwise the decoder holds frames back.
- The app ID and Java package are `com.stormitron.stormcast`; the publisher is Stormitron.
- The phone picture must never sit under glass or any other layer.
- Release: write the version's section in `CHANGELOG.md` for users (the release notes come from there), and the tag `vX.Y.Z` must match `version` in `package.json`.
