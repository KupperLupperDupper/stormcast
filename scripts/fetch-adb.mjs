#!/usr/bin/env node
// Downloads a pinned version of Android platform-tools, checks it against a committed SHA-256 and
// copies adb into src-tauri/resources/platform-tools for releases. A mismatch stops the build.
//
// To update: take the new version's Windows zip from Google's SDK index
// (https://dl.google.com/android/repository/repository2-3.xml, channel-0 is stable), download it,
// check its size and SHA-1 against the index, and set VERSION and SHA256 below from that file.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "37.0.1";
const SHA256 = "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99";
const DOWNLOAD = `https://dl.google.com/android/repository/platform-tools_r${VERSION}-win.zip`;
const FILES = ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt", "source.properties"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "resources", "platform-tools");

console.log(`platform-tools: downloading ${DOWNLOAD}`);
const response = await fetch(DOWNLOAD);
if (!response.ok) throw new Error(`GET ${DOWNLOAD} failed: ${response.status} ${response.statusText}`);
const zip = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha256").update(zip).digest("hex");
if (actual !== SHA256) {
  console.error(`platform-tools: SHA-256 mismatch for ${DOWNLOAD}\n  expected ${SHA256}\n  got      ${actual}`);
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "stormcast-"));
try {
  const zipPath = join(temp, "platform-tools.zip");
  writeFileSync(zipPath, zip);
  // Windows' own bsdtar extracts zip files; Git's GNU tar on PATH would not.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", zipPath, "-C", temp]);
  const source = join(temp, "platform-tools");

  const revision = readFileSync(join(source, "source.properties"), "utf8").match(/Pkg\.Revision=(.+)/)?.[1]?.trim();
  if (revision !== VERSION) throw new Error(`platform-tools: expected revision ${VERSION}, the zip says ${revision}`);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of FILES) {
    if (!existsSync(join(source, file))) throw new Error(`platform-tools: ${file} is missing from the zip`);
    copyFileSync(join(source, file), join(target, file));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`platform-tools ${VERSION}: verified (sha256 ${SHA256}) and copied to ${target}`);
