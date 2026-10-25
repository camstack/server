/**
 * Initial adaptive-tier pick. Viewport is a CEILING for tiny tiles, not a
 * nearest-pixel match — a phone-sized player (430 CSS px) must not land on
 * `low` just because 640×360 is the closest default. Bandwidth, when
 * measured, is the real limiter. Default is the smallest available rung
 * (`low`, then `mid`) so the picture appears immediately; a probe then
 * climbs through mid to high.
 *
 * ## Why `default-low` stays the fallback (reviewed 2026-09-02)
 *
 * The shape invites the objection that an unknown network should start at a
 * MIDDLE rung, because with no `downlinkMbps` and no `prefersTier` this
 * function returns the smallest tier and the viewport branch can only lower
 * it further — so a client that never reports a downlink looks permanently
 * pinned to the sub-stream, even full-screen on a tablet. It is not, and the
 * fallback was kept deliberately. Two independent climbs exist above it:
 *
 *  1. CLIENT probe. `camera-stream-player` fires `/adaptive-probe` once the
 *     cold-start session shows its first decoded frame (D635) and, when
 *     `shouldUpgradeAfterProbe` says mid/high, re-connects make-before-break
 *     carrying the measured `downlinkMbps`.
 *  2. SERVER ladder. `AdaptiveController.handleHealthy` promotes one rung
 *     when the current rung lands whole over a GOP (delivery ratio), loss
 *     evidence exists, and REMB — when known — has room for the next rung:
 *     from `low` on a session that has never downgraded, after one covered
 *     delivery window plus ~4 s (`requiredHealthyMs`). A climb it refuses is
 *     named (`climbHold`), never silent (D635). The promotion is
 *     published as `pendingRenegotiation` and re-enters here through
 *     `adaptiveIntent.prefersTier`, so the `prefers-tier` branch — not this
 *     fallback — decides the tier from then on. No downlink hint is involved.
 *
 * So this value is a COLD-START default, in force for seconds, not a verdict
 * on an unknown network. Starting at a middle rung instead would ship a
 * mid-tier stream to genuinely slow links before any measurement exists, and
 * the ladder would have to correct it DOWNWARD — the expensive direction: a
 * tier switch is a close-and-recreate re-offer, so the wrong guess costs a
 * visible reconnect while the right guess costs only the first few seconds at
 * a lower resolution.
 *
 * The operator report that "automatic quality always drops to low" was real,
 * but it was not this: BOTH climbs were disabled on the app. The client probe
 * fetched `window.location.origin + /adaptive-probe`, and the native viewer
 * loads the player from a bundled asset, so that origin was `file://` and the
 * probe could never resolve (fixed in `resolveProbeOrigin`); and the grid
 * tile's offer closures declared a shorter arity than the player's callback,
 * silently discarding the hints entirely (fixed in `grid-tile-offer.ts`).
 * Raising this default would have hidden both instead of fixing either.
 */
export type AdaptiveTier = 'high' | 'mid' | 'low'

export type AdaptivePickReason =
  | 'prefers-tier'
  | 'prefers-tier-fallback'
  | 'downlink'
  | 'viewport-ceiling'
  | 'default-low'

export interface AdaptivePick {
  readonly tier: AdaptiveTier
  readonly reason: AdaptivePickReason
}

const RANK: Readonly<Record<AdaptiveTier, number>> = { low: 1, mid: 2, high: 3 }
const QUALITY_FIRST: readonly AdaptiveTier[] = ['high', 'mid', 'low']
const SMALLEST_FIRST: readonly AdaptiveTier[] = ['low', 'mid', 'high']

/** Below this CSS/physical max dimension the surface is a grid tile, not a player. */
export const VIEWPORT_TILE_MAX_PX = 240

/** Mbps needed to attempt each rung (bitrate / 0.6 headroom, rounded). */
export const DOWNLINK_HIGH_MBPS = 8
export const DOWNLINK_MID_MBPS = 2.5

function isTier(value: string | undefined): value is AdaptiveTier {
  return value === 'high' || value === 'mid' || value === 'low'
}

function firstAvailable(
  order: readonly AdaptiveTier[],
  available: readonly AdaptiveTier[],
): AdaptiveTier | undefined {
  const set = new Set(available)
  return order.find((t) => set.has(t))
}

function capTo(tier: AdaptiveTier, available: readonly AdaptiveTier[]): AdaptiveTier | undefined {
  const max = RANK[tier]
  return firstAvailable(
    QUALITY_FIRST.filter((t) => RANK[t] <= max),
    available,
  )
}

export function pickAdaptiveTier(input: {
  readonly available: readonly (AdaptiveTier | null | undefined)[]
  readonly prefersTier?: string
  readonly downlinkMbps?: number
  readonly viewportWidth?: number
  readonly viewportHeight?: number
}): AdaptivePick {
  const available = input.available.filter(
    (t): t is AdaptiveTier => t === 'high' || t === 'mid' || t === 'low',
  )
  const fallback = firstAvailable(SMALLEST_FIRST, available) ?? 'high'

  if (isTier(input.prefersTier)) {
    const exact = available.includes(input.prefersTier) ? input.prefersTier : undefined
    if (exact) return { tier: exact, reason: 'prefers-tier' }
    const smallest = firstAvailable(SMALLEST_FIRST, available) ?? fallback
    return { tier: smallest, reason: 'prefers-tier-fallback' }
  }

  let tier = fallback
  let reason: AdaptivePickReason = 'default-low'

  if (
    input.downlinkMbps !== undefined &&
    Number.isFinite(input.downlinkMbps) &&
    input.downlinkMbps >= 0
  ) {
    const cap: AdaptiveTier =
      input.downlinkMbps >= DOWNLINK_HIGH_MBPS
        ? 'high'
        : input.downlinkMbps >= DOWNLINK_MID_MBPS
          ? 'mid'
          : 'low'
    tier = capTo(cap, available) ?? fallback
    reason = 'downlink'
  }

  const width = input.viewportWidth
  const height = input.viewportHeight
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    const maxDim = Math.max(width, height)
    if (maxDim < VIEWPORT_TILE_MAX_PX) {
      const tiled = capTo('low', available) ?? fallback
      if (RANK[tiled] < RANK[tier]) {
        return { tier: tiled, reason: 'viewport-ceiling' }
      }
    }
  }

  return { tier, reason }
}
