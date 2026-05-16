/**
 * modules/color.js
 *
 * Pure color math utilities. No DOM, no state.
 */

/**
 * Convert RGB (0–255 each) to HSV.
 * @returns {[number, number, number]} [hue 0–360, saturation 0–1, value 0–1]
 */
export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;

  let h = 0;
  if (d !== 0) {
    if (mx === r)      h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else               h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = mx === 0 ? 0 : d / mx;
  return [h, s, mx]; // [hue, saturation, value]
}

/**
 * Luma coefficient (BT.601) for a single channel byte.
 * Use as: luma(px[i], px[i+1], px[i+2])
 */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Named hue ranges (boundary, name). Ordered ascending by boundary degree. */
export const HUE_NAMES = [
  [15,  "RED"],
  [45,  "ORANGE"],
  [70,  "YELLOW"],
  [160, "GREEN"],
  [200, "CYAN"],
  [255, "BLUE"],
  [290, "VIOLET"],
  [330, "MAGENTA"],
  [360, "RED"],
];

/**
 * Return a display name for a hue angle (0–360°).
 * @param {number} h
 * @returns {string}
 */
export function hueName(h) {
  for (const [cutoff, name] of HUE_NAMES) {
    if (h <= cutoff) return name;
  }
  return "RED";
}
