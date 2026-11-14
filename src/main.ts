import "./styles/tokens.css";
import "./styles/app.css";
import { h } from "./dom";
import {
  asAppError,
  getStartup,
  listDevices,
  smokeReport,
  startMirror,
  stopMirror,
  type AppError,
  type Device,
  type Startup,
} from "./ipc";
import { MirrorPlayer } from "./player";
import { text } from "./strings";

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
const SMOKE_MIRROR_MS = 8000;
const SMOKE_TIMEOUT_MS = 45000;

const deviceList = byId("device-list");
const stage = byId("stage");
const announcer = byId("announcer");

let startup: Startup | null = null;
let devices: Device[] = [];
let renderedDevices = "";
let view: View = { kind: "searching" };
let player: MirrorPlayer | null = null;
let session = 0;
let statusText: HTMLElement | null = null;
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
  const canvas = h("canvas", { class: "screen__video", role: "img", "aria-label": text.screenLabel });
  const current = new MirrorPlayer(canvas, {
    hello: (deviceName) => {
      if (id !== session) return;
      setView({ kind: "mirroring", serial, deviceName });
      announce(text.announceMirroring(deviceName));
    },
    end: (error) => {
      if (id !== session) return;
      failSession(serial, error);
    },
  });
  player = current;
  setView({ kind: "connecting", serial });
  window.setTimeout(() => {
    // PAT-02: a long wait explains itself. The hint already has its space, so nothing
    // moves (LAY-02) and focus stays where it is (A11Y-09).
    if (id !== session || view.kind !== "connecting") return;
    stage.querySelector(".connect-hint")?.classList.remove("is-invisible");
    announce(text.connectingSlow);
  }, SLOW_CONNECT_MS);
  try {
    await startMirror(serial, (packet) => {
      if (id === session) current.handle(packet);
    });
  } catch (e) {
    if (id === session) failSession(serial, asAppError(e));
  }
}

function failSession(serial: string, error: AppError) {
  session++;
  player?.close();
  player = null;
  statusText = null;
  setView({ kind: "error", serial, error });
  announce(text.error(error.code).title);
  if (smoke === "running") void finishSmoke(error);
}

async function disconnect(showPicker = true) {
  const wasActive = player !== null;
  session++;
  player?.close();
  player = null;
  statusText = null;
  if (wasActive) await stopMirror().catch((e) => console.warn("Stopping failed", e));
  if (showPicker) {
    setView(devices.length === 0 ? { kind: "no-device" } : { kind: "pick" });
    if (wasActive) announce(text.announceStopped);
  }
}

// ---------- Stage ----------

function renderStage() {
  const hadFocus = stage.contains(document.activeElement);
  statusText = null;
  stage.replaceChildren(stageContent());
  if (hadFocus) {
    // A11Y-09: the focused element is gone, so move focus on purpose.
    (stage.querySelector<HTMLElement>(".button--primary") ?? stage.querySelector<HTMLElement>("#stage-title"))?.focus();
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
      button(text.stop, () => void disconnect()),
    ),
    // The mirrored screen never sits under glass or any other layer.
    h("div", { class: "screen" }, player?.canvas ?? null),
  );
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

window.setInterval(() => {
  if (!player || !statusText) return;
  const stats = player.stats();
  statusText.textContent = stats.width > 0 ? text.status(stats.width, stats.height, stats.fps) : "";
}, 1000);

// ---------- Smoke test (STORMCAST_SMOKE=1) ----------

function smokeStep() {
  if (smoke !== "waiting") return;
  const ready = devices.find((device) => device.state === "device");
  if (!ready) return;
  smoke = "running";
  void connect(ready.serial);
  window.setTimeout(() => void finishSmoke(), SMOKE_MIRROR_MS);
}

async function finishSmoke(error?: AppError) {
  if (smoke === "done" || smoke === "off") return;
  smoke = "done";
  const stats = player?.stats() ?? null;
  const ok = !error && stats !== null && stats.framesDecoded > 0 && stats.decoderErrors === 0;
  await smokeReport({ ok, error: error ?? null, stats, view: view.kind, appearance: startup?.appearance ?? null });
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
    window.setTimeout(
      () => void finishSmoke({ code: "smoke_timeout", detail: "no result within the time limit" }),
      SMOKE_TIMEOUT_MS,
    );
  }
  renderStage();
  void poll();
}

void main();
