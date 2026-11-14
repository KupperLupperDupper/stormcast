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
    body: "The mirroring service was not found. Reinstall Stormcast. If you built it yourself, run npm run fetch-deps.",
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

  connecting: (name: string) => `Starting mirroring on ${name}…`,
  connectingSlow: "The first start can take a few seconds while the device prepares its video encoder.",
  status: (width: number, height: number, fps: number) => `${width} × ${height} · ${fps} fps`,

  announceMirroring: (name: string) => `Mirroring ${name}`,
  announceStopped: "Mirroring stopped",

  error: (code: string) => errors[code] ?? errors.unknown,
  adbInstallCommand: "winget install Google.PlatformTools",
};
