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

/** Errors from Rust carry a stable code (selects the UI text) and a technical detail. */
export interface AppError {
  code: string;
  detail: string;
}

export const getStartup = () => invoke<Startup>("get_startup");
export const listDevices = () => invoke<Device[]>("list_devices");
export const stopMirror = () => invoke<void>("stop_mirror");
export const smokeReport = (report: Record<string, unknown>) => invoke<void>("smoke_report", { report });

/** Starts mirroring. Messages arrive on `onPacket` until the stream ends or `stopMirror` is called. */
export function startMirror(serial: string, onPacket: (packet: unknown) => void): Promise<void> {
  const channel = new Channel<unknown>();
  channel.onmessage = onPacket;
  return invoke<void>("start_mirror", { serial, onPacket: channel });
}

export function asAppError(error: unknown): AppError {
  if (error && typeof error === "object" && "code" in error && "detail" in error) {
    return error as AppError;
  }
  return { code: "unknown", detail: String(error) };
}
