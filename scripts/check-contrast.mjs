#!/usr/bin/env node
// Checks WCAG contrast of the solid skin's colour pairs in light and dark (COL-01, COL-02, QA-02).
// Reads src/styles/tokens.css: `:root` blocks at the top level are light, `:root` inside
// `@media (prefers-color-scheme: dark)` is dark. Glass panels are translucent, so they are
// checked by hand over a white and a black desktop (see docs/DESIGN-BRIEF.md).
import { readFileSync } from "node:fs";

const DARK_MEDIA = "@media (prefers-color-scheme: dark)";
const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function collect(source) {
  const light = {};
  const dark = {};
  const stack = [];
  let buffer = "";
  for (const char of source) {
    if (char === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (char === "}") {
      const selector = stack.pop();
      const target = selector !== ":root" ? null : stack.length === 0 ? light : stack.at(-1) === DARK_MEDIA ? dark : null;
      if (target) for (const [, name, value] of buffer.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) target[name] = value.trim();
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return { light, dark };
}

const { light, dark } = collect(css);

function resolve(name, theme) {
  const lookup = (key) => (theme === "dark" ? (dark[key] ?? light[key]) : light[key]);
  let value = lookup(name);
  for (let depth = 0; depth < 10 && value; depth++) {
    const reference = value.match(/^var\((--[\w-]+)\)$/);
    if (!reference) break;
    value = lookup(reference[1]);
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} (${theme}) is not a hex colour: ${value}`);
  return value;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum, what]
const pairs = [
  ["--color-text", "--color-bg", 4.5, "text on background"],
  ["--color-text", "--color-surface", 4.5, "text on panel"],
  ["--color-text-muted", "--color-surface", 4.5, "muted text on panel"],
  ["--color-on-accent", "--color-accent", 4.5, "text on accent button"],
  ["--color-danger", "--color-surface", 4.5, "danger text on panel"],
  ["--color-success", "--color-surface", 4.5, "ready chip on panel"],
  ["--color-attention", "--color-surface", 4.5, "attention chip on panel"],
  ["--color-accent", "--color-surface", 3, "accent control on panel"],
  ["--color-border-strong", "--color-surface", 3, "control border on panel"],
  ["--color-focus", "--color-bg", 3, "focus ring on background"],
  ["--color-focus", "--color-surface", 3, "focus ring on panel"],
  ["--mirror-control-ring", "--color-bg", 3, "control ring around the screen"],
  ["--toggle-on-border", "--color-surface", 3, "border of a toggle that is on"],
  ["--color-text", "--color-surface-solid", 4.5, "tooltip text"],
];

let failed = 0;
for (const theme of ["light", "dark"]) {
  for (const [fg, bg, minimum, what] of pairs) {
    const ratio = contrast(resolve(fg, theme), resolve(bg, theme));
    const ok = ratio >= minimum;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${theme.padEnd(5)} ${ratio.toFixed(2).padStart(5)}:1 (min ${minimum}) ${what}`);
  }
}
if (failed) {
  console.error(`${failed} colour pair(s) below the minimum contrast`);
  process.exit(1);
}
