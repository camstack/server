/**
 * The protection criterion, in the two units an operator thinks in.
 *
 * The disk-pressure guard has always spoken ONE language — a free-space
 * PERCENTAGE. An operator does not: on a 20 TB array "10%" is 2 TB of headroom
 * nobody asked for, and on a 500 GB SSD it is 50 GB. So a location may instead
 * declare `config.minFreeGb`, and this module converts it to the percentage the
 * guard already speaks using the volume total the orchestrator can already
 * stat.
 *
 * `minFreeGb` WINS when both are present, and the redundancy is logged — two
 * knobs that disagree is the shape D62 forbids, and the one the operator set
 * most recently is not knowable here. `maxUsedGb` stays in the model but stops
 * being an operator knob: it is the internal lever the drain ratchet drives
 * (D386).
 *
 * Pure. Every input is a parameter.
 */
import { gbToBytes } from '@camstack/types'

/** statfs of the location's volume, when this node could take it. */
export interface LocationVolumeCapacity {
  readonly totalBytes: number
  readonly availableBytes: number
}

/** One line, at most once per location per process. */
export type ProtectionNotice = (message: string, meta: Record<string, unknown>) => void

/** A finite, non-negative number off the untyped config blob, or `null`.
 *  Garbage must never become a capacity limit. */
function positiveNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return raw
}

/**
 * The free-space percentage the guard enforces for one location.
 *
 * Order:
 *   1. `config.minFreeGb`, converted against the volume total — the operator's
 *      criterion in the unit they set it in.
 *   2. `config.minFreePercent` — the legacy per-location override, and the
 *      fallback when `minFreeGb` cannot be converted (no volume total: a
 *      remote-node or unstattable location). Falling back is the right
 *      direction — the alternative is a location with no guard at all.
 *   3. the provider's declared default.
 */
export function resolveMinFreePercent(
  config: Readonly<Record<string, unknown>>,
  providerDefaultPercent: number,
  capacity: LocationVolumeCapacity | null,
  notice: ProtectionNotice,
): number {
  const minFreeGb = positiveNumber(config['minFreeGb'])
  const minFreePercent = positiveNumber(config['minFreePercent'])
  const fallback = minFreePercent ?? providerDefaultPercent

  if (minFreeGb === null) return fallback

  if (minFreePercent !== null) {
    notice(
      'storage-orchestrator: location declares BOTH minFreeGb and minFreePercent — ' +
        'minFreeGb wins and minFreePercent is ignored. Remove one.',
      { minFreeGb, minFreePercent },
    )
  }

  const totalBytes = capacity?.totalBytes ?? 0
  if (totalBytes <= 0) {
    notice(
      'storage-orchestrator: minFreeGb cannot be converted — the volume total is unknown ' +
        '(remote node, or an unstattable path). Falling back to the percentage guard.',
      { minFreeGb, fallbackPercent: fallback },
    )
    return fallback
  }

  const percent = (gbToBytes(minFreeGb) / totalBytes) * 100
  // A floor larger than the disk would mean "always breached, evict forever".
  // Clamping to 100 keeps that a policy the operator can see rather than a
  // runaway; the guard's own convergence loop stops when nothing is evictable.
  return Math.min(100, percent)
}
