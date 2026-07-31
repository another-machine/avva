/* Vendored from @amplib/hue-wheel @ another-machine/public-library 12d2a63
 * Do not edit. Regenerate with: node scripts/vendor-amplib.mjs
 */
interface PaletteSlot<T> {
    /** Position in the slot array. */
    index: number;
    /** Whatever this slot stands for. The wheel never inspects it. */
    value: T;
}
interface HueSlotResult<T> {
    slot: PaletteSlot<T>;
    /** Position within the slot's sector, 0 at its start and 1 at its end. */
    t: number;
}
interface HueBlendResult<T> {
    slot: PaletteSlot<T>;
    weight: number;
}
interface PaletteParams<T> {
    /**
     * One entry per sector, in order around the wheel. Every sector is the same
     * width, so a value is weighted by repeating it.
     */
    slots: T[];
    /** Rotates the whole wheel. In perceptual degrees. */
    rootHue?: number;
    /** Fraction of a sector at each edge that blends into its neighbour. */
    crossZone?: number;
}
/**
 * A hue wheel divided into equal sectors, so that any hue names a slot and any
 * slot names a hue.
 *
 * Weight is repetition, not a number. `["g1", "g2", "g2", "g3"]` gives g2 twice
 * the arc of its neighbours because it is written twice, and the list reads as
 * the wheel it describes rather than as a set of multipliers to work out. It
 * also makes something a bias field could not express: a value can appear at
 * more than one place on the wheel. In `["g1", "g2", "g2", "g1", "g3"]` the two
 * g1 sectors are separated by g2, so g1 is reachable from two different regions
 * of colour without being one continuous band.
 *
 * Slots carry whatever you put in them — a chord, a word list, a sample. `T` is
 * opaque on purpose: deciding what a hue *means* belongs to the consuming
 * application, and baking one meaning in here would rule the others out.
 *
 * Sector boundaries are computed in perceptual hue space, not display hue, so
 * equal sectors take arcs that *look* equal rather than arcs that are equal in
 * HSV and visibly lopsided.
 */
declare class Palette<T = string> {
    rootHue: number;
    private slotList;
    private crossZone;
    private listeners;
    private cachedSlotHues;
    private cachedBoundaryHues;
    constructor({ slots, rootHue, crossZone }: PaletteParams<T>);
    private invalidateCache;
    /** Degrees of perceptual hue per sector. */
    private get sectorWidth();
    /** Which slot a display hue lands in, and where inside its sector. */
    hueToSlot(displayHue: number): HueSlotResult<T>;
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
    hueToBlend(displayHue: number): HueBlendResult<T>[];
    /** The display hue at position `t` within slot `index`. */
    slotToHue(index: number, t?: number): number;
    get slots(): PaletteSlot<T>[];
    /** The values alone, in wheel order. */
    get values(): T[];
    /** The display hue at the centre of each sector. */
    get slotHues(): Float32Array;
    /** The display hue at every sector boundary, wrapping back to the first. */
    get slotBoundaryHues(): Float32Array;
    /**
     * Runs of adjacent sectors sharing a value, merged — the bands you would
     * actually draw or label. Wraps, so a run spanning 0° is one band.
     *
     * `["g1","g2","g2","g1","g3"]` gives four bands, not five: the two g2
     * sectors are one double-width band, while the two g1 sectors stay separate
     * because g2 sits between them.
     */
    get bands(): {
        value: T;
        indices: number[];
        centreHue: number;
    }[];
    setRootHue(hue: number): void;
    setSlots(slots: T[]): void;
    setCrossZone(crossZone: number): void;
    /** Subscribe to changes. Returns an unsubscribe function. */
    onChange(listener: (palette: Palette<T>) => void): () => void;
    private emit;
    /** Build a Palette of plain string slots from a comma-separated list. */
    static fromString(input: string, { rootHue, crossZone }?: {
        rootHue?: number | undefined;
        crossZone?: number | undefined;
    }): Palette<string>;
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
    map<U>(transform: (value: T, index: number) => U): Palette<U>;
}

/**
 * A bijective mapping between display hue and perceptual hue.
 *
 * HSV hue is what a camera reports and what people use to name a colour on a
 * screen. Oklch hue — atan2(b, a) of oklab — is the angle human vision reads
 * as evenly spaced. Both run 0–360°, but the mapping between them is severely
 * non-linear, and not in the direction most descriptions of it suggest.
 * Measured as perceptual degrees per display degree:
 *
 *   red 0.21×   orange 1.76×   yellow 1.29×   green 0.05×
 *   cyan 2.23×  blue 0.14×     deep blue 0.01×  magenta 0.94×
 *
 * Green and deep blue barely move at all — a wide sweep of display hue is
 * almost one perceptual colour — while cyan and orange stretch. The spread
 * between the extremes is over two hundredfold.
 *
 * That is the whole reason this file exists. Divide a hue wheel into equal
 * slices in HSV and the slices do not look equal; divide it in oklch and they
 * do.
 */
/** Display (HSV) hue → perceptual (oklch) hue. */
declare function toPerceptual(hue: number): number;
/** Perceptual (oklch) hue → display (HSV) hue. */
declare function fromPerceptual(hue: number): number;
/**
 * Worst round-trip error in degrees, sampled every `step` degrees.
 *
 * The two tables are built by different methods and only approximately invert
 * each other, so this is the number that says whether they still agree. It is
 * exported rather than run on import: a library that asserts at load time
 * costs every consumer the check whether or not they care, and cannot fail the
 * build when it matters. See `npm test`.
 */
declare function worstRoundTripError(step?: number): number;

/**
 * Split a comma- or pipe-separated list into slot values.
 *
 *   parseSlotList("g1,g2,g2,g1,g3")  // ["g1","g2","g2","g1","g3"]
 *
 * There is no weight syntax, because there is no weight field. A slot is
 * wider because it appears more times, which means the written list already
 * looks like the wheel it describes.
 *
 * Empty entries are dropped rather than becoming empty slots, so a trailing
 * comma or a double comma in a hand-edited URL is harmless.
 */
declare function parseSlotList(input: string): string[];

export { type HueBlendResult, type HueSlotResult, Palette, type PaletteParams, type PaletteSlot, fromPerceptual, parseSlotList, toPerceptual, worstRoundTripError };
