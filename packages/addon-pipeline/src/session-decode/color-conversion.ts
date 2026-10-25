/**
 * Explicit YUV→RGB colorspace/range resolution for the session-decode worker.
 *
 * WHY THIS EXISTS (RC-5, `docs/superpowers/specs/2026-07-19-track-media-bugs-analysis.md`):
 * an intermittent ~one-GOP DESATURATED stretch was measured on cam 101 — the
 * classic "limited-range YUV interpreted as full-range" signature (lifted
 * blacks, washed color, JPEG size collapse). Root cause: NONE of the decode
 * worker's YUV→RGB conversion sites pinned an explicit colorspace/range, so the
 * conversion depended on whatever `colorspace`/`color_range` metadata each
 * decoded frame happened to carry. A GOP replayed/decoded by a DIFFERENT path
 * (hwaccel-cascade / keyframe-seed fallback, see `docs/design/decode-path.md`)
 * can carry UNSPECIFIED (or a different) range, which the libav auto-inserted
 * converter then guesses differently than its neighbours → one washed-out GOP,
 * then a snap back.
 *
 * The fix is to resolve every frame's source color to an EXPLICIT
 * `(matrix, range)` — using the frame's own tags when present, and a STABLE
 * default (bt709 / limited, the typical H.264/H.265 HD signalling) when they
 * are unspecified — and to pin the conversion to that + full-range RGB output
 * IDENTICALLY at every site. An unspecified/fallback GOP then converts exactly
 * like its neighbours instead of being auto-guessed, so the desaturation cannot
 * recur regardless of which decode path produced the GOP.
 *
 * These functions operate on the raw FFmpeg `AVColorSpace` / `AVColorRange`
 * enum integers (stable ABI values) so they are unit-testable without loading
 * node-av. node-av's branded `AVColorSpace`/`AVColorRange` are `number`
 * subtypes and pass through directly.
 */

/**
 * FFmpeg `AVColorSpace` enum values we map to a libswscale/`scale`-filter
 * `in_color_matrix` token. Stable ABI integers (libavutil `pixfmt.h`).
 */
const AVCOL_SPC_BT709 = 1
const AVCOL_SPC_FCC = 4
const AVCOL_SPC_BT470BG = 5
const AVCOL_SPC_SMPTE170M = 6
const AVCOL_SPC_SMPTE240M = 7
const AVCOL_SPC_BT2020_NCL = 9
const AVCOL_SPC_BT2020_CL = 10

/** FFmpeg `AVColorRange` enum values. Stable ABI integers. */
const AVCOL_RANGE_MPEG = 1 // limited / "tv" (16-235)
const AVCOL_RANGE_JPEG = 2 // full / "pc" (0-255)

/** libswscale / `scale`-filter YCbCr matrix token. */
export type SwsColorMatrix = 'bt709' | 'bt601' | 'fcc' | 'smpte240m' | 'bt2020nc'

/** libswscale / `scale`-filter color-range token. */
export type SwsColorRange = 'limited' | 'full'

/**
 * Default source matrix when the frame carries no (or an unusable) colorspace
 * tag — bt709, the near-universal signalling for HD H.264/H.265 IP cameras.
 */
export const DEFAULT_COLOR_MATRIX: SwsColorMatrix = 'bt709'

/**
 * Default source range when the frame carries no (or an unspecified) range tag
 * — limited/mpeg, the near-universal signalling for camera video. Guessing
 * full here is the exact mistake that produced the desaturated GOP.
 */
export const DEFAULT_COLOR_RANGE: SwsColorRange = 'limited'

/**
 * Output RGB range — always FULL (0-255). Every RGB conversion site converges
 * on this so downstream media/inference sees a single, path-independent RGB
 * contract.
 */
export const OUTPUT_RGB_RANGE: SwsColorRange = 'full'

/**
 * `AV_OPT`-integer for libswscale `src_range`/`dst_range` from a token
 * (0 = limited/mpeg, 1 = full/jpeg).
 */
export function swsRangeFlag(range: SwsColorRange): 0 | 1 {
  return range === 'full' ? 1 : 0
}

/** Map an `AVColorSpace` enum integer to a `scale`-filter matrix token. */
export function resolveColorMatrix(colorSpace: number): SwsColorMatrix {
  switch (colorSpace) {
    case AVCOL_SPC_BT709:
      return 'bt709'
    case AVCOL_SPC_BT470BG:
    case AVCOL_SPC_SMPTE170M:
      return 'bt601'
    case AVCOL_SPC_FCC:
      return 'fcc'
    case AVCOL_SPC_SMPTE240M:
      return 'smpte240m'
    case AVCOL_SPC_BT2020_NCL:
    case AVCOL_SPC_BT2020_CL:
      return 'bt2020nc'
    default:
      // AVCOL_SPC_RGB(0) / UNSPECIFIED(2) / RESERVED(3) / exotic → stable default.
      return DEFAULT_COLOR_MATRIX
  }
}

/** Map an `AVColorRange` enum integer to a `scale`-filter range token. */
export function resolveColorRange(colorRange: number): SwsColorRange {
  switch (colorRange) {
    case AVCOL_RANGE_JPEG:
      return 'full'
    case AVCOL_RANGE_MPEG:
      return 'limited'
    default:
      // AVCOL_RANGE_UNSPECIFIED(0) → stable default (the fallback-GOP case).
      return DEFAULT_COLOR_RANGE
  }
}

/** The explicit source color a conversion site pins, plus the raw frame tags. */
export interface ResolvedSourceColor {
  /** `scale`-filter `in_color_matrix` token to pin the YUV coefficients. */
  readonly inColorMatrix: SwsColorMatrix
  /** `scale`-filter `in_range` token to pin how the source Y is interpreted. */
  readonly inRange: SwsColorRange
  /** `true` when the frame carried no usable colorspace tag (default applied). */
  readonly colorSpaceDefaulted: boolean
  /** `true` when the frame carried no usable range tag (default applied). */
  readonly colorRangeDefaulted: boolean
  /** Raw `AVColorSpace` integer the frame carried (provenance). */
  readonly rawColorSpace: number
  /** Raw `AVColorRange` integer the frame carried (provenance). */
  readonly rawColorRange: number
}

/**
 * Resolve a frame's `(colorSpace, colorRange)` tags to the explicit
 * `(matrix, range)` every conversion site pins — applying the stable defaults
 * when a tag is unspecified/unusable.
 */
export function resolveSourceColor(colorSpace: number, colorRange: number): ResolvedSourceColor {
  const matrix = resolveColorMatrix(colorSpace)
  const range = resolveColorRange(colorRange)
  const knownSpace =
    colorSpace === AVCOL_SPC_BT709 ||
    colorSpace === AVCOL_SPC_BT470BG ||
    colorSpace === AVCOL_SPC_SMPTE170M ||
    colorSpace === AVCOL_SPC_FCC ||
    colorSpace === AVCOL_SPC_SMPTE240M ||
    colorSpace === AVCOL_SPC_BT2020_NCL ||
    colorSpace === AVCOL_SPC_BT2020_CL
  const knownRange = colorRange === AVCOL_RANGE_JPEG || colorRange === AVCOL_RANGE_MPEG
  return {
    inColorMatrix: matrix,
    inRange: range,
    colorSpaceDefaulted: !knownSpace,
    colorRangeDefaulted: !knownRange,
    rawColorSpace: colorSpace,
    rawColorRange: colorRange,
  }
}

/**
 * The `scale`-filter option fragment that pins the explicit YUV→(full)RGB
 * conversion — appended to a `scale=...` filter in the GPU/CPU filtergraph
 * (`scale=W:H:<fragment>` or `scale=<fragment>` for an identity-size convert).
 * Always converges output on full-range RGB; `out_color_matrix` is intentionally
 * omitted (irrelevant for an RGB/gray packed output).
 */
export function colorConvertFilterOptions(resolved: ResolvedSourceColor): string {
  return `in_color_matrix=${resolved.inColorMatrix}:in_range=${resolved.inRange}:out_range=${OUTPUT_RGB_RANGE}`
}

/**
 * A stable cache key for the resolved source color — folded into the GPU
 * filtergraph key so a mid-session colorspace/range change rebuilds the graph
 * (and re-emits the provenance transition marker) instead of reusing a graph
 * pinned to the old color.
 */
export function sourceColorKey(resolved: ResolvedSourceColor): string {
  return `${resolved.inColorMatrix}:${resolved.inRange}`
}

/** Decode/scale path a converted frame came from — for provenance logging. */
export type DecodeScalePath = 'hw-fullframe' | 'hw-crop' | 'sw-fullframe' | 'sw-crop'

/**
 * One-line provenance marker: which decode/scale path produced a frame + the
 * (raw and resolved) source color it was converted with. Emitted on a color
 * TRANSITION (rare, diagnostic-gold: pinpoints an intermittent recurrence) and,
 * behind the debug flag, per frame. Includes a trailing newline for `emitStderr`.
 */
export function colorProvenanceLine(
  path: DecodeScalePath,
  resolved: ResolvedSourceColor,
  transition: boolean,
): string {
  const spaceTag = resolved.colorSpaceDefaulted
    ? `${resolved.rawColorSpace}->${resolved.inColorMatrix}(default)`
    : `${resolved.rawColorSpace}->${resolved.inColorMatrix}`
  const rangeTag = resolved.colorRangeDefaulted
    ? `${resolved.rawColorRange}->${resolved.inRange}(default)`
    : `${resolved.rawColorRange}->${resolved.inRange}`
  return (
    `session-decode color${transition ? ' TRANSITION' : ''} ` +
    `{path:${path}, colorSpace:${spaceTag}, colorRange:${rangeTag}, out:rgb-${OUTPUT_RGB_RANGE}}\n`
  )
}
