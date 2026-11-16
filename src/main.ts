import "./styles/tokens.css";
import "./styles/app.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AudioState } from "./audio";
import { facts } from "./details";
import { h } from "./dom";
import { icon } from "./icons";
import {
  asAppError,
  deviceInfo,
  getStartup,
  listDevices,
  smokeReport,
  type AppError,
  type Device,
  type DeviceInfo,
  type Startup,
} from "./ipc";
import { actions, button, details, message, MirrorSession, type SessionHost } from "./session";
import { text } from "./strings";
import { hideTooltip, withTooltip } from "./tooltip";

/** What the stage shows while no device is mirrored. */
type Notice =
  | { kind: "searching" }
  | { kind: "no-adb"; detail: string }
  | { kind: "no-device" }
  | { kind: "pick" }
  | { kind: "error"; serial: string; error: AppError };

/** B-007: one device at a time in tabs, or every mirrored device side by side. */
type Layout = "tabs" | "all";

const POLL_INTERVAL_MS = 1500;
const SMOKE_FIRST_FRAME_MS = 20000;
const SMOKE_SETTLE_MS = 1500;
const SMOKE_INPUT_MS = 3000;
const SMOKE_RESTORE_MS = 1500;
const SMOKE_TIMEOUT_MS = 45000;
/** The server plays its test tone about a second after capture starts. */
const SMOKE_TONE_MS = 5000;
/** A peak this loud is sound; silence from the device is exactly 0. */
const SMOKE_TONE_LEVEL = 0.01;
const SMOKE_TOGGLE_MS = 3000;
/** Sound may be this far ahead of the picture or behind it (ITU-R BT.1359, detectability). */
const SYNC_AHEAD_MS = 45;
const SYNC_BEHIND_MS = 125;
const SOUND_KEY = "stormcast.soundOnPc";
const LAYOUT_KEY = "stormcast.layout";
/** B-008: how often the device details are read again while mirroring. */
const DETAILS_INTERVAL_MS = 10000;

const deviceList = byId("device-list");
const stage = byId("stage");
const announcer = byId("announcer");
const detailsSection = byId("device-details");
const factList = byId("device-facts");

let startup: Startup | null = null;
let devices: Device[] = [];
let renderedDevices = "";
let notice: Notice = { kind: "searching" };
/** B-007: the mirrored devices by serial, in the order they were opened. */
const sessions = new Map<string, MirrorSession>();
/** The session in use: its tab is selected, and it has the sound on the PC. */
let active: string | null = null;
let layout: Layout = loadSetting(LAYOUT_KEY) === "all" ? "all" : "tabs";
/** Play the sound of the device in use on this PC; remembered between sessions. */
let soundOnPc = loadSetting(SOUND_KEY) !== "0";
/** B-003: the window is in full screen, without the sidebar. */
let fullScreen = false;
/** B-008: details read with adb, by serial, and the timer that reads the active device's. */
const deviceDetails = new Map<string, DeviceInfo>();
let detailsTimer = 0;
let renderedFacts = "";
let smoke: "off" | "waiting" | "running" | "done" = "off";

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from index.html`);
  return element;
}

const label = (device: Device) => device.model ?? device.serial;
const findDevice = (serial?: string) => devices.find((device) => device.serial === serial);
const activeSession = () => (active === null ? undefined : sessions.get(active));

/** Screen reader announcement without moving focus (A11Y-04). */
function announce(message: string) {
  announcer.textContent = "";
  window.setTimeout(() => (announcer.textContent = message), 50);
}

const host: SessionHost = {
  changed: () => {
    renderStage();
    renderDevices();
  },
  used: (session) => setActive(session.serial, false),
  close: (session) => closeSession(session.serial),
  retry: (session) => void openSession(session.serial),
  setSound: (session, on) => {
    soundOnPc = on;
    // The smoke test toggles too, but never changes what the user chose.
    if (smoke === "off") saveSetting(SOUND_KEY, on ? "1" : "0");
    if (on) setActive(session.serial, false);
    updateSound();
  },
  announce: (session, message) => {
    if (session.serial === active) announce(message);
  },
  label: (serial) => {
    const device = findDevice(serial);
    return device ? label(device) : serial;
  },
};

// ---------- Devices ----------

/** Renders the device list if it changed, and keeps focus on the same device (A11Y-09). */
function renderDevices(): boolean {
  const key = JSON.stringify([devices, [...sessions.keys()], active]);
  if (key === renderedDevices) return false;
  renderedDevices = key;
  const focused = deviceList.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.serial
    : undefined;
  deviceList.replaceChildren(...devices.map(deviceItem));
  if (focused) deviceList.querySelector<HTMLElement>(`[data-serial="${CSS.escape(focused)}"]`)?.focus();
  return true;
}

function deviceItem(device: Device): HTMLElement {
  const mirrored = sessions.has(device.serial);
  const tone = mirrored ? "active" : device.state === "device" ? "ready" : "attention";
  return h(
    "li",
    {},
    h(
      "button",
      {
        class: "device",
        type: "button",
        "data-serial": device.serial,
        "aria-current": device.serial === active ? "true" : undefined,
        onclick: () => activateDevice(device),
      },
      h("span", { class: "device__name" }, label(device)),
      h("span", { class: `chip chip--${tone}` }, mirrored ? text.mirroringNow : text.deviceState(device.state)),
      h("span", { class: "device__meta" }, device.serial),
    ),
  );
}

/** A mirrored device comes to the front; a ready one starts mirroring next to the others. */
function activateDevice(device: Device) {
  if (sessions.has(device.serial)) {
    setActive(device.serial, true);
    return;
  }
  if (device.state === "device") {
    void openSession(device.serial);
    return;
  }
  const code = device.state === "unauthorized" ? "device_unauthorized" : "device_offline";
  const error = { code, detail: `adb state: ${device.state}` };
  if (sessions.size === 0) {
    notice = { kind: "error", serial: device.serial, error };
    renderStage();
  }
  announce(text.error(code).title);
}

async function poll() {
  try {
    devices = await listDevices();
    const listChanged = renderDevices();
    if (sessions.size === 0 && notice.kind !== "error") {
      const next: Notice = devices.length === 0 ? { kind: "no-device" } : { kind: "pick" };
      if (next.kind !== notice.kind || listChanged) {
        notice = next;
        renderStage();
      }
    }
    smokeStep();
  } catch (e) {
    const error = asAppError(e);
    if (error.code === "adb_not_found") {
      devices = [];
      renderDevices();
      if (sessions.size === 0) {
        notice = { kind: "no-adb", detail: error.detail };
        renderStage();
      }
    } else {
      // Transient: the next poll tries again (PAT-03).
      console.warn("Listing devices failed", error);
    }
  } finally {
    window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }
}

// ---------- Sessions (B-007) ----------

/** Starts mirroring the device, in place of a session it had, and brings it to the front. */
async function openSession(serial: string) {
  sessions.get(serial)?.close();
  const session = new MirrorSession(serial, host, false);
  sessions.set(serial, session);
  if (notice.kind === "error") notice = { kind: "pick" };
  // The new device is the one in use, so it gets the sound before its server starts.
  setActive(serial, true);
  await session.start();
}

/** Stops mirroring the device, or closes the pane of a session that ended. */
function closeSession(serial: string) {
  const session = sessions.get(serial);
  if (!session) return;
  const order = [...sessions.keys()];
  const index = order.indexOf(serial);
  const hadFocus = session.element.contains(document.activeElement);
  session.close();
  sessions.delete(serial);
  deviceDetails.delete(serial);
  announce(text.announceStopped);
  if (sessions.size === 0) {
    active = null;
    // Full screen belongs to mirroring; the device list must be back when it ends.
    void setFullScreen(false);
    notice = devices.length === 0 ? { kind: "no-device" } : { kind: "pick" };
    renderStage();
    renderDevices();
    restartDetails();
    if (hadFocus) stage.querySelector<HTMLElement>(".message__title")?.focus();
    return;
  }
  if (active === serial) {
    // The next tab, or the one before when it was the last (A11Y-09).
    const next = [...sessions.keys()][Math.min(index, sessions.size - 1)];
    setActive(next, true, hadFocus);
  } else {
    renderStage();
    renderDevices();
  }
}

/**
 * Makes the session the one in use: its tab is selected and its sound plays on the PC. From the
 * tabs or the device list it comes to the front; from a click in its pane only the sound moves.
 */
function setActive(serial: string, bringToFront: boolean, focus = false) {
  if (!sessions.has(serial)) return;
  const changed = serial !== active;
  active = serial;
  updateSound();
  if (changed || bringToFront) {
    // Side by side, every pane is already shown: moving one would drop its touch, which may just
    // have started there, so only the tab bar and the highlight change.
    if (layout === "tabs") renderStage();
    else renderChrome();
    renderDevices();
    restartDetails();
  }
  if (focus) activeSession()?.focusScreen();
}

/** The tab bar and which pane is in use, without moving the panes. */
function renderChrome() {
  const bar = stage.querySelector(".tab-bar");
  if (!bar) return;
  const hadFocus = bar.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : null;
  bar.replaceWith(tabBar([...sessions.values()]));
  for (const session of sessions.values()) paneFor(session);
  if (hadFocus) document.getElementById(hadFocus)?.focus();
}

/** Only the session in use plays its sound on the PC; the others give it back to their device. */
function updateSound() {
  for (const session of sessions.values()) session.setSoundOnPc(soundOnPc && session.serial === active);
}

// ---------- Stage ----------

function renderStage() {
  const hadFocus = stage.contains(document.activeElement) ? document.activeElement : null;
  hideTooltip();
  stage.replaceChildren(sessions.size === 0 ? noticeContent() : mirrorsContent());
  if (!hadFocus) return;
  if (hadFocus.isConnected) {
    // Moving a pane in the page drops its focus; give it back.
    (hadFocus as HTMLElement).focus({ preventScroll: true });
    return;
  }
  // A11Y-09: the focused element is gone, so move focus on purpose.
  (
    stage.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    stage.querySelector<HTMLElement>(".button--primary") ??
    stage.querySelector<HTMLElement>(".message__title")
  )?.focus();
}

function noticeContent(): Node {
  switch (notice.kind) {
    case "searching":
      return message("stage-title", text.searching, []);
    case "no-adb":
      return message("stage-title", text.error("adb_not_found").title, [
        h("p", {}, text.error("adb_not_found").body),
        h("p", {}, h("code", { class: "code" }, text.adbInstallCommand)),
        details(notice.detail),
      ]);
    case "no-device":
      return message("stage-title", text.noDevice.title, [
        h("ol", { class: "steps" }, ...text.noDevice.steps.map((step) => h("li", {}, step))),
      ]);
    case "pick": {
      const ready = devices.filter((device) => device.state === "device");
      const only = ready.length === 1 ? ready[0] : undefined;
      return message("stage-title", text.pick.title, [
        h("p", {}, only ? text.pick.one(label(only)) : text.pick.many),
        only ? actions(button(text.mirror, () => void openSession(only.serial), "primary")) : null,
      ]);
    }
    case "error": {
      const copy = text.error(notice.error.code);
      return message("stage-title", copy.title, [
        h("p", {}, copy.body),
        notice.error.detail ? details(notice.error.detail) : null,
      ]);
    }
  }
}

/** The tab bar, then the device in front (tabs) or every device side by side (all). */
function mirrorsContent(): Node {
  const list = [...sessions.values()];
  const shown = layout === "all" ? list : list.filter((session) => session.serial === active);
  return h(
    "div",
    { class: `mirrors mirrors--${layout}` },
    tabBar(list),
    h("div", { class: "mirrors__panes" }, ...shown.map((session) => paneFor(session))),
  );
}

function paneFor(session: MirrorSession): HTMLElement {
  const pane = session.element;
  pane.classList.toggle("pane--active", layout === "all" && session.serial === active);
  if (layout === "tabs") {
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", session.id("tab"));
  } else {
    pane.removeAttribute("role");
    pane.removeAttribute("aria-labelledby");
  }
  return pane;
}

/**
 * The mirrored devices as tabs (ARIA tabs: arrow keys move between them, A11Y-03), and the
 * layout and full screen toggles. In the side by side layout every pane is shown, so the tabs are
 * plain buttons that pick the device in use.
 */
function tabBar(list: MirrorSession[]): HTMLElement {
  const tabs = layout === "tabs";
  const items = list.map((session) => {
    const selected = session.serial === active;
    const state = session.phase === "connecting" ? text.tabConnecting : session.phase === "ended" ? text.tabEnded : null;
    return h(
      "button",
      {
        class: "tab",
        type: "button",
        id: session.id("tab"),
        role: tabs ? "tab" : undefined,
        "aria-selected": tabs ? String(selected) : undefined,
        "aria-controls": tabs && selected ? session.id("pane") : undefined,
        "aria-pressed": tabs ? undefined : String(selected),
        tabindex: tabs && !selected ? "-1" : undefined,
        onclick: () => setActive(session.serial, true),
        onkeydown: (event: Event) => tabKey(event as KeyboardEvent, list, session),
      },
      h("span", { class: "tab__name" }, session.title),
      state ? h("span", { class: "tab__state" }, state) : null,
    );
  });
  return h(
    "div",
    { class: "tab-bar panel" },
    h(
      "div",
      tabs
        ? { class: "tab-list", role: "tablist", "aria-label": text.tabsLabel }
        : { class: "tab-list", role: "group", "aria-label": text.tabsLabel },
      ...items,
    ),
    h("div", { class: "tab-bar__tools" }, layoutToggle(), fullScreenToggle()),
  );
}

/** Arrow keys, Home and End move between the tabs and select them (ARIA tabs pattern). */
function tabKey(event: KeyboardEvent, list: MirrorSession[], session: MirrorSession) {
  if (layout !== "tabs") return;
  const index = list.indexOf(session);
  const target =
    event.key === "ArrowRight"
      ? list[(index + 1) % list.length]
      : event.key === "ArrowLeft"
        ? list[(index - 1 + list.length) % list.length]
        : event.key === "Home"
          ? list[0]
          : event.key === "End"
            ? list[list.length - 1]
            : undefined;
  if (!target) return;
  event.preventDefault();
  setActive(target.serial, true);
  document.getElementById(target.id("tab"))?.focus();
}

/** "Show all": every mirrored device side by side. A toggle with a fixed name (CMP-15). */
function layoutToggle() {
  return withTooltip(
    h(
      "button",
      {
        class: "button button--secondary button--icon",
        type: "button",
        "aria-label": text.showAll,
        "aria-pressed": String(layout === "all"),
        "data-tooltip": text.showAllTooltip,
        onclick: () => {
          layout = layout === "all" ? "tabs" : "all";
          saveSetting(LAYOUT_KEY, layout);
          renderStage();
          announce(layout === "all" ? text.announceShowAll : text.announceTabs);
        },
      },
      icon("showAll"),
    ),
  );
}

// ---------- Full screen (B-003) ----------

/**
 * Full screen, a toggle with a fixed name and aria-pressed; the icon shows the state too
 * (CMP-15). F11 does the same. The tab bar and toolbars stay above the pictures, so nothing lies
 * on them.
 */
function fullScreenToggle() {
  return withTooltip(
    h(
      "button",
      {
        class: "button button--secondary button--icon",
        type: "button",
        "aria-label": text.fullScreen,
        "aria-pressed": String(fullScreen),
        "aria-keyshortcuts": "F11",
        "data-tooltip": text.fullScreenTooltip,
        onmousedown: (event: Event) => event.preventDefault(),
        onclick: () => void setFullScreen(!fullScreen),
      },
      icon(fullScreen ? "exitFullScreen" : "fullScreen"),
    ),
  );
}

function renderFullScreen() {
  document.documentElement.toggleAttribute("data-full-screen", fullScreen);
  if (sessions.size > 0) renderStage();
}

async function setFullScreen(on: boolean) {
  if (on === fullScreen) return;
  fullScreen = on;
  renderFullScreen();
  announce(on ? text.announceFullScreen : text.announceWindowed);
  try {
    await getCurrentWindow().setFullscreen(on);
  } catch (e) {
    console.warn("Could not change full screen", e);
  }
}

/** Follows the window when Windows leaves full screen some other way. */
async function syncFullScreen() {
  try {
    const actual = await getCurrentWindow().isFullscreen();
    if (actual !== fullScreen) {
      fullScreen = actual;
      renderFullScreen();
    }
  } catch {
    // Not in Tauri, for example in a plain browser: nothing to follow.
  }
}

window.addEventListener("resize", () => void syncFullScreen());
// F11 works while mirroring, and always leaves full screen. The screens do not pass it on.
window.addEventListener("keydown", (event) => {
  if (event.key !== "F11" || event.repeat) return;
  if (sessions.size === 0 && !fullScreen) return;
  event.preventDefault();
  void setFullScreen(!fullScreen);
});

// ---------- Status and device details (B-008) ----------

function tick() {
  for (const session of sessions.values()) session.updateStatus();
  renderDetails();
}

window.setInterval(tick, 1000);

/** Reads the details of the device in use now and every few seconds. */
function restartDetails() {
  window.clearInterval(detailsTimer);
  const serial = active;
  renderDetails();
  if (serial === null) return;
  const load = async () => {
    try {
      const info = await deviceInfo(serial);
      if (!sessions.has(serial)) return;
      deviceDetails.set(serial, info);
      renderDetails();
    } catch (e) {
      // The next read tries again; the stream's own numbers still show (PAT-03).
      console.warn("Reading the device details failed", e);
    }
  };
  void load();
  detailsTimer = window.setInterval(() => void load(), DETAILS_INTERVAL_MS);
}

/** Shows the details of the device in use; rebuilt only when a value changed. */
function renderDetails() {
  const session = activeSession();
  const rows = session
    ? facts(session.serial, deviceDetails.get(session.serial) ?? null, session.phase === "mirroring" ? session.player.stats() : null)
    : [];
  const key = JSON.stringify(rows);
  if (key === renderedFacts) return;
  renderedFacts = key;
  detailsSection.hidden = rows.length === 0;
  factList.replaceChildren(...rows.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]));
}

function loadSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; it still applies now.
  }
}

// ---------- Smoke test (STORMCAST_SMOKE=1) ----------

interface SmokeAudio {
  state: AudioState;
  /** The device's test tone reached the PC. */
  heard: boolean;
  /** Sound and picture within ITU-R BT.1359's limits. */
  inSync: boolean;
  /** The speaker button stopped the device's capture and started it again. */
  toggled: boolean;
}

interface SmokeInput {
  /** The picture changed after Recent apps: the server got the input and injected it. */
  applied: boolean;
  /** From sending the input to the first changed picture on screen. */
  latencyMs: number | null;
}

function smokeStep() {
  if (smoke !== "waiting") return;
  const ready = devices.find((device) => device.state === "device");
  if (!ready) return;
  smoke = "running";
  void runSmoke(ready.serial);
}

/** Mirrors the first ready device, opens Recent apps until the picture changes, and goes Back. */
async function runSmoke(serial: string) {
  void openSession(serial);
  const session = () => sessions.get(serial);
  const framed = await waitUntil(() => (session()?.player.stats().framesDecoded ?? 0) > 0, SMOKE_FIRST_FRAME_MS);
  if (!framed) {
    const ended = session()?.error;
    return finishSmoke(ended ?? { code: "no_frames", detail: "no frame was decoded" });
  }
  await sleep(SMOKE_SETTLE_MS);
  const current = session();
  if (smoke !== "running" || !current) return;
  const changed = current.player.waitForChange(SMOKE_INPUT_MS);
  const sentAt = performance.now();
  current.control.button("recentApps");
  const changedAt = await changed;
  current.control.button("back");
  await sleep(SMOKE_RESTORE_MS);
  const input = { applied: changedAt !== null, latencyMs: changedAt === null ? null : Math.round(changedAt - sentAt) };
  await waitUntil(() => {
    const audio = session()?.player.audio.stats();
    return audio === undefined || audio.peak >= SMOKE_TONE_LEVEL || audio.state === "unsupported";
  }, SMOKE_TONE_MS);
  const audio = smokeAudio(current);
  if (audio && audio.state === "playing") audio.toggled = await smokeToggleSound(current);
  await finishSmoke(undefined, input, audio);
}

function smokeAudio(session: MirrorSession): SmokeAudio {
  const stats = session.player.stats();
  const offset = stats.avOffsetMs;
  return {
    state: stats.audio.state,
    heard: stats.audio.peak >= SMOKE_TONE_LEVEL,
    inSync: offset !== null && offset >= -SYNC_AHEAD_MS && offset <= SYNC_BEHIND_MS,
    toggled: false,
  };
}

/** Turns sound off and on as the speaker button does: the device must stop capture, then play again. */
async function smokeToggleSound(session: MirrorSession): Promise<boolean> {
  const audio = session.player.audio;
  const stops = audio.stats().stops;
  host.setSound(session, false);
  const stopped = await waitUntil(() => audio.stats().stops > stops, SMOKE_TOGGLE_MS);
  host.setSound(session, true);
  const playing = await waitUntil(() => audio.current === "playing", SMOKE_TOGGLE_MS);
  return stopped && playing;
}

async function finishSmoke(error?: AppError, input?: SmokeInput, audio?: SmokeAudio) {
  if (smoke === "done" || smoke === "off") return;
  smoke = "done";
  const session = activeSession();
  const stats = session?.player.stats() ?? null;
  // A device older than Android 12 passes without sound: it says so instead.
  const soundOk =
    audio !== undefined && (audio.state === "unsupported" || (audio.heard && audio.inSync && audio.toggled));
  const ok =
    !error &&
    stats !== null &&
    stats.framesDecoded > 0 &&
    stats.decoderErrors === 0 &&
    input?.applied === true &&
    soundOk;
  await smokeReport({
    ok,
    error: error ?? null,
    stats,
    input: input ?? null,
    audio: audio ?? null,
    view: session?.phase ?? notice.kind,
    sessions: sessions.size,
    appearance: startup?.appearance ?? null,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > end) return false;
    await sleep(100);
  }
  return true;
}

// ---------- Start ----------

async function main() {
  byId("brand-name").textContent = text.appName;
  byId("brand-tagline").textContent = text.tagline;
  byId("devices-heading").textContent = text.devicesHeading;
  byId("details-heading").textContent = text.deviceDetails.heading;
  try {
    startup = await getStartup();
  } catch (e) {
    console.error("Could not read the startup settings", e);
  }
  document.documentElement.dataset.skin = startup?.appearance.skin ?? "solid";
  if (startup?.smoke) {
    smoke = "waiting";
    // The smoke test listens for the device's sound, whatever was chosen before.
    soundOnPc = true;
    window.setTimeout(
      () => void finishSmoke({ code: "smoke_timeout", detail: "no result within the time limit" }),
      SMOKE_TIMEOUT_MS,
    );
  }
  renderStage();
  void poll();
}

void main();
