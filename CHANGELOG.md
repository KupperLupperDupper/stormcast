# Changelog

All notable changes to Stormcast are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release on GitHub uses its section from this file as release notes.

## [Unreleased]

### Added

- Hear the device's sound on the PC while mirroring, with little delay and in step with the picture. Meanwhile the device itself is silent. The speaker button in the toolbar gives the sound back to the device, and Stormcast remembers the choice. Sound needs Android 12 or newer; on older devices Stormcast says so and mirrors without sound.

### Security

- Releases carry a fixed version of adb (Android platform-tools 37.0.1), and the build stops if the download does not match its known checksum.
- Releases are built from exactly the locked dependency versions, and every change is checked for known vulnerabilities in its dependencies.

## [0.1.0] - 2026-11-15

The first release: see and control an Android device from a Windows PC over a USB cable.

### Added

- Mirror the device's screen. The video is encoded on the device and decoded on the PC's graphics card, and the first frame shows in about a second.
- Control the device from the PC: clicks, taps and drags become touches, the mouse wheel scrolls, and the keyboard types while the screen has focus. Right-click is Back.
- Back, Home, Recent apps and Power buttons in the toolbar.
- Copy and paste text between the PC and the device.
- Stormcast's own small server for the device. It is copied over when mirroring starts and removes itself, so nothing is installed on the device.
- A glass design on Windows 11, and a solid design on Windows 10 and when transparency effects are turned off.
- An installer for the current user and a portable zip, with SHA-256 checksums and build attestations.

### Known issues

- The files are not code-signed yet, so Windows SmartScreen warns the first time you start them.
- No audio and no wireless connection yet.

[Unreleased]: https://github.com/KupperLupperDupper/stormcast/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KupperLupperDupper/stormcast/releases/tag/v0.1.0
