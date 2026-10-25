/**
 * THE detail-crop convention — the single derivation of the rectangle a
 * detail/enrichment step (clip-embedding, face-detection, plate-detection…)
 * is fed.
 *
 * ## Why this is one module and not two constants
 *
 * `object-clip` is ONE vector index, and cosine similarity is only meaningful
 * between vectors produced from the same crop convention. Two encode paths
 * write into it — the live detail plane and the embedding rebuild — and they
 * used to derive their crops independently: `DETAIL_CROP_PADDING_RATIO = 0.15`
 * with no squaring on one side, `DEFAULT_CROP_MARGIN = 0.2` with squaring on
 * by default on the other. Every rebuild therefore poured a second, silently
 * incomparable feature space into the index it exists to keep consistent.
 *
 * So the rectangle is derived HERE, once, from ONE convention value. Both
 * paths now reach this function through `pipelineRunner.runDetailSubtree` —
 * the runner is the only process that cuts (see `detail-subtree.ts`), and the
 * convention is a cluster-global `pipeline-orchestrator` setting. There is
 * deliberately no per-node or per-device scope: a per-accelerator crop margin
 * would reintroduce the same split, merely relocated.
 *
 * ## The default IS the live convention
 *
 * {@link DEFAULT_DETAIL_CROP_CONVENTION} reproduces what the live path has
 * been storing (0.15, no squaring). Anything else would invalidate every
 * vector already in the index on the day it shipped. Changing the convention
 * is legitimate — that is what the operator knob is for — but it must be
 * followed by a rebuild, which is now guaranteed to produce crops from this
 * same function.
 */
import { z } from 'zod'

/**
 * Store identity of the convention in `pipeline-orchestrator`'s GLOBAL
 * (cluster-wide) settings.
 *
 * These live here rather than in the orchestrator because the reader is a
 * different addon — the pipeline runner, over the hub-routed `addon-settings`
 * cap. Addons never import each other, so a key owned by the writer would have
 * to be hand-copied by the reader, and a hand-copied key is how a setting
 * silently stops arriving while both sides still look correct.
 */
export const DETAIL_CROP_SECTION_ID = 'detail-crop'
export const DETAIL_CROP_PADDING_KEY = 'detailCropPaddingRatio'
export const DETAIL_CROP_SQUARE_KEY = 'detailCropSquare'

/** A `{x,y,w,h}` rectangle in FRAME-space pixels. */
export interface DetailCropRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Operator-tunable crop convention. Single-valued and cluster-wide — see the
 * module docblock for why it cannot be scoped per node or per device.
 */
export const DetailCropConventionSchema = z.object({
  /**
   * Fraction of the box's own size added on EACH side before cutting.
   *
   * CLIP is trained on natural images WITH surroundings; a pixel-tight crop
   * removes exactly the context it is strongest on (a dog cut to its outline
   * is a dark blob). The right value is an empirical question, which is why it
   * is a setting: 0 / 0.15 / 0.2 / 0.5 are the interesting points.
   */
  paddingRatio: z.number().min(0).max(4),
  /**
   * Square the window (in PIXELS) before cutting.
   *
   * CLIP's input is square, so a tall bbox resized straight to NxN is squashed
   * — a standing person becomes a shape the model never saw. Squaring costs
   * extra background, which is context the model wants anyway. Off by default
   * because the live path has never squared and the stored index reflects that.
   */
  square: z.boolean(),
})

export type DetailCropConvention = z.infer<typeof DetailCropConventionSchema>

/**
 * The convention in force when nobody has configured one — byte-for-byte the
 * behaviour of the pre-unification LIVE path (`DETAIL_CROP_PADDING_RATIO`).
 */
export const DEFAULT_DETAIL_CROP_CONVENTION: DetailCropConvention = {
  paddingRatio: 0.15,
  square: false,
}

/**
 * Narrow a FLAT settings record to the convention.
 *
 * Per-FIELD fallback, deliberately: a junk padding must not also discard a
 * valid squaring choice. An absent or invalid value resolves to
 * {@link DEFAULT_DETAIL_CROP_CONVENTION} — the historical live behaviour —
 * rather than to a clamped number nobody chose, so a bad read can never
 * quietly change what the stored vectors mean.
 */
export function readDetailCropConvention(
  config: Readonly<Record<string, unknown>>,
): DetailCropConvention {
  const paddingRatio = DetailCropConventionSchema.shape.paddingRatio.safeParse(
    config[DETAIL_CROP_PADDING_KEY],
  )
  const square = DetailCropConventionSchema.shape.square.safeParse(config[DETAIL_CROP_SQUARE_KEY])
  return {
    paddingRatio: paddingRatio.success
      ? paddingRatio.data
      : DEFAULT_DETAIL_CROP_CONVENTION.paddingRatio,
    square: square.success ? square.data : DEFAULT_DETAIL_CROP_CONVENTION.square,
  }
}

/** One hydrated field of an `addon-settings.getGlobalSettings` payload. */
interface HydratedSettingsField {
  readonly key: unknown
  readonly value?: unknown
}

/** One section of an `addon-settings.getGlobalSettings` payload. */
export interface HydratedSettingsSection {
  readonly fields: readonly unknown[]
}

/**
 * Minimal structural view of `ConfigUISchemaWithValues` — only what the
 * convention extraction walks. Structural on purpose: the reader is an addon
 * that must not depend on the writer's schema type.
 */
export interface HydratedSettingsView {
  readonly sections: readonly HydratedSettingsSection[]
}

function isHydratedField(entry: unknown): entry is HydratedSettingsField {
  return typeof entry === 'object' && entry !== null && 'key' in entry
}

/**
 * Extract the convention from an `addon-settings.getGlobalSettings` payload.
 *
 * Walks EVERY section rather than looking inside {@link DETAIL_CROP_SECTION_ID}
 * alone: the keys are unique across the addon's schema, and a section rename
 * must not silently revert the whole cluster to the default. A `null` payload
 * (addon mid-boot) is the default convention.
 */
export function pickDetailCropConvention(view: HydratedSettingsView | null): DetailCropConvention {
  if (view === null) return DEFAULT_DETAIL_CROP_CONVENTION
  const flat: Record<string, unknown> = {}
  for (const section of view.sections) {
    for (const entry of section.fields) {
      if (!isHydratedField(entry) || typeof entry.key !== 'string') continue
      if (entry.key === DETAIL_CROP_PADDING_KEY || entry.key === DETAIL_CROP_SQUARE_KEY) {
        flat[entry.key] = entry.value
      }
    }
  }
  return readDetailCropConvention(flat)
}

/**
 * The normalised box that means "the image IS the subject".
 *
 * Used when the stored pixels are ALREADY the model's input — the 112×112
 * aligned face template a gallery sample carries. There is no rectangle left to
 * choose, and the convention must not choose one: re-detecting and re-aligning
 * over a template applies a SECOND warp, passes every gate, and produces a
 * plausible useless vector (session 2026-08-20 §3).
 *
 * Sending it as the whole frame with this box is exact rather than merely
 * convenient, and the reason is a property of {@link deriveDetailCropRect}, not
 * a coincidence: padding a full-frame box can only push OUTSIDE the frame, and
 * both edge modes bring it straight back — unsquared truncates, squared cannot
 * exceed the frame's short side and then slides inside. So for a SQUARE image
 * the derivation is the identity under every convention value, and an operator
 * changing the crop margin cannot silently re-cut an enrolled template.
 * `face-reembed-pass.spec.ts` asserts that identity against the real function.
 */
export const FULL_IMAGE_BBOX: DetailCropRect = Object.freeze({ x: 0, y: 0, w: 1, h: 1 })

/** Slider bounds for the operator-facing padding knob (orchestrator settings UI). */
export const DETAIL_CROP_PADDING_FIELD = {
  min: 0,
  max: 1,
  step: 0.05,
  default: DEFAULT_DETAIL_CROP_CONVENTION.paddingRatio,
} as const

/**
 * Derive the crop rectangle for one parent detection.
 *
 * Order: pad by `paddingRatio` of the box's own size → optionally square in
 * pixel space around the padded centre → keep it inside the frame. Pure:
 * always returns a new rect and never mutates `bbox`.
 *
 * Edge handling differs by mode, on purpose:
 *
 * - **unsquared** — TRUNCATED at the frame border, byte-for-byte what the live
 *   path has always done (`padAndClampFrameBbox`). A subject against the edge
 *   gets a slightly smaller window. Changing this would silently reinterpret
 *   every edge-touching vector already in the index.
 * - **squared** — SLID inward instead, because a truncated square is not
 *   square and squaring exists precisely to preserve the aspect the model
 *   sees. It only shrinks when the square is larger than the frame itself.
 */
export function deriveDetailCropRect(
  bbox: DetailCropRect,
  frameWidth: number,
  frameHeight: number,
  convention: DetailCropConvention,
): DetailCropRect {
  const padX = convention.paddingRatio * bbox.w
  const padY = convention.paddingRatio * bbox.h
  const padded: DetailCropRect = {
    x: bbox.x - padX,
    y: bbox.y - padY,
    w: bbox.w + 2 * padX,
    h: bbox.h + 2 * padY,
  }
  return convention.square
    ? slideInsideFrame(squareInPixels(padded, frameWidth, frameHeight), frameWidth, frameHeight)
    : truncateToFrame(padded, frameWidth, frameHeight)
}

/**
 * Grow the shorter side to the longer one around the window's centre, bounded
 * by the frame's shorter side — a square larger than the frame cannot exist,
 * and collapsing to the frame's short side is the most that does.
 */
function squareInPixels(
  rect: DetailCropRect,
  frameWidth: number,
  frameHeight: number,
): DetailCropRect {
  const side = Math.min(Math.max(rect.w, rect.h), Math.min(frameWidth, frameHeight))
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  return { x: cx - side / 2, y: cy - side / 2, w: side, h: side }
}

/**
 * Cut the window at the frame border — the pre-unification live behaviour,
 * preserved exactly so unsquared crops keep matching the stored index.
 */
function truncateToFrame(
  rect: DetailCropRect,
  frameWidth: number,
  frameHeight: number,
): DetailCropRect {
  const x1 = Math.max(0, rect.x)
  const y1 = Math.max(0, rect.y)
  const x2 = Math.min(frameWidth, rect.x + rect.w)
  const y2 = Math.min(frameHeight, rect.y + rect.h)
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) }
}

/**
 * Move the window inside the frame keeping its extent — used only for squared
 * windows, where truncating would destroy the squareness that is the point.
 */
function slideInsideFrame(
  rect: DetailCropRect,
  frameWidth: number,
  frameHeight: number,
): DetailCropRect {
  const w = Math.max(0, Math.min(rect.w, frameWidth))
  const h = Math.max(0, Math.min(rect.h, frameHeight))
  const x = Math.min(Math.max(0, rect.x), Math.max(0, frameWidth - w))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, frameHeight - h))
  return { x, y, w, h }
}
