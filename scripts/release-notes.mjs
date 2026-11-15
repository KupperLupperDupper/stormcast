#!/usr/bin/env node
// Prints the release notes for a version: its section in CHANGELOG.md, then how to check a download.
// Exits with 1 when CHANGELOG.md has no section for the version, so no release goes out without one.
//   node scripts/release-notes.mjs 0.1.0 > notes.md
import { readFileSync } from "node:fs";

const version = process.argv[2];
const repo = process.env.GITHUB_REPOSITORY ?? "KupperLupperDupper/stormcast";
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}. Add it before tagging.`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
// The section ends at the next version or at the link references at the bottom.
const end = rest.findIndex((line) => line.startsWith("## [") || /^\[[^\]]+\]: /.test(line));
const section = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
if (!section) {
  console.error(`The section for ${version} in CHANGELOG.md is empty.`);
  process.exit(1);
}

console.log(`${section}

---

Check a download with \`gh attestation verify <file> --repo ${repo}\`, or compare its SHA-256 with the one in \`SHA256SUMS.txt\`.`);
