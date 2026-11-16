# Log: stormcast

What happened, why and what is next (PRJ-05). Newest first, one entry per stretch of work and at most about 10 lines. Only what git does not show; name IDs from the backlog and the decisions and the commits concerned. If work stops before the queue is empty, the entry is the handover (PRM-02).

## 2026-11-16 · Device details, several devices, UI overhaul
- **Done:** B-008 (device details from one `adb shell`), B-007 and B-009 (one session per device; tabs and "Show all"), B-010 and B-014 (one card per device with a nav bar like the phone's, quiet buttons, pill tabs, radius scale 4/8/12/16/full).
- **Why the redesign:** the first B-014 (a button rail beside the screen) gave more room on paper but was rejected as clunky, busy and boxy; the user picked the phone-like nav bar from three sketches, then asked for rounder shapes. Room for a phone at 1120 × 760: 18 % in tabs (as before), 17 % side by side (was 13 %).
- **Not checked:** axe-core (no local copy, and a remote script was not allowed), a screen reader, and screenshots of the real window (the review used an IPC mock in the browser pane, which could not draw while Claude's window was hidden).
- **Next:** B-005, now with all of this in Unreleased.

## 2026-11-16 · Full screen, repo cleaned
- **Done:** B-003. Full screen hides the sidebar and keeps the toolbar as a row above the picture, because the picture must never lie under other layers. F11 stays in the app (`keepsForApp`). The window needs `core:window:allow-set-fullscreen` and `allow-is-fullscreen`.
- **Cleaned:** the merged branches and the two old worktrees are gone; only main is left.
- **Next:** B-005 (0.2.0 now has sound, unlock, the fitted picture and full screen), or B-014 with B-010.

## 2026-11-16 · Picture fits the view, unlock from the PC
- **Done:** B-011 (the picture fills the view, also above its own size) and B-012 (lock state and unlock with a code, protocol types 10 and 23).
- **Why:** a lock screen with a code is black in the mirror (non-secure display on Android 12+), so the user could not see where to type.
- **Found on the device:** `dismissKeyguard` opened OnePlus' fingerprint prompt, whose "Enter password" button must be pressed before keys reach the code entry; a swipe up opens the entry itself, also 0.2 s after waking. The server now swipes and keeps `dismissKeyguard` as the fallback.
- **Not checked:** a password with letters, a pattern lock (the row says to draw it on the device), and lock screens of other makers.
- **Next:** B-005, or B-003 on top of B-011.

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
