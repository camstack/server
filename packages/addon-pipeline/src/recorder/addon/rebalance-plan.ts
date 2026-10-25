/**
 * The PURE rebalance planner — the arithmetic behind the OPERATOR-ARMED half of
 * multi-location recordings.
 *
 * D116 draws the line: `placement-planner.ts` decides where NEW writes go and
 * moves nothing; the relocate mover is the only thing that moves bytes, and an
 * operator invokes it. This file is what sits between the two — given the plan
 * in force and where the footage actually is, which piles have to move, and
 * which deliberately do not.
 *
 * Three properties it exists to hold:
 *
 *   - HONESTY ABOUT REFUSALS. Every pile that is out of place is either a move
 *     or a SKIP with a reason. A rebalance that silently drops a camera reads to
 *     an operator exactly like a rebalance that had nothing to do.
 *   - HEADROOM SPENT ONCE, AND ONLY THE TARGET'S. A target's headroom is debited
 *     by each move planned onto it. The SOURCE is never credited: those bytes
 *     are not free until the copy has actually landed and the source been
 *     unlinked, and a planner that spends them promises capacity that does not
 *     exist.
 *   - WHOLE PILES. The mover's unit is `(camera, profile) on one location`. A
 *     pile that no longer fits is refused, never truncated — half a camera's
 *     archive on each of two disks is the outcome nobody asked for.
 *
 * PURITY: no clock, no I/O, no mutation of the input.
 */

/** Everything one (camera, profile) currently has on ONE location. */
export interface RebalanceSource {
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly bytes: number
  readonly files: number
}

/** What a location can still absorb — the same headroom the placement planner
 *  weights with: `min(free − minFree floor, maxUsedGb − used)`, clamped ≥ 0.
 *  A location ABSENT from this list is not a write target at all (read-only,
 *  opted out, or gone), and nothing may be planned onto it. */
export interface RebalanceHeadroom {
  readonly locationId: string
  readonly headroomBytes: number
}

/** Why a pile that is out of place is NOT being moved. */
export type RebalanceSkipReason =
  | 'unassigned'
  | 'target-not-writable'
  | 'below-threshold'
  | 'no-headroom'

/** One pile the operator is being asked to move. */
export interface RebalanceMove {
  readonly deviceId: number
  readonly profile: string
  readonly fromLocationId: string
  readonly toLocationId: string
  readonly bytes: number
  readonly files: number
}

/** One pile that is out of place and staying there, with the reason. */
export interface RebalanceSkip {
  readonly deviceId: number
  readonly profile: string
  readonly fromLocationId: string
  /** The location the plan wants; null when there is no assignment at all. */
  readonly toLocationId: string | null
  readonly bytes: number
  readonly reason: RebalanceSkipReason
}

export interface RebalancePlanInput {
  /** `<deviceId>:<profile>` → locationId, the plan in force (placement-store). */
  readonly assignments: ReadonlyMap<string, string>
  readonly sources: readonly RebalanceSource[]
  readonly headroom: readonly RebalanceHeadroom[]
  /** Piles smaller than this are left alone (default 1 GB). */
  readonly minMoveBytes?: number
}

export interface RebalancePlanResult {
  readonly moves: readonly RebalanceMove[]
  readonly skipped: readonly RebalanceSkip[]
  readonly bytesToMove: number
}

/**
 * Default floor on a worthwhile move. Below a gigabyte the copy, the verify and
 * the index re-point cost more operator patience than the balance they buy —
 * and every camera on a hub has a handful of tiny leftovers on old locations.
 */
export const DEFAULT_MIN_MOVE_BYTES = 1_000_000_000

/** The placement-store key for one (camera, profile). Mirrors `assignmentKey`
 *  in `placement-store.ts`; kept local so this module stays dependency-free. */
function sourceKey(source: RebalanceSource): string {
  return `${source.deviceId}:${source.profile}`
}

/** Biggest pile first (the overloaded disk is relieved fastest), ties broken
 *  deterministically so the same input always yields the same plan. */
function bySizeThenKey(a: RebalanceSource, b: RebalanceSource): number {
  return b.bytes - a.bytes || a.deviceId - b.deviceId || a.profile.localeCompare(b.profile)
}

/**
 * Plan the moves that would make stored footage agree with the placement plan.
 * Pure: the same input always yields the same plan, and the input is untouched.
 */
export function planRebalance(input: RebalancePlanInput): RebalancePlanResult {
  const minMoveBytes = input.minMoveBytes ?? DEFAULT_MIN_MOVE_BYTES
  const remaining = new Map(input.headroom.map((h) => [h.locationId, h.headroomBytes]))

  const moves: RebalanceMove[] = []
  const skipped: RebalanceSkip[] = []
  let bytesToMove = 0

  for (const source of [...input.sources].sort(bySizeThenKey)) {
    const target = input.assignments.get(sourceKey(source))
    // Already where the plan wants it: there is nothing to say about it.
    if (target === source.locationId) continue

    const skip = (reason: RebalanceSkipReason, toLocationId: string | null): void => {
      skipped.push({
        deviceId: source.deviceId,
        profile: source.profile,
        fromLocationId: source.locationId,
        toLocationId,
        bytes: source.bytes,
        reason,
      })
    }

    if (target === undefined) {
      skip('unassigned', null)
      continue
    }
    const headroomBytes = remaining.get(target)
    if (headroomBytes === undefined) {
      skip('target-not-writable', target)
      continue
    }
    if (source.bytes < minMoveBytes) {
      skip('below-threshold', target)
      continue
    }
    if (source.bytes > headroomBytes) {
      skip('no-headroom', target)
      continue
    }

    remaining.set(target, headroomBytes - source.bytes)
    bytesToMove += source.bytes
    moves.push({
      deviceId: source.deviceId,
      profile: source.profile,
      fromLocationId: source.locationId,
      toLocationId: target,
      bytes: source.bytes,
      files: source.files,
    })
  }

  return { moves, skipped, bytesToMove }
}
