# Decisions: stormcast

Architecture decisions (ADR, PRJ-06): one per decision that is expensive to change, newest last. An ADR is not edited afterwards. A new ADR replaces it, and the old one gets the status "Superseded by ADR-…". ADR-002 to ADR-004 were written down on 2026-11-15 from the commit messages and the documentation; reasons that were not stated there are not guessed.

## ADR-001 · The project is kept traceable with projects
- **Date and status:** 2026-11-15 · Accepted
- **Context:** Several sessions, often on several machines, work on the project and need to know what the system is, what is in progress and why the code looks the way it does.
- **Decision:** The map, status, history, architecture and decisions live in five files in `docs/` following `~/docs/projects`. Backlog items and decisions have fixed IDs that commits mention.
- **Rationale:** Status in git follows the project to every machine, the map saves searches, and the IDs make it possible to go from code to reason.
- **Rejected:** Status in `CLAUDE.md`, where it goes stale and is loaded every time, and in Claude's memory, which exists on one machine only.
- **Consequences:** Every stretch of work ends with an updated backlog and a log entry, and `check.mjs` runs before commit.

## ADR-002 · Our own phone server and protocol instead of the scrcpy server
- **Date and status:** 2026-11-14 · Accepted (commit cf60291)
- **Context:** The app used the scrcpy server on the phone.
- **Decision:** A Java server without libraries, started with `app_process`, and our own versioned protocol (docs/PROTOCOL.md) with test vectors that both the Java and the Rust tests check (`protocol/vectors.txt`).
- **Rationale:** The protocol is our own and tested on both sides, and the server can be tuned for low latency (ADR-003).
- **Rejected:** Keeping the scrcpy server. The commit message gives no reasons beyond those above.
- **Consequences:** The hidden Android APIs are ours to maintain; they live in three files with a fallback. A protocol change touches the documentation, the vectors and both sides in the same commit.

## ADR-003 · No B-frames, and the decoder is told there is no reordering
- **Date and status:** 2026-11-14 · Accepted (commit cf60291)
- **Context:** A decoder that waits for reordering holds frames back.
- **Decision:** The server turns B-frames off, and the app rewrites the SPS so the decoder shows every frame at once (`src-tauri/src/h264.rs`).
- **Rationale:** On a real tablet the first frame came after 1.3 s instead of 5.9 s.
- **Rejected:** The encoder's default with B-frames.
- **Consequences:** The rule is in `CLAUDE.md`, and a change to the encoder must keep B-frames off.

## ADR-004 · Sound is sent as uncompressed PCM
- **Date and status:** 2026-11-15 · Accepted (commit c5117c2)
- **Context:** The device's sound must play on the PC in sync with the picture.
- **Decision:** The server captures what the device plays (REMOTE_SUBMIX) as 48 kHz stereo PCM and sends it in protocol version 3; the app plays it with Web Audio on the picture's clock.
- **Rationale:** Uncompressed PCM costs less than 2 Mbit/s over USB and adds no encoding delay.
- **Rejected:** Compressed sound, which would add encoding delay.
- **Consequences:** Sound needs Android 12 or newer, and the device is silent while its sound is captured.
