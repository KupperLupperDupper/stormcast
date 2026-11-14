#!/usr/bin/env node
// Downloads what Stormcast runs but does not build itself into src-tauri/resources:
//   - the scrcpy server, pinned in src-tauri/scrcpy-server.json and checked against its SHA-256
//   - with --with-adb: adb from Android platform-tools (from ANDROID_HOME, or Google's download)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "src-tauri", "resources");
const pin = JSON.parse(readFileSync(join(root, "src-tauri", "scrcpy-server.json"), "utf8"));

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchServer() {
  const target = join(resources, "scrcpy-server");
  if (existsSync(target) && sha256(readFileSync(target)) === pin.sha256) {
    console.log(`scrcpy-server ${pin.version}: already present and verified`);
    return;
  }
  console.log(`scrcpy-server ${pin.version}: downloading ${pin.url}`);
  const data = await download(pin.url);
  const actual = sha256(data);
  if (actual !== pin.sha256) {
    throw new Error(`scrcpy-server checksum mismatch: expected ${pin.sha256}, got ${actual}`);
  }
  mkdirSync(resources, { recursive: true });
  writeFileSync(target, data);
  console.log(`scrcpy-server ${pin.version}: verified (sha256 ${actual})`);
}

const ADB_FILES = ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt"];
const ADB_OPTIONAL = ["source.properties"];

async function fetchAdb() {
  const target = join(resources, "platform-tools");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  let source = sdk ? join(sdk, "platform-tools") : null;
  let temp = null;
  if (!source || !existsSync(join(source, "adb.exe"))) {
    const url = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
    console.log(`platform-tools: downloading ${url}`);
    const zip = await download(url);
    temp = mkdtempSync(join(tmpdir(), "stormcast-"));
    const zipPath = join(temp, "platform-tools.zip");
    writeFileSync(zipPath, zip);
    // Windows' own bsdtar extracts zip files; Git's GNU tar on PATH would not.
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", zipPath, "-C", temp]);
    source = join(temp, "platform-tools");
    console.log(`platform-tools: download sha256 ${sha256(zip)}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of ADB_FILES) copyFileSync(join(source, file), join(target, file));
  for (const file of ADB_OPTIONAL) {
    if (existsSync(join(source, file))) copyFileSync(join(source, file), join(target, file));
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
  const properties = join(target, "source.properties");
  const version = existsSync(properties)
    ? readFileSync(properties, "utf8").match(/Pkg\.Revision=(.+)/)?.[1]?.trim()
    : undefined;
  console.log(`platform-tools ${version ?? "(unknown version)"}: copied from ${source}`);
}

await fetchServer();
if (process.argv.includes("--with-adb")) await fetchAdb();
