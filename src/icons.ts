/**
 * Icons on a 24 × 24 grid, drawn as lines in the text colour, so they follow the theme and high
 * contrast. As an icon file it holds raw values (TOK-01). The shapes are Android's own symbols.
 */
import type { DeviceButton } from "./ipc";

const SVG = "http://www.w3.org/2000/svg";

export type IconName = DeviceButton | "soundOn" | "soundOff" | "fullScreen" | "exitFullScreen";

/** A speaker. */
const SPEAKER = "M4 9.5h3.5L12 5.5v13l-4.5-4H4z";

const shapes: Record<IconName, string[]> = {
  // Android's navigation bar: a triangle, a circle and a square.
  back: ["M15.5 5.5 7 12l8.5 6.5z"],
  home: ["M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14z"],
  recentApps: ["M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"],
  // The power symbol: a broken circle and a line.
  power: ["M12 3.5v8", "M7.18 7.26A7.5 7.5 0 1 0 16.82 7.26"],
  // Sound on the PC: a speaker with sound waves; off: a speaker with a cross.
  soundOn: [SPEAKER, "M15.5 9a4 4 0 0 1 0 6", "M18.5 6.5a7.5 7.5 0 0 1 0 11"],
  soundOff: [SPEAKER, "M16 9.5l5 5", "M21 9.5l-5 5"],
  // Full screen: four corners pointing out; leaving it: the same corners pointing in.
  fullScreen: ["M4 9V4h5", "M15 4h5v5", "M20 15v5h-5", "M9 20H4v-5"],
  exitFullScreen: ["M9 4v5H4", "M20 9h-5V4", "M15 20v-5h5", "M4 15h5v5"],
};

/** A decorative icon: the button around it carries the name. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  const attributes = {
    class: "icon",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  for (const d of shapes[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
