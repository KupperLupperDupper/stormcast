/**
 * All user-facing text. Buttons name the action (TXT-01); errors say what happened
 * and what to do (TXT-02, PAT-04).
 */

const deviceStates: Record<string, string> = {
  device: "Ready",
  unauthorized: "Needs permission",
  offline: "Offline",
};

const errors: Record<string, { title: string; body: string }> = {
  adb_not_found: {
    title: "Android platform tools are missing",
    body: "Stormcast uses adb to talk to your device. Install it with this command in a terminal, then restart Stormcast:",
  },
  device_unauthorized: {
    title: "Allow USB debugging",
    body: "Unlock the device and tap Allow on the USB debugging prompt. If no prompt appears, reconnect the cable.",
  },
  device_offline: {
    title: "The device is offline",
    body: "Reconnect the USB cable. If that does not help, restart the device.",
  },
  server_missing: {
    title: "Part of Stormcast is missing",
    body: "The phone service was not found. Reinstall Stormcast. If you built it yourself, run npm run build:server.",
  },
  protocol_mismatch: {
    title: "Stormcast and its phone service do not match",
    body: "Reinstall Stormcast. If you built it yourself, run npm run build:server.",
  },
  display_unavailable: {
    title: "The device did not allow screen capture",
    body: "Unlock the device and try again. If it keeps happening, restart the device.",
  },
  encoder_failed: {
    title: "The device's video encoder failed",
    body: "Try again. If it keeps failing, restart the device.",
  },
  server_error: {
    title: "The phone service stopped with an error",
    body: "Try again. If it keeps happening, report the technical details below.",
  },
  connect_timeout: {
    title: "The device did not respond",
    body: "Unlock the device and try again. If it keeps happening, reconnect the USB cable.",
  },
  server_failed: {
    title: "Mirroring could not start on the device",
    body: "Try again. If it keeps failing, restart the device.",
  },
  stream_ended: {
    title: "Mirroring stopped",
    body: "The device closed the connection, for example because the cable was unplugged or the device restarted.",
  },
  decoder: {
    title: "The video could not be shown",
    body: "The graphics driver could not decode the video. Try again, or update the graphics driver.",
  },
  unknown: {
    title: "Something went wrong",
    body: "Try again. If it keeps happening, report the technical details below.",
  },
};

const soundNotes: Record<string, string> = {
  unsupported: "No sound on this PC: the device needs Android 12 or newer",
  refused: "No sound: the device did not allow it. Turn sound off and on to try again.",
  failed: "The sound stopped. Turn sound off and on to try again.",
};

export const text = {
  appName: "Stormcast",
  tagline: "Android screen mirroring",
  devicesHeading: "Devices",
  searching: "Looking for devices…",

  deviceState: (state: string) => deviceStates[state] ?? state,
  mirroringNow: "Mirroring",

  noDevice: {
    title: "Connect your Android device",
    steps: [
      "On the device, open Settings, find Build number (usually under About phone) and tap it seven times.",
      "Open Developer options and turn on USB debugging.",
      "Connect the device with a USB cable, unlock it and tap Allow.",
    ],
  },
  pick: {
    title: "Choose a device to mirror",
    one: (name: string) => `${name} is ready.`,
    many: "Select a device in the list.",
  },

  mirror: "Mirror screen",
  stop: "Stop mirroring",
  cancel: "Cancel",
  tryAgain: "Try again",
  details: "Technical details",
  screenLabel: "Mirrored device screen",

  deviceButtons: "Device buttons",
  back: "Back",
  home: "Home",
  recentApps: "Recent apps",
  power: "Power",
  soundOnPc: "Sound on this PC",
  /** B-007 and B-009: every mirrored device has a tab; "Show all" puts them side by side. */
  tabsLabel: "Mirrored devices",
  tabConnecting: "Starting…",
  tabEnded: "Stopped",
  closeTab: "Close",
  showAll: "Show all",
  showAllTooltip: "Show all devices side by side",
  announceShowAll: "All devices side by side",
  announceTabs: "One device at a time",
  /** B-003: a toggle with a fixed name; F11 does the same. */
  fullScreen: "Full screen",
  fullScreenTooltip: "Full screen (F11)",
  announceFullScreen: "Full screen. Press F11 to leave it.",
  announceWindowed: "Full screen off",
  soundUnsupportedLabel: "Sound on this PC needs Android 12 or newer on the device",
  /** Shown in the status line, and announced, when the device sends no sound. */
  soundNote: (state: string): string | null => soundNotes[state] ?? null,
  controlHint: "Click or tap the screen to control the device.",
  controlHintActive: "Keyboard input goes to the device. Press Tab to leave the screen.",

  /** B-008: the device details in the sidebar. Values that are not known are left out. */
  deviceDetails: {
    heading: "Device details",
    device: "Device",
    android: "Android",
    screen: "Screen",
    battery: "Battery",
    memory: "Memory",
    storage: "Storage",
    uptime: "Uptime",
    connection: "Connection",
    video: "Video",
    sound: "Sound",
    usb: "USB",
    network: "Network",
    androidVersion: (version: string, sdk: number | null, patch: string | null) =>
      [sdk === null ? version : `${version} (API ${sdk})`, patch ? `patch ${patch}` : null]
        .filter(Boolean)
        .join(" · "),
    density: (dpi: string) => `${dpi} dpi`,
    storageFree: (free: string, total: string) => `${free} free of ${total}`,
    days: (days: string, hours: string) => `${days} d ${hours} h`,
    hours: (hours: string, minutes: string) => `${hours} h ${minutes} min`,
    fps: (fps: string) => `${fps} fps`,
    dropped: (count: string) => `${count} dropped`,
    behind: (ms: string) => `${ms} ms behind the picture`,
    ahead: (ms: string) => `${ms} ms ahead of the picture`,
    batteryStatus: {
      charging: "Charging",
      discharging: "On battery",
      notCharging: "Not charging",
      full: "Full",
    } as Record<string, string>,
    batteryHealth: {
      overheat: "Overheating",
      dead: "Dead",
      overVoltage: "Over voltage",
      failure: "Failing",
      cold: "Too cold",
    } as Record<string, string>,
    powerSource: { usb: "from USB", ac: "from a charger", wireless: "wireless charging" } as Record<string, string>,
    soundState: {
      off: "Off",
      starting: "Starting",
      playing: "Playing",
      unsupported: "Needs Android 12",
      refused: "Not allowed",
      failed: "Stopped",
    } as Record<string, string>,
  },

  /** B-012: the device's lock state. Its lock screen shows black in the mirror. */
  lock: {
    /** Announced when the field appears: the lock screen itself stays dark in the mirror. */
    announce: "The device is locked. Enter its PIN or password to unlock it.",
    codeLabel: "Device locked: PIN or password",
    unlock: "Unlock",
    stillLocked: "Still locked. Check the code and try again. A pattern must be drawn on the device.",
  },

  connecting: (name: string) => `Starting mirroring on ${name}…`,
  connectingSlow: "The first start can take a few seconds while the device prepares its video encoder.",
  status: (width: number, height: number, fps: number) => `${width} × ${height} · ${fps} fps`,

  announceMirroring: (name: string) => `Mirroring ${name}`,
  announceStopped: "Mirroring stopped",

  error: (code: string) => errors[code] ?? errors.unknown,
  adbInstallCommand: "winget install Google.PlatformTools",
};
