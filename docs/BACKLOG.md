# Backlog: stormcast

The queue across sessions (PRJ-04): one table per lane (swimlane), and every item has a fixed ID (PRJ-03). Lanes are areas or milestones. An item says when it is done.

- **Status:** Idea · Next · Doing (session or branch) · Waiting (on what) · Done (date)
- **Rules:** set an item to "Doing" with the session's name before work starts, and at most one per session. Do not touch items another session is doing. The commit message names the ID. Done items move to Archive when they are a month old.
- **Next ID:** B-012

## Lane: Project
| ID | Item | Status | Note |
|---|---|---|---|
| B-001 | Fill in docs/BRAIN.md so a new session finds its way without searching | Done (2026-11-15) | The map and the commands moved from `CLAUDE.md` |
| B-002 | Describe the system in docs/ARCHITECTURE.md as built | Done (2026-11-15) | From the README, PROTOCOL.md, `CLAUDE.md` and the commit messages |

## Lane: Mirroring
| ID | Item | Status | Note |
|---|---|---|---|
| B-003 | Full-screen view of the phone picture | Idea | The branch `claude/fullscreen-view-10afda` exists but has no commits of its own |
| B-004 | Wireless connection without a USB cable | Idea | The README calls it planned |
| B-007 | Show several devices at once | Idea | Done when two connected devices are mirrored and controlled at the same time |
| B-008 | Diagnostics about the device | Idea | For example model, Android version, resolution, battery and connection state |
| B-011 | Fit the device picture to the app's view as well as possible | Idea | Done when the picture fills as much of the view as it can without cropping or distortion, at every window size, rotation and scaling. Goes with B-003 |

## Lane: UI
| ID | Item | Status | Note |
|---|---|---|---|
| B-009 | Separate the devices into tabs | Idea | Goes with B-007 |
| B-010 | Better button layout | Idea | Follow the UI rulebook (CMP-02: at least 24 px with a mouse) |

## Lane: Release
| ID | Item | Status | Note |
|---|---|---|---|
| B-005 | Release 0.2.0 with the sound listed under Unreleased in `CHANGELOG.md` | Idea | The tag must match `version` in `package.json` |
| B-006 | Code-sign the installer and zip so SmartScreen does not warn | Idea | Known issue in 0.1.0 |

## Archive
| ID | Item | Status | Note |
|---|---|---|---|
