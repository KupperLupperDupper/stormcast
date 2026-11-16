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
  soundUnsupportedLabel: "Sound on this PC needs Android 12 or newer on the device",
  /** Shown in the status line, and announced, when the device sends no sound. */
  soundNote: (state: string): string | null => soundNotes[state] ?? null,
  controlHint: "Click or tap the screen to control the device.",
  controlHintActive: "Keyboard input goes to the device. Press Tab to leave the screen.",

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
