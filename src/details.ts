/**
 * B-008: the device details in the sidebar, from adb (src-tauri/src/diagnostics.rs) and the
 * stream's own numbers. Numbers follow the user's locale (TXT-04); unknown values are left out.
 */
import type { DeviceInfo } from "./ipc";
import type { PlayerStats } from "./player";
import { text } from "./strings";

const t = text.deviceDetails;
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(undefined, { style: "percent" });
const celsius = new Intl.NumberFormat(undefined, { style: "unit", unit: "celsius", maximumFractionDigits: 1 });
const gigabytes = new Intl.NumberFormat(undefined, { style: "unit", unit: "gigabyte", maximumFractionDigits: 1 });

export type Fact = [term: string, value: string];

/** The rows to show, in order. */
export function facts(serial: string, info: DeviceInfo | null, stats: PlayerStats | null): Fact[] {
  const rows: Array<Fact | null> = [];
  if (info) {
    const name = [info.manufacturer, info.model].filter(Boolean).join(" ");
    rows.push(name ? [t.device, name] : null);
    rows.push(info.android ? [t.android, t.androidVersion(info.android, info.sdk, info.securityPatch)] : null);
    rows.push(screen(info));
    rows.push(battery(info));
    rows.push(info.memoryMb === null ? null : [t.memory, gigabytes.format(info.memoryMb / 1024)]);
    rows.push(
      info.storageFreeMb === null || info.storageTotalMb === null
        ? null
        : [t.storage, t.storageFree(gigabytes.format(info.storageFreeMb / 1024), gigabytes.format(info.storageTotalMb / 1024))],
    );
    rows.push(info.uptimeSeconds === null ? null : [t.uptime, uptime(info.uptimeSeconds)]);
  }
  // adb names a device on the network by its address and port.
  rows.push([t.connection, serial.includes(":") ? t.network : t.usb]);
  if (stats) {
    rows.push(video(stats));
    rows.push(sound(stats));
  }
  return rows.filter((row): row is Fact => row !== null);
}

function screen(info: DeviceInfo): Fact | null {
  if (info.screenWidth === null || info.screenHeight === null) return null;
  const size = `${info.screenWidth} × ${info.screenHeight}`;
  return [t.screen, info.density === null ? size : `${size} · ${t.density(whole.format(info.density))}`];
}

function battery(info: DeviceInfo): Fact | null {
  if (info.batteryLevel === null) return null;
  const status = info.batteryStatus ? t.batteryStatus[info.batteryStatus] : null;
  const charging = info.batteryStatus === "charging" && info.powerSource ? t.powerSource[info.powerSource] : null;
  const health = info.batteryHealth && info.batteryHealth !== "good" ? t.batteryHealth[info.batteryHealth] : null;
  const temperature = info.batteryTemperatureC === null ? null : celsius.format(info.batteryTemperatureC);
  const parts = [percent.format(info.batteryLevel / 100), [status, charging].filter(Boolean).join(" "), health, temperature];
  return [t.battery, parts.filter(Boolean).join(" · ")];
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? t.days(whole.format(days), whole.format(hours)) : t.hours(whole.format(hours), whole.format(minutes));
}

function video(stats: PlayerStats): Fact | null {
  if (stats.width === 0) return null;
  const parts = [
    stats.codec?.startsWith("avc1") ? "H.264" : stats.codec,
    `${stats.width} × ${stats.height}`,
    t.fps(whole.format(stats.fps)),
    stats.framesDropped > 0 ? t.dropped(whole.format(stats.framesDropped)) : null,
  ];
  return [t.video, parts.filter(Boolean).join(" · ")];
}

function sound(stats: PlayerStats): Fact {
  const state = t.soundState[stats.audio.state] ?? stats.audio.state;
  const offset = stats.avOffsetMs;
  const sync =
    offset === null || stats.audio.state !== "playing"
      ? null
      : offset >= 0
        ? t.behind(number.format(offset))
        : t.ahead(number.format(-offset));
  return [t.sound, [state, sync].filter(Boolean).join(" · ")];
}
