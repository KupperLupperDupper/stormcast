import "./styles/tokens.css";
import "./styles/app.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AudioPlayer, type AudioState } from "./audio";
import { DeviceControl } from "./control";
import { h } from "./dom";
import { icon } from "./icons";
import {
  asAppError,
  getStartup,
  listDevices,
  smokeReport,
  startMirror,
  stopMirror,
  type AppError,
  type Device,
  type DeviceButton,
  type Startup,
} from "./ipc";
import { MirrorPlayer } from "./player";
import { text } from "./strings";
import { hideTooltip, withTooltip } from "./tooltip";

type View =
  | { kind: "searching" }
  | { kind: "no-adb"; detail: string }
  | { kind: "no-device" }
  | { kind: "pick" }
  | { kind: "connecting"; serial: string }
  | { kind: "mirroring"; serial: string; deviceName: string }
  | { kind: "error"; serial?: string; error: AppError };

const POLL_INTERVAL_MS = 1500;
const SLOW_CONNECT_MS = 4000;
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
// Device state flags from the server (B-012); bit 0, screen on, is not needed here.
const STATE_LOCKED = 2;
const STATE_NEEDS_CODE = 4;
/** After an unlock with a code, this long until a device that is still locked counts as a wrong code. */
const UNLOCK_CHECK_MS = 4000;

const deviceList = byId("device-list");
const stage = byId("stage");
const announcer = byId("announcer");

let startup: Startup | null = null;
let devices: Device[] = [];
let renderedDevices = "";
let view: View = { kind: "searching" };
let player: MirrorPlayer | null = null;
let control: DeviceControl | null = null;
let session = 0;
let statusText: HTMLElement | null = null;
let soundButton: HTMLButtonElement | null = null;
/** The device's lock state, or null while it is unknown (B-012). */
let deviceState: number | null = null;
let lockRow: HTMLFormElement | null = null;
let unlockCheck = 0;
/** B-003: the window is in full screen, without the sidebar. */
let fullScreen = false;
let fullScreenButton: HTMLButtonElement | null = null;
/** Play the device's sound on this PC; remembered between sessions. */
let soundOnPc = loadSoundSetting();
let smoke: "off" | "waiting" | "running" | "done" = "off";

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from index.html`);
  return element;
}

const label = (device: Device) => device.model ?? device.serial;
const findDevice = (serial?: string) => devices.find((device) => device.serial === serial);
const activeSerial = () => (view.kind === "connecting" || view.kind === "mirroring" ? view.serial : undefined);
const isIdle = (v: View) => v.kind === "searching" || v.kind === "no-adb" || v.kind === "no-device" || v.kind === "pick";

/** Screen reader announcement without moving focus (A11Y-04). */
function announce(message: string) {
  announcer.textContent = "";
  window.setTimeout(() => (announcer.textContent = message), 50);
}

function setView(next: View) {
  if (JSON.stringify(next) === JSON.stringify(view)) return;
  view = next;
  renderStage();
  renderDevices();
}

// ---------- Devices ----------

/** Renders the device list if it changed, and keeps focus on the same device (A11Y-09). */
function renderDevices(): boolean {
  const key = JSON.stringify([devices, activeSerial()]);
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
  const active = device.serial === activeSerial();
  const tone = active ? "active" : device.state === "device" ? "ready" : "attention";
  return h(
    "li",
    {},
    h(
      "button",
      {
        class: "device",
        type: "button",
        "data-serial": device.serial,
        "aria-current": active ? "true" : undefined,
        onclick: () => activateDevice(device),
      },
      h("span", { class: "device__name" }, label(device)),
      h("span", { class: `chip chip--${tone}` }, active ? text.mirroringNow : text.deviceState(device.state)),
      h("span", { class: "device__meta" }, device.serial),
    ),
  );
}

function activateDevice(device: Device) {
  if (device.serial === activeSerial()) return;
  if (device.state === "device") {
    void connect(device.serial);
    return;
  }
  const code = device.state === "unauthorized" ? "device_unauthorized" : "device_offline";
  setView({ kind: "error", serial: device.serial, error: { code, detail: `adb state: ${device.state}` } });
}

async function poll() {
  try {
    devices = await listDevices();
    const listChanged = renderDevices();
    if (isIdle(view)) {
      const next: View = devices.length === 0 ? { kind: "no-device" } : { kind: "pick" };
      if (next.kind !== view.kind) setView(next);
      else if (listChanged) renderStage();
    }
    smokeStep();
  } catch (e) {
    const error = asAppError(e);
    if (error.code === "adb_not_found") {
      devices = [];
      renderDevices();
      if (view.kind !== "connecting" && view.kind !== "mirroring") setView({ kind: "no-adb", detail: error.detail });
    } else {
      // Transient: the next poll tries again (PAT-03).
      console.warn("Listing devices failed", error);
    }
  } finally {
    window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }
}

// ---------- Mirroring ----------

async function connect(serial: string) {
  await disconnect(false);
  const id = ++session;
  const canvas = h("canvas", {
    class: "screen__video",
    // While the screen has focus, the keyboard controls the device; Tab leaves it (A11Y-03).
    tabindex: "0",
    role: "application",
    "aria-label": text.screenLabel,
    "aria-describedby": "control-hint-active",
  });
  const audio = new AudioPlayer(soundOnPc, (state) => {
    if (id === session) soundChanged(state);
  });
  const current = new MirrorPlayer(
    canvas,
    {
      hello: (deviceName) => {
        if (id !== session) return;
        setView({ kind: "mirroring", serial, deviceName });
        announce(text.announceMirroring(deviceName));
      },
      end: (error) => {
        if (id !== session) return;
        failSession(serial, error);
      },
      deviceState: (flags) => {
        if (id !== session) return;
        deviceState = flags;
        renderLock();
      },
    },
    audio,
  );
  player = current;
  control = new DeviceControl(canvas);
  setView({ kind: "connecting", serial });
  window.setTimeout(() => {
    // PAT-02: a long wait explains itself. The hint already has its space, so nothing
    // moves (LAY-02) and focus stays where it is (A11Y-09).
    if (id !== session || view.kind !== "connecting") return;
    stage.querySelector(".connect-hint")?.classList.remove("is-invisible");
    announce(text.connectingSlow);
  }, SLOW_CONNECT_MS);
  try {
    await startMirror(serial, soundOnPc, (packet) => {
      if (id === session) current.handle(packet);
    });
  } catch (e) {
    if (id === session) failSession(serial, asAppError(e));
  }
}

function endSession() {
  session++;
  player?.close();
  player = null;
  control?.close();
  control = null;
  statusText = null;
  soundButton = null;
  deviceState = null;
  lockRow = null;
  window.clearTimeout(unlockCheck);
  fullScreenButton = null;
  // Full screen belongs to mirroring; the device list must be back when it ends.
  void setFullScreen(false);
}

function failSession(serial: string, error: AppError) {
  endSession();
  setView({ kind: "error", serial, error });
  announce(text.error(error.code).title);
  if (smoke === "running") void finishSmoke(error);
}

async function disconnect(showPicker = true) {
  const wasActive = player !== null;
  endSession();
  if (wasActive) await stopMirror().catch((e) => console.warn("Stopping failed", e));
  if (showPicker) {
    setView(devices.length === 0 ? { kind: "no-device" } : { kind: "pick" });
    if (wasActive) announce(text.announceStopped);
  }
}

// ---------- Stage ----------

function renderStage() {
  const hadFocus = stage.contains(document.activeElement);
  hideTooltip();
  statusText = null;
  soundButton = null;
  lockRow = null;
  fullScreenButton = null;
  stage.replaceChildren(stageContent());
  renderLock();
  if (hadFocus) {
    // A11Y-09: the focused element is gone, so move focus on purpose. When mirroring starts,
    // that is the screen, ready for the keyboard.
    (
      stage.querySelector<HTMLElement>(".button--primary") ??
      stage.querySelector<HTMLElement>(".screen__video") ??
      stage.querySelector<HTMLElement>("#stage-title")
    )?.focus();
  }
}

function stageContent(): Node {
  switch (view.kind) {
    case "searching":
      return message(text.searching, []);
    case "no-adb":
      return message(text.error("adb_not_found").title, [
        h("p", {}, text.error("adb_not_found").body),
        h("p", {}, h("code", { class: "code" }, text.adbInstallCommand)),
        details(view.detail),
      ]);
    case "no-device":
      return message(text.noDevice.title, [
        h("ol", { class: "steps" }, ...text.noDevice.steps.map((step) => h("li", {}, step))),
      ]);
    case "pick": {
      const ready = devices.filter((device) => device.state === "device");
      const only = ready.length === 1 ? ready[0] : undefined;
      return message(text.pick.title, [
        h("p", {}, only ? text.pick.one(label(only)) : text.pick.many),
        only ? actions(button(text.mirror, () => void connect(only.serial), "primary")) : null,
      ]);
    }
    case "connecting": {
      const device = findDevice(view.serial);
      const title = text.connecting(device ? label(device) : view.serial);
      return message(
        title,
        [
          h("div", { class: "progress", role: "progressbar", "aria-label": title }),
          h("p", { class: "text-muted connect-hint is-invisible" }, text.connectingSlow),
          actions(button(text.cancel, () => void disconnect())),
        ],
        true,
      );
    }
    case "mirroring":
      return mirrorView(view.deviceName);
    case "error": {
      const copy = text.error(view.error.code);
      const device = findDevice(view.serial);
      return message(copy.title, [
        h("p", {}, copy.body),
        view.error.code === "adb_not_found" ? h("p", {}, h("code", { class: "code" }, text.adbInstallCommand)) : null,
        device?.state === "device" ? actions(button(text.tryAgain, () => void connect(device.serial), "primary")) : null,
        view.error.detail ? details(view.error.detail) : null,
      ]);
    }
  }
}

function mirrorView(deviceName: string): Node {
  statusText = h("span", { class: "toolbar__status" });
  return h(
    "div",
    { class: "mirror" },
    h(
      "div",
      { class: "toolbar panel" },
      h("span", { class: "toolbar__title" }, deviceName),
      statusText,
      h(
        "div",
        { class: "toolbar__group", role: "group", "aria-label": text.deviceButtons },
        deviceButton(text.back, "back"),
        deviceButton(text.home, "home"),
        deviceButton(text.recentApps, "recentApps"),
        deviceButton(text.power, "power"),
      ),
      soundToggle(),
      fullScreenToggle(),
      button(text.stop, () => void disconnect()),
      // Says whether the keyboard goes to the device. Both lines keep their space, so
      // switching moves nothing (LAY-02).
      h(
        "p",
        { class: "control-hint" },
        h("span", { class: "control-hint__idle" }, text.controlHint),
        h("span", { class: "control-hint__active", id: "control-hint-active" }, text.controlHintActive),
      ),
      lockForm(),
    ),
    // The mirrored screen never sits under glass or any other layer.
    h("div", { class: "screen" }, player?.canvas ?? null),
  );
}

/**
 * B-012: one compact row with a field for the device's code, shown only while the device is
 * locked with a code. The mirror shows such a lock screen black, so this is where the code goes;
 * a lock without a code shows in the mirror and needs only Power and a swipe. The field is
 * cleared at once, and the code is never stored.
 */
function lockForm(): HTMLFormElement {
  lockRow = h(
    "form",
    { class: "lock", hidden: true, onsubmit: submitUnlock },
    h("label", { class: "text-label", for: "unlock-code" }, text.lock.codeLabel),
    h("input", {
      class: "field",
      id: "unlock-code",
      name: "unlock-code",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      autocapitalize: "off",
      "aria-describedby": "lock-note",
    }),
    h("button", { class: "button button--primary", type: "submit" }, text.lock.unlock),
    h("p", { class: "lock__note", id: "lock-note", role: "status" }),
  );
  return lockRow;
}

function renderLock() {
  const row = lockRow;
  if (!row) return;
  const flags = deviceState ?? 0;
  const show = (flags & STATE_LOCKED) !== 0 && (flags & STATE_NEEDS_CODE) !== 0;
  const input = row.querySelector<HTMLInputElement>("#unlock-code");
  if (!show) {
    window.clearTimeout(unlockCheck);
    const hadFocus = row.contains(document.activeElement);
    row.hidden = true;
    if (input) input.value = "";
    setLockNote("");
    // A11Y-09: the focused field is gone, so the screen takes over, ready for the keyboard.
    if (hadFocus) player?.canvas.focus({ preventScroll: true });
    return;
  }
  if (!row.hidden) return;
  row.hidden = false;
  announce(text.lock.announce);
  // The field is the clear place for the code; take focus only from the screen or nowhere.
  const active = document.activeElement;
  if (active === document.body || active === player?.canvas) input?.focus();
}

function setLockNote(note: string) {
  const element = lockRow?.querySelector<HTMLElement>(".lock__note");
  if (element) element.textContent = note;
}

function submitUnlock(event: Event) {
  event.preventDefault();
  const input = lockRow?.querySelector<HTMLInputElement>("#unlock-code");
  const code = input?.value ?? "";
  if (input) input.value = "";
  setLockNote("");
  control?.unlock(code);
  window.clearTimeout(unlockCheck);
  if (!code) return;
  unlockCheck = window.setTimeout(() => {
    if (deviceState === null || (deviceState & STATE_LOCKED) === 0) return;
    setLockNote(text.lock.stillLocked);
    input?.focus();
  }, UNLOCK_CHECK_MS);
}

/**
 * A device button with Android's own symbol; the name is in aria-label and the tooltip (CMP-14).
 * A mouse click leaves focus on the screen, so typing can go on.
 */
function deviceButton(label: string, which: DeviceButton) {
  return withTooltip(
    h(
      "button",
      {
        class: "button button--secondary button--icon",
        type: "button",
        "aria-label": label,
        onmousedown: (event: Event) => event.preventDefault(),
        onclick: () => control?.button(which),
      },
      icon(which),
    ),
  );
}

/**
 * Plays the device's sound on this PC, or gives it back to the device. A toggle with a fixed name
 * and aria-pressed; the icon shows the state too (COL-03). A mouse click leaves focus on the screen.
 */
function soundToggle() {
  soundButton = withTooltip(
    h("button", {
      class: "button button--secondary button--icon",
      type: "button",
      onmousedown: (event: Event) => event.preventDefault(),
      onclick: toggleSound,
    }),
  );
  renderSound();
  return soundButton;
}

function renderSound() {
  if (!soundButton) return;
  const unsupported = player?.audio.current === "unsupported";
  const on = soundOnPc && !unsupported;
  soundButton.setAttribute("aria-pressed", String(on));
  soundButton.setAttribute("aria-label", unsupported ? text.soundUnsupportedLabel : text.soundOnPc);
  if (unsupported) soundButton.setAttribute("aria-disabled", "true");
  else soundButton.removeAttribute("aria-disabled");
  soundButton.replaceChildren(icon(on ? "soundOn" : "soundOff"));
}

function toggleSound() {
  if (!player) return;
  if (player.audio.current === "unsupported") {
    announce(text.soundUnsupportedLabel);
    return;
  }
  soundOnPc = !soundOnPc;
  // The smoke test toggles too, but never changes what the user chose.
  if (smoke === "off") saveSoundSetting(soundOnPc);
  player.audio.setEnabled(soundOnPc);
  control?.audio(soundOnPc);
  renderSound();
}

/**
 * B-003: full screen, a toggle with a fixed name and aria-pressed; the icon shows the state too
 * (CMP-15). F11 does the same. The toolbar stays above the picture, so nothing lies on it.
 */
function fullScreenToggle() {
  fullScreenButton = withTooltip(
    h("button", {
      class: "button button--secondary button--icon",
      type: "button",
      "aria-label": text.fullScreen,
      "aria-keyshortcuts": "F11",
      "data-tooltip": text.fullScreenTooltip,
      onmousedown: (event: Event) => event.preventDefault(),
      onclick: () => void setFullScreen(!fullScreen),
    }),
  );
  renderFullScreen();
  return fullScreenButton;
}

function renderFullScreen() {
  document.documentElement.toggleAttribute("data-full-screen", fullScreen);
  if (!fullScreenButton) return;
  fullScreenButton.setAttribute("aria-pressed", String(fullScreen));
  fullScreenButton.replaceChildren(icon(fullScreen ? "exitFullScreen" : "fullScreen"));
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
// F11 works while mirroring, and always leaves full screen. The screen does not pass it on.
window.addEventListener("keydown", (event) => {
  if (event.key !== "F11" || event.repeat) return;
  if (view.kind !== "mirroring" && !fullScreen) return;
  event.preventDefault();
  void setFullScreen(!fullScreen);
});

function soundChanged(state: AudioState) {
  renderSound();
  updateStatus();
  const note = text.soundNote(state);
  if (note) announce(note);
}

function loadSoundSetting(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveSoundSetting(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    // Not remembered; it still applies to this session.
  }
}

function message(title: string, body: Array<Node | null>, busy = false): Node {
  return h(
    "section",
    { class: "message panel", "aria-labelledby": "stage-title", "aria-busy": busy ? "true" : undefined },
    h("h2", { class: "message__title", id: "stage-title", tabindex: "-1" }, title),
    ...body,
  );
}

const actions = (...buttons: Node[]) => h("div", { class: "actions" }, ...buttons);

function button(label: string, onClick: () => void, variant: "primary" | "secondary" = "secondary") {
  return h("button", { class: `button button--${variant}`, type: "button", onclick: onClick }, label);
}

function details(detail: string): Node {
  return h("details", { class: "details" }, h("summary", {}, text.details), h("pre", {}, detail));
}

/** Size and frame rate, and why there is no sound, when there is none. */
function updateStatus() {
  if (!player || !statusText) return;
  const stats = player.stats();
  const parts = [
    stats.width > 0 ? text.status(stats.width, stats.height, stats.fps) : null,
    text.soundNote(stats.audio.state),
  ];
  statusText.textContent = parts.filter((part) => part !== null).join(" · ");
}

window.setInterval(updateStatus, 1000);

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
  void connect(serial);
  const framed = await waitUntil(() => (player?.stats().framesDecoded ?? 0) > 0, SMOKE_FIRST_FRAME_MS);
  if (!framed) return finishSmoke({ code: "no_frames", detail: "no frame was decoded" });
  await sleep(SMOKE_SETTLE_MS);
  const current = player;
  const device = control;
  if (smoke !== "running" || !current || !device) return;
  const changed = current.waitForChange(SMOKE_INPUT_MS);
  const sentAt = performance.now();
  device.button("recentApps");
  const changedAt = await changed;
  device.button("back");
  await sleep(SMOKE_RESTORE_MS);
  const input = { applied: changedAt !== null, latencyMs: changedAt === null ? null : Math.round(changedAt - sentAt) };
  await waitUntil(() => {
    const audio = player?.audio.stats();
    return audio === undefined || audio.peak >= SMOKE_TONE_LEVEL || audio.state === "unsupported";
  }, SMOKE_TONE_MS);
  const audio = smokeAudio();
  if (audio && audio.state === "playing") audio.toggled = await smokeToggleSound();
  await finishSmoke(undefined, input, audio);
}

function smokeAudio(): SmokeAudio | undefined {
  const stats = player?.stats();
  if (!stats) return undefined;
  const offset = stats.avOffsetMs;
  return {
    state: stats.audio.state,
    heard: stats.audio.peak >= SMOKE_TONE_LEVEL,
    inSync: offset !== null && offset >= -SYNC_AHEAD_MS && offset <= SYNC_BEHIND_MS,
    toggled: false,
  };
}

/** Turns sound off and on as the speaker button does: the device must stop capture, then play again. */
async function smokeToggleSound(): Promise<boolean> {
  const audio = player?.audio;
  if (!audio) return false;
  const stops = audio.stats().stops;
  toggleSound();
  const stopped = await waitUntil(() => audio.stats().stops > stops, SMOKE_TOGGLE_MS);
  toggleSound();
  const playing = await waitUntil(() => audio.current === "playing", SMOKE_TOGGLE_MS);
  return stopped && playing;
}

async function finishSmoke(error?: AppError, input?: SmokeInput, audio?: SmokeAudio) {
  if (smoke === "done" || smoke === "off") return;
  smoke = "done";
  const stats = player?.stats() ?? null;
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
    view: view.kind,
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
