/**
 * A camera's clip sources, grouped by the PROVIDER that answers them.
 *
 * `listClips` names one provider (`addonId`), and one addon may serve several
 * of a camera's sources, so every picker and every lane is one entry per
 * provider, labelled by the sources it serves. No source is named here: the
 * rows are whatever `videoclips.listSources` returned for the camera (D549,
 * D554). Shared by the clips section and the Archive review lanes so both
 * spell the same control the same way.
 */
import type { Clip, ClipSource } from '@camstack/types'

/** One provider a surface may ask for clips, and the sources it serves. */
export interface ClipProviderOption {
  /** The `addonId` the query carries. */
  readonly value: string
  /** The served sources' labels, joined. */
  readonly label: string
  /** The rows it serves, in the order the camera listed them. */
  readonly sources: readonly ClipSource[]
}

/** One option per provider; rows without an `addonId` (version skew) are skipped. */
export function clipProviderOptions(rows: readonly ClipSource[]): readonly ClipProviderOption[] {
  const byAddon = new Map<string, ClipSource[]>()
  for (const row of rows) {
    const addonId = row.addonId
    if (addonId === undefined) continue
    byAddon.set(addonId, [...(byAddon.get(addonId) ?? []), row])
  }
  return [...byAddon].map(([value, sources]) => ({
    value,
    label: sources.map((s) => s.label).join(' · '),
    sources,
  }))
}

/**
 * The provider a surface asks when the operator has not picked one: the
 * `preferred` provider when the camera lists it, else the first one listed,
 * else `null` (nobody to ask).
 */
export function defaultClipProvider(
  options: readonly ClipProviderOption[],
  preferred?: string,
): string | null {
  if (preferred !== undefined && options.some((o) => o.value === preferred)) return preferred
  return options[0]?.value ?? null
}

/**
 * The clip that holds `atMs`, or — when none does — the nearest one starting
 * within `toleranceMs` after it (an event fires a moment before its clip opens).
 * `null` when the source holds nothing near that instant.
 */
export function clipAtInstant(
  clips: readonly Clip[],
  atMs: number,
  toleranceMs: number = 30_000,
): Clip | null {
  const holding = clips.find((c) => c.timeRange.startMs <= atMs && atMs < c.timeRange.endMs)
  if (holding !== undefined) return holding
  let best: Clip | null = null
  for (const clip of clips) {
    const lead = clip.timeRange.startMs - atMs
    if (lead < 0 || lead > toleranceMs) continue
    if (best === null || clip.timeRange.startMs < best.timeRange.startMs) best = clip
  }
  return best
}

/** A clip's place on a window, in percent; `null` when it lies outside. */
export interface ClipLaneSpan {
  readonly clip: Clip
  readonly leftPct: number
  readonly widthPct: number
}

/** Clamp each clip to the window and place it; clips outside are dropped. */
export function clipLaneSpans(
  clips: readonly Clip[],
  fromMs: number,
  toMs: number,
): readonly ClipLaneSpan[] {
  const span = toMs - fromMs
  if (span <= 0) return []
  const out: ClipLaneSpan[] = []
  for (const clip of clips) {
    const start = Math.max(clip.timeRange.startMs, fromMs)
    const end = Math.min(clip.timeRange.endMs, toMs)
    if (end <= start) continue
    out.push({
      clip,
      leftPct: ((start - fromMs) / span) * 100,
      widthPct: Math.max(((end - start) / span) * 100, 0.3),
    })
  }
  return out
}
