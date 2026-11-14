/**
 * Turns input on the mirrored screen into control messages for the device (docs/PROTOCOL.md):
 * mouse, touch and pen into touches, the wheel into scrolling, and the keyboard into keys and
 * text while the screen has focus. Every event is sent at once, with no debounce (PERF-05).
 */
import { sendControl, type ControlMessage, type DeviceButton } from "./ipc";

type TouchAction = "down" | "move" | "up" | "cancel";

interface Position {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Android's KeyEvent.META_* bits. The browser does not tell left from right, so it is the left key.
const META_SHIFT = 0x41;
const META_ALT = 0x12;
const META_CTRL = 0x3000;
const META_META = 0x30000;
const META_CAPS_LOCK = 0x100000;
const META_NUM_LOCK = 0x200000;

const KEYCODE_0 = 7;
const KEYCODE_A = 29;
const KEYCODE_F1 = 131;
const KEYCODE_NUMPAD_0 = 144;

/** KeyboardEvent.code → Android keycode, for keys that type no text and for shortcuts. */
const KEYCODES: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 160,
  Backspace: 67,
  Delete: 112,
  Escape: 111,
  Tab: 61,
  Space: 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Insert: 124,
  ContextMenu: 82,
  Backquote: 68,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Slash: 76,
  Comma: 55,
  Period: 56,
  NumpadDivide: 154,
  NumpadMultiply: 155,
  NumpadSubtract: 156,
  NumpadAdd: 157,
  NumpadDecimal: 158,
  NumpadComma: 159,
  NumpadEqual: 161,
};
for (let i = 0; i < 26; i++) KEYCODES[`Key${String.fromCharCode(65 + i)}`] = KEYCODE_A + i;
for (let i = 0; i < 10; i++) {
  KEYCODES[`Digit${i}`] = KEYCODE_0 + i;
  KEYCODES[`Numpad${i}`] = KEYCODE_NUMPAD_0 + i;
}
for (let i = 0; i < 12; i++) KEYCODES[`F${i + 1}`] = KEYCODE_F1 + i;

/** Chromium scrolls 100 px or 3 lines per wheel notch; Android's scroll axes count notches. */
const PIXELS_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;
const MAX_NOTCHES = 16;

export class DeviceControl {
  private readonly canvas: HTMLCanvasElement;
  /** Pointers that are down on the device, by PointerEvent.pointerId. */
  private readonly pointers = new Set<number>();
  /** Keys that are down on the device, by KeyboardEvent.code. */
  private readonly keys = new Map<string, { keycode: number; repeat: number }>();
  private queue: ControlMessage[] = [];
  private sending = false;
  private closed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.pointerEnd(event, "cancel"));
    // Also fires after pointerup, when the pointer is already gone.
    canvas.addEventListener("lostpointercapture", (event) => this.pointerEnd(event, "cancel"));
    canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    canvas.addEventListener("keydown", (event) => this.keyDown(event));
    canvas.addEventListener("keyup", (event) => this.keyUp(event));
    canvas.addEventListener("blur", () => this.releaseKeys());
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /** Presses one of Android's navigation buttons. */
  button(button: DeviceButton): void {
    this.send({ type: "button", button });
  }

  /** Stops sending: the session is over. */
  close(): void {
    this.closed = true;
    this.queue = [];
  }

  private pointerDown(event: PointerEvent) {
    this.canvas.focus({ preventScroll: true });
    // Only the main button touches; the right one is Back when released.
    if (event.button !== 0) return;
    const position = this.position(event);
    if (!position) return;
    // GES-05: the touch goes on when the pointer leaves the screen.
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.add(event.pointerId);
    this.touch("down", event, position);
  }

  private pointerMove(event: PointerEvent) {
    if (!this.pointers.has(event.pointerId)) return;
    const position = this.position(event);
    if (position) this.touch("move", event, position);
  }

  private pointerUp(event: PointerEvent) {
    if (this.pointers.has(event.pointerId)) {
      this.pointerEnd(event, "up");
    } else if (event.pointerType === "mouse" && event.button === 2) {
      // Right click is Back, as with a mouse on Android itself.
      this.button("back");
    }
  }

  private pointerEnd(event: PointerEvent, action: "up" | "cancel") {
    if (!this.pointers.delete(event.pointerId)) return;
    const position = this.position(event);
    if (position) this.touch(action, event, position);
  }

  private touch(action: TouchAction, event: PointerEvent, position: Position) {
    // A mouse reports 0.5 while pressed and some touch screens 0; both are an ordinary touch.
    const pressure = event.pointerType === "mouse" || !(event.pressure > 0) ? 1 : event.pressure;
    this.send({ type: "touch", action, pointer: event.pointerId >>> 0, ...position, pressure });
  }

  private wheel(event: WheelEvent) {
    // Ctrl + wheel zooms the app (TYP-02), and touchpads send their pinch that way.
    if (event.ctrlKey) return;
    const position = this.position(event);
    if (!position) return;
    event.preventDefault();
    const perNotch =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? PIXELS_PER_NOTCH
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINES_PER_NOTCH
          : 1;
    const hScroll = notches(event.deltaX / perNotch);
    const vScroll = notches(-event.deltaY / perNotch);
    if (hScroll !== 0 || vScroll !== 0) this.send({ type: "scroll", ...position, hScroll, vScroll });
  }

  private keyDown(event: KeyboardEvent) {
    // A dead key or an input method is still composing; the next key brings the character.
    if (event.isComposing || event.key === "Dead" || event.key === "Process" || keepsForApp(event)) return;
    const text = typedText(event);
    if (text !== null) {
      event.preventDefault();
      this.send({ type: "text", text });
      return;
    }
    const keycode = keycodeOf(event);
    if (keycode === undefined) return;
    event.preventDefault();
    const held = this.keys.get(event.code);
    const repeat = held && event.repeat ? held.repeat + 1 : 0;
    this.keys.set(event.code, { keycode, repeat });
    this.send({ type: "key", action: "down", keycode, repeat, metaState: metaState(event) });
  }

  private keyUp(event: KeyboardEvent) {
    const held = this.keys.get(event.code);
    if (!held) return;
    event.preventDefault();
    this.keys.delete(event.code);
    this.send({ type: "key", action: "up", keycode: held.keycode, repeat: 0, metaState: metaState(event) });
  }

  /** Lets go of keys that are down when focus leaves the screen, so none stays pressed on the device. */
  private releaseKeys() {
    for (const { keycode } of this.keys.values()) {
      this.send({ type: "key", action: "up", keycode, repeat: 0, metaState: 0 });
    }
    this.keys.clear();
  }

  /** The pixel on the video under the pointer, kept inside it; null before the first frame. */
  private position(event: MouseEvent): Position | null {
    const { width, height } = this.canvas;
    const rect = this.canvas.getBoundingClientRect();
    if (width === 0 || height === 0 || rect.width === 0 || rect.height === 0) return null;
    return {
      x: clamp(Math.floor(((event.clientX - rect.left) / rect.width) * width), 0, width - 1),
      y: clamp(Math.floor(((event.clientY - rect.top) / rect.height) * height), 0, height - 1),
      width,
      height,
    };
  }

  private send(message: ControlMessage) {
    if (this.closed) return;
    this.queue.push(message);
    if (!this.sending) void this.flush();
  }

  /** One request at a time keeps the messages in order; what comes meanwhile goes in the next. */
  private async flush() {
    this.sending = true;
    while (this.queue.length > 0 && !this.closed) {
      const batch = this.queue;
      this.queue = [];
      try {
        await sendControl(batch);
      } catch (error) {
        console.warn("Sending input to the device failed", error);
      }
    }
    this.sending = false;
  }
}

/** Keys the app keeps: Tab leaves the screen (A11Y-03), Ctrl with +, - or 0 zooms (TYP-02), and Alt+F4 closes. */
function keepsForApp(event: KeyboardEvent): boolean {
  if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return true;
  if (event.ctrlKey && !event.altKey && ["+", "-", "=", "0"].includes(event.key)) return true;
  return event.altKey && event.key === "F4";
}

/** The text a key types, or null for keys such as Enter and for shortcuts such as Ctrl+C. AltGr still types. */
function typedText(event: KeyboardEvent): string | null {
  const shortcut = (event.ctrlKey || event.altKey || event.metaKey) && !event.getModifierState("AltGraph");
  return !shortcut && [...event.key].length === 1 ? event.key : null;
}

/** Letters and digits by the keyboard layout, so Ctrl+Z is Z on every layout; other keys by position. */
function keycodeOf(event: KeyboardEvent): number | undefined {
  const key = event.key.length === 1 ? event.key.toLowerCase() : "";
  if (key >= "a" && key <= "z") return KEYCODE_A + key.charCodeAt(0) - "a".charCodeAt(0);
  if (key >= "0" && key <= "9") return KEYCODE_0 + key.charCodeAt(0) - "0".charCodeAt(0);
  return KEYCODES[event.code];
}

function metaState(event: KeyboardEvent): number {
  let meta = 0;
  if (event.shiftKey) meta |= META_SHIFT;
  if (event.altKey) meta |= META_ALT;
  if (event.ctrlKey) meta |= META_CTRL;
  if (event.metaKey) meta |= META_META;
  if (event.getModifierState("CapsLock")) meta |= META_CAPS_LOCK;
  if (event.getModifierState("NumLock")) meta |= META_NUM_LOCK;
  return meta;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const notches = (value: number) => (Number.isFinite(value) ? clamp(value, -MAX_NOTCHES, MAX_NOTCHES) : 0);
