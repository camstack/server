/**
 * A model-free appearance descriptor of one detection box (D683 §8).
 *
 * Computed on the runner from the analysis raster the frame already leased
 * (`pipeline-runner/appearance-descriptor.ts`), carried on `ObjectDetection`
 * and mirrored onto the tracker's `SpatialDetection`. A vector about a box,
 * never pixels (D9/D18). No learned weights, so no licence question (O6).
 *
 * Layout: the box shrunk 10 % per side, split into an upper and a lower half;
 * per half a hue–saturation histogram (8 hue × 4 saturation), a value histogram
 * (8) and a magnitude-weighted gradient-orientation histogram (8). Each block
 * is L1-normalised and quantised to integers 0–255. About 300 bytes of JSON.
 */
export const APPEARANCE_DESCRIPTOR_VERSION = 1
export const APPEARANCE_BIN_COUNT = 96

export const APPEARANCE_BLOCKS = {
  upperHs: [0, 32],
  upperV: [32, 40],
  upperGrad: [40, 48],
  lowerHs: [48, 80],
  lowerV: [80, 88],
  lowerGrad: [88, 96],
} as const

export type AppearanceBlockName = keyof typeof APPEARANCE_BLOCKS

export interface AppearanceDescriptor {
  readonly version: 1
  /** {@link APPEARANCE_BIN_COUNT} integers, laid out by {@link APPEARANCE_BLOCKS}. */
  readonly bins: readonly number[]
  /** The view carries no colour (IR / greyscale / near-black): hue–saturation says nothing. */
  readonly gray: boolean
}

/**
 * Whether appearance may influence anything at all (D683 §3.2, fix round 1
 * ruling 2026-09-30 on the Task 10 cost-bench STOP): OFF until the
 * descriptor is calibrated on tapes that carry it (Task 23, review M9).
 *
 * This is the ONE authority both addons read — never two settings that
 * could disagree (CLAUDE.md D62). The tracker's `TrackerV2Config.appearanceResolvesAmbiguity`
 * default reads it (`addon-post-analysis/pipeline/tracker-v2/types.ts`); the
 * runner's cost gate reads it too (`addon-pipeline/pipeline-runner/appearance-attach.ts`),
 * short-circuiting BEFORE any crop, resample or descriptor is computed, so a
 * disabled camera costs nothing extra per frame.
 */
export const APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT = false
