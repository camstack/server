/**
 * The resolutions the derived-stream editor offers for the Resize section, and
 * the one-way migration of a stored height to a width.
 *
 * The persisted field is `video.width`; the height follows the SOURCE aspect
 * ratio (the derived encode computes it, rounded to an even number). A profile
 * stored by the old editor carries `video.height` only: it still encodes
 * correctly, and the editor reads it as the matching width.
 */
import type { EncodeProfile } from '@camstack/types'

export interface SourceSize {
  readonly width: number
  readonly height: number
}

export interface ResolutionOption {
  readonly width: number
  /** The height at the source aspect ratio, even. */
  readonly height: number
}

/** Widths offered on top of the source's own, highest first. */
const STANDARD_WIDTHS: readonly number[] = [3840, 2560, 1920, 1280, 854, 640]

/** Aspect used to label the options while the source has not been probed. */
const FALLBACK_SOURCE: SourceSize = { width: 3840, height: 2160 }

function evenRound(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/** The even height that keeps `source`'s aspect ratio at `width`. */
export function heightAtWidth(width: number, source: SourceSize): number {
  return evenRound((width * source.height) / source.width)
}

/** The even width that keeps `source`'s aspect ratio at `height`. */
export function widthAtHeight(height: number, source: SourceSize): number {
  return evenRound((height * source.width) / source.height)
}

function isKnown(source: SourceSize | undefined): source is SourceSize {
  return source !== undefined && source.width > 0 && source.height > 0
}

/**
 * The sizes to offer: the source's own, then every standard width below it,
 * highest first, all at the source aspect ratio with even dimensions.
 */
export function resolutionLadder(source: SourceSize | undefined): readonly ResolutionOption[] {
  const reference = isKnown(source) ? source : FALLBACK_SOURCE
  const own = Math.floor(reference.width / 2) * 2
  const widths = [own, ...STANDARD_WIDTHS.filter((w) => w < own)]
  return widths.map((width) => ({ width, height: heightAtWidth(width, reference) }))
}

/**
 * A profile stored with a height and no width becomes the same picture
 * expressed as a width; every other field is carried over untouched. Without a
 * known source there is no aspect to convert with, so the profile is returned
 * as it is and keeps encoding by its height.
 */
export function migrateHeightToWidth(
  profile: EncodeProfile,
  source: SourceSize | undefined,
): EncodeProfile {
  const { height, width, ...rest } = profile.video
  if (height === undefined || width !== undefined) return profile
  if (!isKnown(source)) return profile
  return { ...profile, video: { ...rest, width: widthAtHeight(height, source) } }
}
