/**
 * One mirrored device (B-007): its stream, its control, and its card with the header, the lock
 * row, the screen and Android's nav bar. Several run at once; the app (main.ts) shows them in tabs or side by
 * side and gives the sound on the PC to the one in use. The pane is built once and moved, never
 * rebuilt, so the canvas and what is typed in the lock field survive a change of layout.
 */
import { AudioPlayer, type AudioState } from "./audio";
import { DeviceControl } from "./control";
import { h } from "./dom";
import { icon } from "./icons";
import { asAppError, startMirror, stopMirror, type AppError, type DeviceButton } from "./ipc";
import { MirrorPlayer } from "./player";
import { text } from "./strings";
import { withTooltip } from "./tooltip";

const SLOW_CONNECT_MS = 4000;
// Device state flags from the server (B-012); bit 0, screen on, is not needed here.
const STATE_LOCKED = 2;
const STATE_NEEDS_CODE = 4;
/** After an unlock with a code, this long until a device that is still locked counts as a wrong code. */
const UNLOCK_CHECK_MS = 4000;

export type Phase = "connecting" | "mirroring" | "ended";

/** What a session needs from the app. */
export interface SessionHost {
  /** The session's name, phase or error changed: the tabs and the device list show them. */
  changed(session: MirrorSession): void;
  /** The pointer or focus went into the session's pane: it is the one in use now. */
  used(session: MirrorSession): void;
  /** Stop mirroring, or close the pane of a session that ended. */
  close(session: MirrorSession): void;
  /** Try again after an error: the app starts a new session for the device. */
  retry(session: MirrorSession): void;
  /** Turns the sound on the PC on or off, for this session. */
  setSound(session: MirrorSession, on: boolean): void;
  /** Says it to the screen reader, if the session is the one in use. */
  announce(session: MirrorSession, message: string): void;
  /** The device's name from adb, for the time before the device says hello. */
  label(serial: string): string;
}

export class MirrorSession {
  private static count = 0;

  readonly serial: string;
  /** The pane: a message while connecting or after an error, else the device's card. */
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly player: MirrorPlayer;
  readonly control: DeviceControl;
  name: string | null = null;
  phase: Phase = "connecting";
  error: AppError | null = null;
  /** Whether this device's sound plays on the PC. Only the session in use has it. */
  soundOnPc: boolean;

  private readonly host: SessionHost;
  /** Element ids must be unique while several panes are on the page. */
  private readonly uid = ++MirrorSession.count;
  private statusText: HTMLElement | null = null;
  private soundButton: HTMLButtonElement | null = null;
  private lockRow: HTMLFormElement | null = null;
  /** The device's lock state, or null while it is unknown (B-012). */
  private deviceState: number | null = null;
  private unlockCheck = 0;
  private slowTimer = 0;
  private closed = false;

  constructor(serial: string, host: SessionHost, soundOnPc: boolean) {
    this.serial = serial;
    this.host = host;
    this.soundOnPc = soundOnPc;
    this.element = h("section", { class: "pane", id: this.id("pane") });
    this.canvas = h("canvas", {
      class: "screen__video",
      // While the screen has focus, the keyboard controls the device; Tab leaves it (A11Y-03).
      tabindex: "0",
      role: "application",
      "aria-label": text.screenLabel,
      "aria-describedby": this.id("hint"),
    });
    const audio = new AudioPlayer(soundOnPc, (state) => this.soundChanged(state));
    this.player = new MirrorPlayer(
      this.canvas,
      {
        hello: (deviceName) => this.hello(deviceName),
        end: (error) => this.end(error),
        deviceState: (flags) => {
          this.deviceState = flags;
          this.renderLock();
        },
      },
      audio,
    );
    this.control = new DeviceControl(this.canvas, this.serial);
    // The pane in use gets the sound and the tab, whether it is reached by pointer or keyboard.
    this.element.addEventListener("pointerdown", () => this.host.used(this));
    this.element.addEventListener("focusin", () => this.host.used(this));
    this.render();
  }

  /** The name to show: the device's own, adb's model, or the serial. */
  get title(): string {
    return this.name ?? this.host.label(this.serial);
  }

  /** Element id for one of this pane's parts. */
  id(part: string): string {
    return `${part}-${this.uid}`;
  }

  /** Connects and streams until the device ends it or close is called. */
  async start(): Promise<void> {
    this.slowTimer = window.setTimeout(() => {
      // PAT-02: a long wait explains itself. The hint already has its space, so nothing
      // moves (LAY-02) and focus stays where it is (A11Y-09).
      if (this.phase !== "connecting") return;
      this.element.querySelector(".connect-hint")?.classList.remove("is-invisible");
      this.host.announce(this, text.connectingSlow);
    }, SLOW_CONNECT_MS);
    try {
      await startMirror(this.serial, this.soundOnPc, (packet) => {
        if (!this.closed) this.player.handle(packet);
      });
    } catch (e) {
      this.end(asAppError(e));
    }
  }

  /** Stops everything; the pane is no longer used. */
  close(): void {
    if (this.closed) return;
    const wasRunning = this.phase !== "ended";
    this.closed = true;
    window.clearTimeout(this.slowTimer);
    window.clearTimeout(this.unlockCheck);
    this.player.close();
    this.control.close();
    if (wasRunning) void stopMirror(this.serial).catch((e) => console.warn("Stopping failed", e));
  }

  /** Gives this device's sound to the PC, or back to the device. */
  setSoundOnPc(on: boolean): void {
    if (on === this.soundOnPc || this.closed) return;
    this.soundOnPc = on;
    this.player.audio.setEnabled(on);
    this.control.audio(on);
    this.renderSound();
  }

  focusScreen(): void {
    if (this.phase === "mirroring") this.canvas.focus({ preventScroll: true });
  }

  /**
   * Why there is no sound, when there is none. Size and frame rate are in the device details
   * (B-008), so the card's header stays short (B-014).
   */
  updateStatus(): void {
    if (!this.statusText) return;
    const note = this.soundOnPc ? text.soundNote(this.player.stats().audio.state) : null;
    this.statusText.textContent = note ?? "";
  }

  private hello(deviceName: string) {
    if (this.closed) return;
    window.clearTimeout(this.slowTimer);
    this.name = deviceName;
    this.phase = "mirroring";
    this.render();
    this.host.changed(this);
    this.host.announce(this, text.announceMirroring(deviceName));
  }

  private end(error: AppError) {
    if (this.closed || this.phase === "ended") return;
    window.clearTimeout(this.slowTimer);
    window.clearTimeout(this.unlockCheck);
    this.phase = "ended";
    this.error = error;
    this.player.close();
    this.control.close();
    const hadFocus = this.element.contains(document.activeElement);
    this.render();
    // A11Y-09: the screen is gone, so focus goes to the message that says why.
    if (hadFocus) this.element.querySelector<HTMLElement>(".message__title")?.focus();
    this.host.changed(this);
    this.host.announce(this, text.error(error.code).title);
  }

  // ---------- The pane ----------

  private render() {
    this.statusText = null;
    this.soundButton = null;
    this.lockRow = null;
    this.element.classList.toggle("pane--message", this.phase !== "mirroring");
    // Text on the glass skin always sits on a panel; the card is one panel, not many boxes.
    this.element.classList.toggle("panel", this.phase === "mirroring");
    this.element.setAttribute("aria-label", this.title);
    if (this.phase === "connecting") {
      const title = text.connecting(this.title);
      this.element.replaceChildren(
        message(this.id("title"), title, [
          h("div", { class: "progress", role: "progressbar", "aria-label": title }),
          h("p", { class: "text-muted connect-hint is-invisible" }, text.connectingSlow),
          actions(button(text.cancel, () => this.host.close(this))),
        ], true),
      );
      return;
    }
    if (this.phase === "ended") {
      const error = this.error ?? { code: "stream_ended", detail: "" };
      const copy = text.error(error.code);
      this.element.replaceChildren(
        message(this.id("title"), copy.title, [
          h("p", {}, copy.body),
          actions(
            button(text.tryAgain, () => this.host.retry(this), "primary"),
            button(text.closeTab, () => this.host.close(this)),
          ),
          error.detail ? details(error.detail) : null,
        ]),
      );
      return;
    }
    // B-010, B-014: one calm card per device, laid out like the phone itself: a slim header with
    // the name and the device's own actions, the screen, and Android's nav bar below it.
    this.statusText = h("span", { class: "pane__status" });
    this.element.replaceChildren(
      h(
        "div",
        { class: "pane__header" },
        h("span", { class: "pane__title" }, this.title),
        // Says whether the keyboard goes to the device. Both lines keep their space, so switching
        // moves nothing (LAY-02).
        h(
          "span",
          { class: "control-hint" },
          h("span", { class: "control-hint__idle" }, text.controlHint),
          h("span", { class: "control-hint__active", id: this.id("hint") }, text.controlHintActive),
        ),
        this.statusText,
        h(
          "div",
          { class: "pane__actions" },
          this.soundToggle(),
          this.iconButton(text.power, "power", () => this.control.button("power")),
          h(
            "button",
            { class: "button button--ghost", type: "button", onclick: () => this.host.close(this) },
            text.stop,
          ),
        ),
      ),
      this.lockForm(),
      // The mirrored screen never sits under glass or any other layer.
      h("div", { class: "screen" }, this.canvas),
      h(
        "div",
        { class: "pane__nav", role: "group", "aria-label": text.deviceButtons },
        this.iconButton(text.back, "back", () => this.control.button("back")),
        this.iconButton(text.home, "home", () => this.control.button("home")),
        this.iconButton(text.recentApps, "recentApps", () => this.control.button("recentApps")),
      ),
    );
    this.updateStatus();
    this.renderLock();
  }

  /**
   * A quiet icon button with Android's own symbol. The name is in aria-label and the tooltip
   * (CMP-14). A mouse click leaves focus on the screen, so typing can go on.
   */
  private iconButton(label: string, which: DeviceButton, onClick: () => void) {
    return withTooltip(
      h(
        "button",
        {
          class: "button button--ghost button--icon",
          type: "button",
          "aria-label": label,
          onmousedown: (event: Event) => event.preventDefault(),
          onclick: onClick,
        },
        icon(which),
      ),
    );
  }

  // ---------- Sound ----------

  /**
   * Whether this device's sound plays on the PC. A toggle with a fixed name and aria-pressed; the
   * icon shows the state too (COL-03). A mouse click leaves focus on the screen.
   */
  private soundToggle() {
    this.soundButton = withTooltip(
      h("button", {
        class: "button button--ghost button--icon",
        type: "button",
        onmousedown: (event: Event) => event.preventDefault(),
        onclick: () => this.toggleSound(),
      }),
    );
    this.renderSound();
    return this.soundButton;
  }

  private renderSound() {
    const button = this.soundButton;
    if (!button) return;
    const unsupported = this.player.audio.current === "unsupported";
    const on = this.soundOnPc && !unsupported;
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", unsupported ? text.soundUnsupportedLabel : text.soundOnPc);
    if (unsupported) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
    button.replaceChildren(icon(on ? "soundOn" : "soundOff"));
  }

  private toggleSound() {
    if (this.player.audio.current === "unsupported") {
      this.host.announce(this, text.soundUnsupportedLabel);
      return;
    }
    this.host.setSound(this, !this.soundOnPc);
  }

  private soundChanged(state: AudioState) {
    this.renderSound();
    this.updateStatus();
    const note = this.soundOnPc ? text.soundNote(state) : null;
    if (note) this.host.announce(this, note);
  }

  // ---------- Lock (B-012) ----------

  /**
   * One compact row with a field for the device's code, shown only while the device is locked
   * with a code. The mirror shows such a lock screen black, so this is where the code goes; a
   * lock without a code shows in the mirror and needs only Power and a swipe. The field is
   * cleared at once, and the code is never stored.
   */
  private lockForm(): HTMLFormElement {
    this.lockRow = h(
      "form",
      { class: "lock", hidden: true, onsubmit: (event: Event) => this.submitUnlock(event) },
      h("label", { class: "text-label", for: this.id("code") }, text.lock.codeLabel),
      h("input", {
        class: "field",
        id: this.id("code"),
        name: "unlock-code",
        type: "password",
        autocomplete: "off",
        spellcheck: "false",
        autocapitalize: "off",
        "aria-describedby": this.id("lock-note"),
      }),
      h("button", { class: "button button--primary", type: "submit" }, text.lock.unlock),
      h("p", { class: "lock__note", id: this.id("lock-note"), role: "status" }),
    );
    return this.lockRow;
  }

  private renderLock() {
    const row = this.lockRow;
    if (!row) return;
    const flags = this.deviceState ?? 0;
    const show = (flags & STATE_LOCKED) !== 0 && (flags & STATE_NEEDS_CODE) !== 0;
    const input = row.querySelector<HTMLInputElement>("input");
    if (!show) {
      window.clearTimeout(this.unlockCheck);
      const hadFocus = row.contains(document.activeElement);
      row.hidden = true;
      if (input) input.value = "";
      this.setLockNote("");
      // A11Y-09: the focused field is gone, so the screen takes over, ready for the keyboard.
      if (hadFocus) this.focusScreen();
      return;
    }
    if (!row.hidden) return;
    row.hidden = false;
    this.host.announce(this, text.lock.announce);
    // The field is the clear place for the code; take focus only from this screen or nowhere.
    const active = document.activeElement;
    if (active === document.body || active === this.canvas) input?.focus();
  }

  private setLockNote(note: string) {
    const element = this.lockRow?.querySelector<HTMLElement>(".lock__note");
    if (element) element.textContent = note;
  }

  private submitUnlock(event: Event) {
    event.preventDefault();
    const input = this.lockRow?.querySelector<HTMLInputElement>("input");
    const code = input?.value ?? "";
    if (input) input.value = "";
    this.setLockNote("");
    this.control.unlock(code);
    window.clearTimeout(this.unlockCheck);
    if (!code) return;
    this.unlockCheck = window.setTimeout(() => {
      if (this.deviceState === null || (this.deviceState & STATE_LOCKED) === 0) return;
      this.setLockNote(text.lock.stillLocked);
      input?.focus();
    }, UNLOCK_CHECK_MS);
  }
}

/** A panel with a heading and a body, for the stage and for a pane that is not mirroring. */
export function message(id: string, title: string, body: Array<Node | null>, busy = false): HTMLElement {
  return h(
    "section",
    { class: "message panel", "aria-labelledby": id, "aria-busy": busy ? "true" : undefined },
    h("h2", { class: "message__title", id, tabindex: "-1" }, title),
    ...body,
  );
}

export const actions = (...buttons: Node[]) => h("div", { class: "actions" }, ...buttons);

export function button(label: string, onClick: () => void, variant: "primary" | "secondary" = "secondary") {
  return h("button", { class: `button button--${variant}`, type: "button", onclick: onClick }, label);
}

export function details(detail: string): Node {
  return h("details", { class: "details" }, h("summary", {}, text.details), h("pre", {}, detail));
}
