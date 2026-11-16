# Backlog: stormcast

The queue across sessions (PRJ-04): one table per lane (swimlane), and every item has a fixed ID (PRJ-03). Lanes are areas or milestones. An item says when it is done.

- **Status:** Idea · Next · Doing (session or branch) · Waiting (on what) · Done (date)
- **Rules:** set an item to "Doing" with the session's name before work starts, and at most one per session. Do not touch items another session is doing. The commit message names the ID. Done items move to Archive when they are a month old.
- **Next ID:** B-015

## Lane: Project
| ID | Item | Status | Note |
|---|---|---|---|
| B-001 | Fill in docs/BRAIN.md so a new session finds its way without searching | Done (2026-11-15) | The map and the commands moved from `CLAUDE.md` |
| B-002 | Describe the system in docs/ARCHITECTURE.md as built | Done (2026-11-15) | From the README, PROTOCOL.md, `CLAUDE.md` and the commit messages |

## Lane: Mirroring
| ID | Item | Status | Note |
|---|---|---|---|
| B-003 | Full-screen view of the phone picture | Done (2026-11-16) | A toggle and F11; Windows full screen without the sidebar, the toolbar stays above the picture. Checked at 1920 × 1080 and by hand |
| B-004 | Wireless connection without a USB cable | Idea | The README calls it planned |
| B-007 | Show several devices at once | Done (2026-11-16) | One session per serial in Rust and one `MirrorSession` per device in the web UI; "Show all" puts them side by side. Checked with a OnePlus and a Lenovo at once |
| B-008 | Diagnostics about the device | Done (2026-11-16) | Sidebar "Device details" while mirroring, read with one `adb shell` every 10 s and tested against a OnePlus (Android 14) and a Lenovo (Android 16), plus the stream's own numbers |
| B-011 | Fit the device picture to the app's view as well as possible | Done (2026-11-16) | Done when the picture fills as much of the view as it can without cropping or distortion, at every window size, rotation and scaling. Goes with B-003 |
| B-012 | Unlock the device from the PC with its PIN or password | Done (2026-11-16) | Protocol: device state (10) and unlock (23). The toolbar asks for the code only while the device is locked with one; the server wakes, swipes up and types it as key presses. Unlocked a OnePlus LE2123 (Android 14) from a screen that was off |

## Lane: UI
| ID | Item | Status | Note |
|---|---|---|---|
| B-009 | Separate the devices into tabs | Done (2026-11-16) | A tab per mirrored device (ARIA tabs); the sound on the PC follows the device in use |
| B-010 | Better button layout | Next | Follow the UI rulebook (CMP-02: at least 24 px with a mouse). Part of B-014 |
| B-014 | UI overhaul | Next | A review of the whole UI against the UI rulebook, done together with B-010 and with B-009's tabs in mind |

## Lane: Release
| ID | Item | Status | Note |
|---|---|---|---|
| B-005 | Release 0.2.0 with the sound listed under Unreleased in `CHANGELOG.md` | Idea | The tag must match `version` in `package.json` |
| B-006 | Code-sign the installer and zip so SmartScreen does not warn | Idea | Known issue in 0.1.0 |
| B-013 | Fix the security findings before the next release (DEP-02, DEP-03, pinned adb, SEC-05, SEC-06) | Done (2026-11-15) | `--locked` in CI and release, a dependency audit job, platform-tools 37.0.1 checked against a committed SHA-256, deny rules in `.claude/settings.json`. `/security-review` found nothing |

## Archive
| ID | Item | Status | Note |
|---|---|---|---|
