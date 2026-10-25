/**
 * Is there EVIDENCE the link has room for the next rung? (D635, round 2)
 *
 * Two witnesses, and they are not equal:
 *
 * - REMB, the receiver's own estimate. Chrome's estimate is bounded by what
 *   the sender sends (it grows only while the incoming rate keeps up), so on a
 *   41 kbps rung it sits at 430–520 kbps whatever the link could carry. It is
 *   evidence FOR room when it clears the bar, and never evidence AGAINST.
 * - The viewer's downlink probe (1 MiB of random bytes, timed from the first
 *   byte), reported on the offer as `hints.downlinkMbps`. It measures the path,
 *   not the rung, so it counts both ways: a probe below the bar says no.
 *
 * The bar is the next rung's measured bitrate × margin. A rung that has
 * measured nothing is judged against the client ladder's own thresholds
 * (`adaptive-downlink.ts`: mid 2.5 Mbps, high 8 Mbps — already headroom-
 * inclusive), never against 0 (D393).
 */
import type { CamProfile } from '@camstack/types'

/** What the controller holds about the link's capacity, kbps; null = unknown. */
export interface CapacityEvidence {
  readonly rembKbps: number | null
  /** The viewer's latest probe, whatever its age; null = never probed / failed. */
  readonly probeKbps: number | null
  /**
   * Is the probe young enough to CONFIRM a climb? A good path measurement
   * ages into history; a SHORT one keeps holding until a newer probe replaces
   * it (review I4) — a link measured slow is not assumed to have healed.
   */
  readonly probeFresh: boolean
}

export type CapacityVerdict =
  | {
      readonly kind: 'sufficient'
      readonly source: 'remb' | 'probe'
      readonly kbps: number
      readonly neededKbps: number
    }
  /** A MEASURED probe below the bar. */
  | { readonly kind: 'probe-short'; readonly kbps: number; readonly neededKbps: number }
  /** No witness clears the bar and none contradicts it: unknown. */
  | { readonly kind: 'none'; readonly bestKbps: number | null; readonly neededKbps: number }

/** The client ladder's thresholds (`DOWNLINK_MID_MBPS`, `DOWNLINK_HIGH_MBPS`), kbps. */
const UNMEASURED_RUNG_BAR_KBPS: Readonly<Record<CamProfile, number>> = {
  low: 0,
  mid: 2_500,
  high: 8_000,
}

/** The kbps the next rung needs; `(1800 × 1.2)` or the client threshold. */
export function capacityBarKbps(tier: CamProfile, rungKbps: number | null, margin: number): number {
  return rungKbps !== null && rungKbps > 0 ? rungKbps * margin : UNMEASURED_RUNG_BAR_KBPS[tier]
}

function known(v: number | null): v is number {
  return v !== null && Number.isFinite(v) && v > 0
}

export function judgeCapacity(
  evidence: CapacityEvidence,
  nextTier: CamProfile,
  nextRungKbps: number | null,
  margin: number,
): CapacityVerdict {
  const neededKbps = capacityBarKbps(nextTier, nextRungKbps, margin)
  const { rembKbps, probeKbps, probeFresh } = evidence
  if (known(probeKbps) && probeFresh && probeKbps >= neededKbps) {
    return { kind: 'sufficient', source: 'probe', kbps: probeKbps, neededKbps }
  }
  if (known(rembKbps) && rembKbps >= neededKbps) {
    return { kind: 'sufficient', source: 'remb', kbps: rembKbps, neededKbps }
  }
  if (known(probeKbps) && probeKbps < neededKbps) {
    return { kind: 'probe-short', kbps: probeKbps, neededKbps }
  }
  return { kind: 'none', bestKbps: known(rembKbps) ? rembKbps : null, neededKbps }
}

/**
 * REMB as it can be trusted. werift stores the LAST received estimate on the
 * sender and never ages it, so a peer that stopped sending REMB (backgrounded,
 * gone) would vouch for room indefinitely (review m5). Chrome re-estimates
 * about once a second and the value moves; an estimate unchanged for
 * `staleMs` (30 000 ms — fifteen ticks) is treated as no estimate at all.
 */
export class RembWatch {
  private last: number | null = null
  private changedAt = 0

  constructor(private readonly staleMs: number) {}

  read(kbps: number | null, now: number): number | null {
    if (kbps === null) {
      this.last = null
      return null
    }
    if (kbps !== this.last) {
      this.last = kbps
      this.changedAt = now
    }
    return now - this.changedAt > this.staleMs ? null : kbps
  }
}
