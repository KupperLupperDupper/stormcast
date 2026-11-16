import { Channel, invoke } from "@tauri-apps/api/core";

export type Skin = "glass" | "solid";

export interface Appearance {
  skin: Skin;
  windowsBuild: number;
  transparencyEffects: boolean;
  reason: string;
}

export interface Startup {
  appearance: Appearance;
  /** STORMCAST_SMOKE=1: mirror the first ready device, report and exit. */
  smoke: boolean;
}

export interface Device {
  serial: string;
  /** adb state: "device" when ready, otherwise "unauthorized", "offline", … */
  state: string;
  model: string | null;
  product: string | null;
}

/** Details about a device (B-008, src-tauri/src/diagnostics.rs). A device may not report every field. */
export interface DeviceInfo {
  manufacturer: string | null;
  model: string | null;
  android: string | null;
  sdk: number | null;
  securityPatch: string | null;
  abi: string | null;
  screenWidth: number | null;
  screenHeight: number | null;
  density: number | null;
  batteryLevel: number | null;
  batteryStatus: "charging" | "discharging" | "notCharging" | "full" | null;
  batteryHealth: "good" | "overheat" | "dead" | "overVoltage" | "failure" | "cold" | null;
  batteryTemperatureC: number | null;
  powerSource: "usb" | "ac" | "wireless" | null;
  memoryMb: number | null;
  storageTotalMb: number | null;
  storageFreeMb: number | null;
  uptimeSeconds: number | null;
}

/** Errors from Rust carry a stable code (selects the UI text) and a technical detail. */
export interface AppError {
  code: string;
  detail: string;
}

/** Android's navigation buttons and the power button. */
export type DeviceButton = "back" | "home" | "recentApps" | "power";

/**
 * A control message for the device (docs/PROTOCOL.md). Positions are pixels on a video of
 * width × height; src-tauri/src/protocol.rs encodes them.
 */
export type ControlMessage =
  | {
      type: "touch";
      action: "down" | "move" | "up" | "cancel";
      pointer: number;
      x: number;
      y: number;
      width: number;
      height: number;
      pressure: number;
    }
  | { type: "key"; action: "down" | "up"; keycode: number; repeat: number; metaState: number }
  | { type: "text"; text: string }
  | { type: "button"; button: DeviceButton }
  | { type: "scroll"; x: number; y: number; width: number; height: number; hScroll: number; vScroll: number }
  /** Ctrl+V: the app pastes the PC's clipboard text on the device. */
  | { type: "paste" }
  /** Starts or stops sound capture on the device. */
  | { type: "audio"; on: boolean }
  /** Wakes the screen, opens the lock screen's code entry and types the code there with Enter (B-012). */
  | { type: "unlock"; code: string };

export const getStartup = () => invoke<Startup>("get_startup");
export const listDevices = () => invoke<Device[]>("list_devices");
export const deviceInfo = (serial: string) => invoke<DeviceInfo>("device_info", { serial });
/** Stops mirroring this device; others go on (B-007). */
export const stopMirror = (serial: string) => invoke<void>("stop_mirror", { serial });
export const smokeReport = (report: Record<string, unknown>) => invoke<void>("smoke_report", { report });
/** Sends control messages to the device in this order. Without a session they are dropped. */
export const sendControl = (serial: string, messages: ControlMessage[]) =>
  invoke<void>("send_control", { serial, messages });

/**
 * Starts mirroring, with the device's sound on the PC when `audio` is set. Messages arrive on
 * `onPacket` until the stream ends or `stopMirror` is called.
 */
export function startMirror(serial: string, audio: boolean, onPacket: (packet: unknown) => void): Promise<void> {
  const channel = new Channel<unknown>();
  channel.onmessage = onPacket;
  return invoke<void>("start_mirror", { serial, audio, onPacket: channel });
}

export function asAppError(error: unknown): AppError {
  if (error && typeof error === "object" && "code" in error && "detail" in error) {
    return error as AppError;
  }
  return { code: "unknown", detail: String(error) };
}
