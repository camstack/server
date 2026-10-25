/**
 * Detection class colours — the bundled display palette (D939).
 *
 * A mounted {@link DisplayPaletteProvider} paints the cluster's effective
 * palette instead. There is no second hex table here.
 */
import { PALETTE_ENTRY_IDS, bundledCamstack, paintHex, type PaletteReady } from '@camstack/types'

const BUNDLED = bundledCamstack()

/** Marks that are palette entries and not detection classes. */
const MARK_IDS = new Set(['live', 'recording', 'heatmapScrub'])

/**
 * Fixed colours for known classes, from the bundled CamStack preset.
 * Kept for callers that read the map directly.
 */
export const CLASS_COLORS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    PALETTE_ENTRY_IDS.filter((id) => !MARK_IDS.has(id)).map((id) => [
      id,
      paintHex(BUNDLED.swatches, BUNDLED.fallbacks, id),
    ]),
  ),
)

function firstFallback(fallbacks: readonly string[]): string {
  const hex = fallbacks[0]
  if (hex === undefined) {
    throw new Error('display palette has no fallback colour')
  }
  return hex
}

/** Primary colour when nothing else matches — the first bundled fallback. */
export const DEFAULT_COLOR: string = firstFallback(BUNDLED.fallbacks)

export interface PalettePaintSource {
  readonly swatches: PaletteReady['swatches']
  readonly fallbacks: PaletteReady['fallbacks']
}

/**
 * Colour for a detection class. Custom overrides win, then the palette
 * (the bundled preset when none is passed). Unknown classes hash into
 * the palette's fallbacks.
 */
export function getClassColor(
  className: string,
  customColors?: Readonly<Record<string, string>>,
  palette?: PalettePaintSource,
): string {
  const direct = customColors?.[className]
  if (direct !== undefined && direct.length > 0) return direct
  const lower = className.toLowerCase()
  const lowered = customColors?.[lower]
  if (lowered !== undefined && lowered.length > 0) return lowered
  const swatches = palette?.swatches ?? BUNDLED.swatches
  const fallbacks = palette?.fallbacks ?? BUNDLED.fallbacks
  return paintHex(swatches, fallbacks, className)
}
