/**
 * Tooltips for icon buttons, which carry their name in aria-label (CMP-14). A tooltip shows on
 * mouse hover and on keyboard focus, in the root overlay next to its button (LAY-08), and never
 * over the mirrored screen. Esc closes it without moving focus, the pointer can move onto it,
 * and it never closes by itself (A11Y-05).
 */
import { h } from "./dom";

const HOVER_DELAY_MS = 500;

let tip: HTMLElement | null = null;
let owner: HTMLElement | null = null;
let timer = 0;

/** Gives the button a tooltip with its aria-label, or its data-tooltip when it has one. */
export function withTooltip<T extends HTMLElement>(trigger: T): T {
  trigger.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => show(trigger), HOVER_DELAY_MS);
  });
  trigger.addEventListener("pointerleave", (event) => {
    if (event.relatedTarget !== tip) hideTooltip(trigger);
  });
  trigger.addEventListener("focus", () => {
    if (trigger.matches(":focus-visible")) show(trigger);
  });
  trigger.addEventListener("blur", () => hideTooltip(trigger));
  trigger.addEventListener("pointerdown", () => hideTooltip(trigger));
  return trigger;
}

/** Hides the tooltip, or only when it belongs to the given button. */
export function hideTooltip(trigger?: HTMLElement): void {
  window.clearTimeout(timer);
  if (!tip || !owner || (trigger && trigger !== owner)) return;
  tip.hidden = true;
  owner = null;
}

function show(trigger: HTMLElement) {
  if (!trigger.isConnected) return;
  tip ??= createTip();
  // data-tooltip adds to the name, for example the shortcut; it starts with the name (TXT-07).
  tip.textContent = trigger.dataset.tooltip ?? trigger.getAttribute("aria-label");
  tip.hidden = false;
  owner = trigger;
  place(tip, trigger);
}

function createTip(): HTMLElement {
  // The button already has the name, so screen readers do not hear it twice.
  const element = h("div", { class: "tooltip", "aria-hidden": "true", hidden: true });
  element.addEventListener("pointerleave", (event) => {
    if (!(event.relatedTarget instanceof Node && owner?.contains(event.relatedTarget))) hideTooltip();
  });
  document.addEventListener("keydown", (event) => event.key === "Escape" && hideTooltip(), true);
  window.addEventListener("resize", () => tip && owner && place(tip, owner));
  document.body.append(element);
  return element;
}

/**
 * Under the button, or over it when there is no room or the mirrored screen is in the way, and
 * inside the window. The tooltip's top margin is the gap to the button.
 */
/**
 * Below the button, else above, else beside it, wherever it fits in the window and covers no
 * mirrored screen (B-014).
 */
function place(element: HTMLElement, trigger: HTMLElement) {
  const gap = parseFloat(getComputedStyle(element).marginTop);
  const button = trigger.getBoundingClientRect();
  const { width, height } = element.getBoundingClientRect();
  const screens = [...document.querySelectorAll(".screen__video")].map((screen) => screen.getBoundingClientRect());
  const centeredLeft = Math.max(gap, Math.min(button.left + (button.width - width) / 2, window.innerWidth - width - gap));
  const middleTop = Math.max(gap, Math.min(button.top + (button.height - height) / 2, window.innerHeight - height - gap));
  const spots = [
    { left: centeredLeft, top: button.bottom + gap },
    { left: centeredLeft, top: button.top - gap - height },
    { left: button.left - gap - width, top: middleTop },
    { left: button.right + gap, top: middleTop },
  ];
  const fits = (spot: { left: number; top: number }) =>
    spot.left >= 0 &&
    spot.top >= 0 &&
    spot.left + width <= window.innerWidth &&
    spot.top + height <= window.innerHeight &&
    screens.every(
      (screen) =>
        spot.left >= screen.right ||
        spot.left + width <= screen.left ||
        spot.top >= screen.bottom ||
        spot.top + height <= screen.top,
    );
  const spot = spots.find(fits) ?? spots[0];
  element.style.left = `${spot.left}px`;
  // The tooltip's top margin is the gap, and it pushes the box down by itself.
  element.style.top = `${spot.top - gap}px`;
}
