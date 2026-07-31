/* Vendored from @amplib/hue-wheel @ another-machine/public-library 12d2a63
 * Do not edit. Regenerate with: node scripts/vendor-amplib.mjs
 */
// src/huePerception.ts
function linearize(channel) {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}
function hsvToLinearRgb(hue) {
  const x = 1 - Math.abs(hue / 60 % 2 - 1);
  let r, g, b;
  if (hue < 60) {
    r = 1;
    g = x;
    b = 0;
  } else if (hue < 120) {
    r = x;
    g = 1;
    b = 0;
  } else if (hue < 180) {
    r = 0;
    g = 1;
    b = x;
  } else if (hue < 240) {
    r = 0;
    g = x;
    b = 1;
  } else if (hue < 300) {
    r = x;
    g = 0;
    b = 1;
  } else {
    r = 1;
    g = 0;
    b = x;
  }
  return [linearize(r), linearize(g), linearize(b)];
}
function linearRgbToOklchHue(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const bAxis = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  let hue = Math.atan2(bAxis, a) * (180 / Math.PI);
  if (hue < 0) hue += 360;
  return hue;
}
var forward = new Float64Array(360);
for (let hue = 0; hue < 360; hue++) {
  const [r, g, b] = hsvToLinearRgb(hue);
  forward[hue] = linearRgbToOklchHue(r, g, b);
}
for (let i = 0; i < 360; i++) {
  let delta = forward[(i + 1) % 360] - forward[i];
  if (delta < 0) delta += 360;
  if (delta > 180) {
    const start = forward[i];
    let j = i + 1;
    while (j < i + 360) {
      let ahead = forward[j % 360] - start;
      if (ahead < 0) ahead += 360;
      if (ahead > 0 && ahead <= 180) break;
      j++;
    }
    let span = forward[j % 360] - start;
    if (span < 0) span += 360;
    const steps = j - i;
    for (let k = 1; k < steps; k++) {
      forward[(i + k) % 360] = (start + span * k / steps) % 360;
    }
    i = j - 1;
  }
}
var INVERSE_RESOLUTION = 7200;
var inverse = new Float64Array(INVERSE_RESOLUTION);
for (let index = 0; index < INVERSE_RESOLUTION; index++) {
  const degrees = index * (360 / INVERSE_RESOLUTION);
  let found = false;
  for (let hue = 0; hue < 360; hue++) {
    const start = forward[hue];
    const end = forward[(hue + 1) % 360];
    let delta = end - start;
    if (delta < 0) delta += 360;
    if (delta < 1e-9 || delta > 180) continue;
    let offset = degrees - start;
    if (offset < 0) offset += 360;
    if (offset < delta) {
      inverse[index] = hue + offset / delta;
      found = true;
      break;
    }
  }
  if (!found) {
    let best = 0;
    let bestDistance = 360;
    for (let hue = 0; hue < 360; hue++) {
      let distance = Math.abs(forward[hue] - degrees);
      if (distance > 180) distance = 360 - distance;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = hue;
      }
    }
    inverse[index] = best;
  }
}
function lerpAngle(from, to, t) {
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return ((from + t * delta) % 360 + 360) % 360;
}
function toPerceptual(hue) {
  const wrapped = (hue % 360 + 360) % 360;
  const index = Math.floor(wrapped) % 360;
  return lerpAngle(forward[index], forward[(index + 1) % 360], wrapped - index);
}
function fromPerceptual(hue) {
  const wrapped = (hue % 360 + 360) % 360;
  const scaled = wrapped * (INVERSE_RESOLUTION / 360);
  const index = Math.floor(scaled) % INVERSE_RESOLUTION;
  return lerpAngle(
    inverse[index],
    inverse[(index + 1) % INVERSE_RESOLUTION],
    scaled - index
  );
}
function worstRoundTripError(step = 0.25) {
  let worst = 0;
  for (let hue = 0; hue < 360; hue += step) {
    const returned = fromPerceptual(toPerceptual(hue));
    let error = Math.abs(returned - hue);
    if (error > 180) error = 360 - error;
    if (error > worst) worst = error;
  }
  return worst;
}

// src/parseSlotList.ts
function parseSlotList(input) {
  return input.split(/[,|]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

// src/Palette.ts
var Palette = class _Palette {
  rootHue;
  slotList;
  crossZone;
  listeners = [];
  cachedSlotHues = null;
  cachedBoundaryHues = null;
  constructor({ slots, rootHue = 0, crossZone = 0.15 }) {
    if (!slots || slots.length < 1) {
      throw new Error("Palette requires at least one slot.");
    }
    this.slotList = slots.map((value, index) => ({ index, value }));
    this.rootHue = (rootHue % 360 + 360) % 360;
    this.crossZone = Math.max(0, Math.min(0.5, crossZone));
  }
  invalidateCache() {
    this.cachedSlotHues = null;
    this.cachedBoundaryHues = null;
  }
  /** Degrees of perceptual hue per sector. */
  get sectorWidth() {
    return 360 / this.slotList.length;
  }
  /** Which slot a display hue lands in, and where inside its sector. */
  hueToSlot(displayHue) {
    const count = this.slotList.length;
    const perceptual = ((toPerceptual(displayHue) - this.rootHue) % 360 + 360) % 360;
    const width = this.sectorWidth;
    const position = perceptual / width;
    const index = Math.min(count - 1, Math.floor(position));
    return { slot: this.slotList[index], t: position - index };
  }
  /**
   * The same lookup, but blended across a sector boundary.
   *
   * Without this a hue drifting past a boundary would switch slots instantly.
   * The weight tops out at 0.5 rather than 1, so a slot never loses its
   * majority to a neighbour — at the boundary itself the two are equal and the
   * transition has no discontinuity.
   *
   * Repeated adjacent values are one continuous band, so no blending happens
   * between them. Crossfading a value with itself would return the same thing
   * twice at half weight each, which reads downstream as a two-slot mix when
   * nothing is actually changing.
   */
  hueToBlend(displayHue) {
    const count = this.slotList.length;
    if (count === 1) return [{ slot: this.slotList[0], weight: 1 }];
    const { slot, t } = this.hueToSlot(displayHue);
    const index = slot.index;
    const blendWith = (neighbourIndex, weight) => {
      const neighbour = this.slotList[neighbourIndex];
      if (neighbour.value === slot.value) {
        return [{ slot, weight: 1 }];
      }
      return [
        { slot, weight: 1 - weight },
        { slot: neighbour, weight }
      ];
    };
    if (t < this.crossZone) {
      return blendWith(
        (index - 1 + count) % count,
        (this.crossZone - t) / this.crossZone * 0.5
      );
    }
    if (t > 1 - this.crossZone) {
      return blendWith(
        (index + 1) % count,
        (t - (1 - this.crossZone)) / this.crossZone * 0.5
      );
    }
    return [{ slot, weight: 1 }];
  }
  /** The display hue at position `t` within slot `index`. */
  slotToHue(index, t = 0.5) {
    const count = this.slotList.length;
    const wrapped = (index % count + count) % count;
    const width = this.sectorWidth;
    const perceptual = (((wrapped + t) * width + this.rootHue) % 360 + 360) % 360;
    return fromPerceptual(perceptual);
  }
  get slots() {
    return this.slotList;
  }
  /** The values alone, in wheel order. */
  get values() {
    return this.slotList.map((slot) => slot.value);
  }
  /** The display hue at the centre of each sector. */
  get slotHues() {
    if (!this.cachedSlotHues) {
      this.cachedSlotHues = Float32Array.from(
        { length: this.slotList.length },
        (_, index) => this.slotToHue(index, 0.5)
      );
    }
    return this.cachedSlotHues;
  }
  /** The display hue at every sector boundary, wrapping back to the first. */
  get slotBoundaryHues() {
    if (!this.cachedBoundaryHues) {
      const count = this.slotList.length;
      this.cachedBoundaryHues = Float32Array.from(
        { length: count + 1 },
        (_, index) => this.slotToHue(index === count ? 0 : index, 0)
      );
    }
    return this.cachedBoundaryHues;
  }
  /**
   * Runs of adjacent sectors sharing a value, merged — the bands you would
   * actually draw or label. Wraps, so a run spanning 0° is one band.
   *
   * `["g1","g2","g2","g1","g3"]` gives four bands, not five: the two g2
   * sectors are one double-width band, while the two g1 sectors stay separate
   * because g2 sits between them.
   */
  get bands() {
    const count = this.slotList.length;
    const values = this.values;
    const allSame = values.every((value) => value === values[0]);
    let start = 0;
    if (!allSame) {
      for (let i = 0; i < count; i++) {
        if (values[(i - 1 + count) % count] !== values[i]) {
          start = i;
          break;
        }
      }
    }
    const bands = [];
    for (let step = 0; step < count; step++) {
      const index = (start + step) % count;
      const previous = bands[bands.length - 1];
      if (previous && previous.value === values[index]) {
        previous.indices.push(index);
      } else {
        bands.push({ value: values[index], indices: [index], centreHue: 0 });
      }
    }
    for (const band of bands) {
      const first = band.indices[0];
      const span = band.indices.length;
      band.centreHue = this.slotToHue(first, span / 2);
    }
    return bands;
  }
  setRootHue(hue) {
    this.rootHue = (hue % 360 + 360) % 360;
    this.invalidateCache();
    this.emit();
  }
  setSlots(slots) {
    if (!slots || slots.length < 1) {
      throw new Error("Palette requires at least one slot.");
    }
    this.slotList = slots.map((value, index) => ({ index, value }));
    this.invalidateCache();
    this.emit();
  }
  setCrossZone(crossZone) {
    this.crossZone = Math.max(0, Math.min(0.5, crossZone));
    this.emit();
  }
  /** Subscribe to changes. Returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }
  emit() {
    for (const listener of this.listeners) listener(this);
  }
  /** Build a Palette of plain string slots from a comma-separated list. */
  static fromString(input, { rootHue = 0, crossZone = 0.15 } = {}) {
    return new _Palette({
      slots: parseSlotList(input),
      rootHue,
      crossZone
    });
  }
  /**
   * A new Palette with the same geometry and every slot's value transformed.
   *
   * This is the seam where domain meaning gets attached — parse strings into
   * chords, resolve names to samples — so the wheel stays generic while the
   * consumer gets a typed palette back.
   *
   * Equal inputs are transformed once and share the result. That is not just
   * an optimisation: `bands` and `hueToBlend` decide what counts as the same
   * slot by identity, so mapping "CEG" twice into two equal-but-separate
   * objects would silently split one band in two and start crossfading a value
   * with itself. `transform` is therefore called once per distinct value, not
   * once per sector.
   */
  map(transform) {
    const memo = /* @__PURE__ */ new Map();
    return new _Palette({
      slots: this.slotList.map((slot) => {
        if (memo.has(slot.value)) return memo.get(slot.value);
        const mapped = transform(slot.value, slot.index);
        memo.set(slot.value, mapped);
        return mapped;
      }),
      rootHue: this.rootHue,
      crossZone: this.crossZone
    });
  }
};
export {
  Palette,
  fromPerceptual,
  parseSlotList,
  toPerceptual,
  worstRoundTripError
};
//# sourceMappingURL=index.js.map