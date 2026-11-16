# Design brief: Stormcast

The project's choices: style, tokens, tone and deliberate deviations. The rules are in the UI rulebook and are not repeated here.

- **Rulebook version:** 1.1.2 (`~/docs/ui-rulebook`)
- **Last updated:** 15.11.2026

## Users and context
- People who want to see or show their Android screen on a Windows PC: developers, testers, teachers and presenters. Sessions from a few minutes to hours.
- Screens: laptop and desktop PC from 1366 × 768 to 4K and 100–200 % scaling. The window is often small, next to other windows.
- Input: mouse and keyboard, and touch on Windows tablets and 2-in-1s.
- Language: English UI, because the project is public. All text is in `src/strings.ts`.

## Style (STY-02)
- **Primary style:** Glassmorphism, built on the Fluent material Acrylic (Windows 11, build 22621+).
- **Fallback skin:** Fluent solid (Flat 2.0) on Windows 10, and when transparency effects are turned off. Same layout, components and rules; only the tokens change (STY-01).
- **Why:** The wish is a modern glass look, and Windows 11 has it as a system material. Glass suits navigation and control surfaces around media (the style catalogue), and the phone picture is media.
- **The style's risks and how we handle them:**
  - Contrast varies with the background → panels with text have 62 % fill, and contrast is measured by hand over a white and a black desktop.
  - Text → always sits on a panel, never directly on the glass.
  - Glass on glass → never. Blur comes only from the window's acrylic; the panels have no blur of their own.
  - "Reduce transparency" → the solid skin. The Windows setting is read at start.
  - High contrast → system colours via `forced-colors`.
  - The phone picture never sits under glass or any other layer.

## Tokens
- **Source:** `src/styles/tokens.css`. Layer 1 is primitives, layer 2 semantic roles and layer 3 components; the UI uses only layers 2 and 3 (TOK-02).
- **Generation and test for stale files:** no generation; the file is the only source. `npm run check:contrast` reads it directly.

| Role | Light | Dark | Contrast |
|---|---|---|---|
| text on background | #1b1b1b on #f3f3f3 | #ffffff on #202020 | 15.5:1 / 16.3:1 |
| muted text on surface | #5d5d5d on #fbfbfb | #c5c5c5 on #2b2b2b | 6.4:1 / 8.2:1 |
| accent as fill + on-accent | #ffffff on #005fb8 | #000000 on #60cdff | 6.3:1 / 11.7:1 |
| danger | #c42b1c on #fbfbfb | #ff99a4 on #2b2b2b | 5.5:1 / 7.0:1 |

The numbers apply to the solid skin and are checked by `npm run check:contrast` in CI (QA-02). The glass panels are semi-transparent and are checked by hand.

- **Typography:** Segoe UI Variable (Text and Display) with Segoe UI as fallback. Fluent's scale: caption 12/16, body 14/20, subtitle 20/28, title 28/36. Cascadia Mono for commands and technical details.
- **Motion personality:** crisp. Hover and press at 100 ms with ease-out; no bounce (MOT-03, MOT-08). The progress bar is the only loop, and it stands still with reduced motion.

## Tone
Short sentences without exclamation marks. Buttons say the action: "Mirror screen", "Stop mirroring", "Try again". Errors say what happened and what to do now.

## Special requirements
- The phone picture fills as much of its space as it can, scaled up or down with its aspect ratio kept, never cropped or distorted, and nothing lies on top of it (B-011). The canvas box is exactly the picture, so pointer positions map straight onto it.
- Buttons are 40 px high with a 48 px hit area (CMP-02).
- Low latency: hardware decoding, and the newest frame wins.
- Sound: the device's sound plays on the PC as uncompressed PCM, with only a few blocks scheduled ahead. The sound may be at most about 45 ms ahead of the picture and 125 ms behind (ITU-R BT.1359, the detectability threshold), and the smoke test measures it from both sides' PTS on the device's clock. The picture never waits for the sound, so control stays fast.
- The sound button "Sound on this PC" is a toggle button with a fixed name and `aria-pressed`. The speaker icon with waves or a cross shows the state, so colour is not the only cue (COL-03). Turned off, the device plays its sound itself again, and the choice is remembered. Before Android 12 the button is `aria-disabled`; it can still take focus, so the tooltip says why, and the status bar says the same in text.
- Control: mouse, touch and pen become touch on the device, the wheel scroll and the keyboard keys and text, while the screen has focus. Focus is shown with an accent ring around the picture and a hint saying that Tab leaves the screen, so the keyboard is never trapped (A11Y-03, WCAG 2.1.2). Tab, Ctrl zoom and Alt+F4 stay in the app.
- Input is sent at once and in order, without debounce (PERF-05). The screen passes every finger on, so the device itself decides pinches and other gestures; GES-05's "ignore extra fingers" applies to our own gestures, and the screen has none.
- Back, Home, Recent apps and Power are icon buttons in the toolbar with Android's own symbols (GES-06). The name is in `aria-label` and in a tooltip on hover and keyboard focus (CMP-14, A11Y-05). The tooltip has a solid surface, so it is never glass on glass, and it never covers the phone picture. "Stop mirroring" is text, because it is Stormcast's own action, and a stop icon would look like Recent apps.
- Clipboard: what is copied on the device lands in the PC's clipboard by itself, and Ctrl+V on the screen pastes the PC's text on the device. Text only, and the content is never logged.
- Device details (B-008): a "Device details" section in the sidebar while mirroring, as a list of terms and values in caption type: device, Android and security patch, screen, battery, memory, storage, uptime, connection, video and sound. Values the device does not report are left out, numbers follow the locale (TXT-04), and the list is rebuilt only when a value changes.
- Full screen (B-003): a toggle "Full screen" with a fixed name, `aria-pressed` and the corners icon pointing out or in (CMP-15), and F11 does the same; the tooltip says "Full screen (F11)". The window goes to Windows full screen without the sidebar, and the toolbar stays as a row above the picture, so nothing lies on it. F11 is never passed to the device, so the keyboard is never trapped (A11Y-10). The button follows the window when Windows leaves full screen some other way, and mirroring that ends leaves full screen, so the device list is back.
- Locked device (B-012): a lock screen with a code shows black in the mirror, so the toolbar gets one extra row, "Device locked: PIN or password", with a password field and Unlock. Only while the device is locked with a code; a lock without a code shows in the mirror. The row is part of the toolbar, never on the picture. The field takes focus when it appears, if focus was on the screen or nowhere, is cleared on submit, and the code is never stored or logged. A device still locked four seconds later gets an error line in text (CMP-07), which also says that a pattern must be drawn on the device.
- Right-click is Back, as with a mouse on Android itself (GES-07). A mouse click on the device buttons does not move focus away from the screen, so you can keep typing.

## Deviations (KIT-04)

| Rule | Deviation | Reason | Date |
|---|---|---|---|
| TOK-01 | The breakpoint `40rem` is in `app.css` | CSS does not allow custom properties in media queries | 14.11.2026 |

## Checks in the project (QA-02)
- CI (`.github/workflows/ci.yml`): typecheck and build, contrast check, `cargo fmt`, `clippy` and Rust tests.
- Real device (QA-04): the smoke test with `STORMCAST_SMOKE=1` mirrors the first ready device, counts decoded frames, presses Recent apps and Back and measures the time from input to a new frame. It also makes the device play a test tone, requires the tone to reach the PC and the sound to be within the sync limits.
- By hand for now: the glass panels' contrast over a white and a black desktop, screen reader (A11Y-08) and 200 % zoom (TYP-02).
