# Log: stormcast

What happened, why and what is next (PRJ-05). Newest first, one entry per stretch of work and at most about 10 lines. Only what git does not show; name IDs from the backlog and the decisions and the commits concerned. If work stops before the queue is empty, the entry is the handover (PRM-02).

## 2026-11-15 · Security findings fixed before release
- **Done:** B-013. Profiles checked: baseline, packages (npm, Cargo), CI, apps. Not applicable: web and API, login and data, AI.
- **Not checked:** gitleaks is not installed, so SEC-01 was checked by regex only. cargo audit first runs in CI, on the new "Dependency audit" job.
- **Why:** releases used to ship whatever adb the runner's ANDROID_HOME had; now they always use the pinned, verified download.
- **Next:** B-005 when a release is wanted.

## 2026-11-15 · Documentation in English, new backlog items
- **Done:** B-007 to B-010 added to the backlog (multi-device view, device diagnostics, tabs per device, better button layout). All documentation translated to English, including the backlog keywords.
- **Why:** the project is public and its UI is in English, so its documentation is too.
- **Next:** your choice between B-005, B-003 and B-004.

## 2026-11-15 · Projects set up
- **Done:** B-001 and B-002. The map and the commands moved from `CLAUDE.md` to docs/BRAIN.md as a table from task to place; the rules stayed in `CLAUDE.md`. ARCHITECTURE.md and ADR-002 to ADR-004 were written afterwards from the README, PROTOCOL.md and the commit messages.
- **Why:** ADR-001.
- **Status:** 0.1.0 is released, and sound is under Unreleased (B-005). The branches `claude/device-audio-b3fbf5` and `claude/fullscreen-view-10afda` point to the same commit as main.
- **Next:** your choice between B-005, B-003 and B-004.
