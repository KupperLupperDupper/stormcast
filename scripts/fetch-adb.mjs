#!/usr/bin/env node
// Copies adb from Android platform-tools into src-tauri/resources/platform-tools for releases:
// from ANDROID_HOME when it has one, otherwise from Google's download.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOWNLOAD = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
const FILES = ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt"];
const OPTIONAL = ["source.properties"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "resources", "platform-tools");

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
let source = sdk ? join(sdk, "platform-tools") : null;
let temp = null;
if (!source || !existsSync(join(source, "adb.exe"))) {
  console.log(`platform-tools: downloading ${DOWNLOAD}`);
  const response = await fetch(DOWNLOAD);
  if (!response.ok) throw new Error(`GET ${DOWNLOAD} failed: ${response.status} ${response.statusText}`);
  const zip = Buffer.from(await response.arrayBuffer());
  temp = mkdtempSync(join(tmpdir(), "stormcast-"));
  const zipPath = join(temp, "platform-tools.zip");
  writeFileSync(zipPath, zip);
  // Windows' own bsdtar extracts zip files; Git's GNU tar on PATH would not.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", zipPath, "-C", temp]);
  source = join(temp, "platform-tools");
  console.log(`platform-tools: download sha256 ${createHash("sha256").update(zip).digest("hex")}`);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of FILES) copyFileSync(join(source, file), join(target, file));
for (const file of OPTIONAL) {
  if (existsSync(join(source, file))) copyFileSync(join(source, file), join(target, file));
}
if (temp) rmSync(temp, { recursive: true, force: true });

const properties = join(target, "source.properties");
const version = existsSync(properties)
  ? readFileSync(properties, "utf8").match(/Pkg\.Revision=(.+)/)?.[1]?.trim()
  : undefined;
console.log(`platform-tools ${version ?? "(unknown version)"}: copied from ${source}`);
