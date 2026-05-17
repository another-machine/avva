/** Pure color utilities — no DOM / Audio deps. */

/** Convert sRGB [0..255] to HSV. Returns [hue 0-360, sat 0-1, val 0-1]. */
export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + 6) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

/** BT.601 luma from sRGB [0..255]. Returns 0-1. */
export function luma(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Named hue ranges for display. [start°, name] — each extends until the next entry. */
export const HUE_NAMES: [number, string][] = [
  [0, "red"],
  [15, "orange"],
  [40, "yellow"],
  [70, "yellow-green"],
  [90, "green"],
  [150, "cyan"],
  [180, "sky"],
  [210, "blue"],
  [250, "violet"],
  [280, "magenta"],
  [320, "rose"],
  [345, "red"],
];

/** Return the name of the nearest named hue. */
export function hueName(h: number): string {
  const norm = ((h % 360) + 360) % 360;
  let name = HUE_NAMES[HUE_NAMES.length - 1][1];
  for (const [start, n] of HUE_NAMES) {
    if (norm >= start) name = n;
  }
  return name;
}
