/**
 * The PURE weighted placement planner.
 *
 * The unit of placement is a (camera, profile) ASSIGNMENT, never a segment. One
 * writer run writes one directory on one filesystem: `.rec-tmp` staging lives
 * UNDER the chosen root so the finalize relocate is a same-filesystem rename,
 * and per-segment striping would turn every finalize into the EXDEV copy+unlink
 * fallback (2× disk writes — the F1 regression) while asking one ffmpeg to
 * write two directories. Balancing therefore means choosing which location each
 * camera-profile lands on, weighted by how much each location can still absorb.
 *
 * Two properties this file exists to hold:
 *
 *   - STICKINESS. A plan that moves a camera every tick is worse than no plan:
 *     each move costs a writer restart and a recording gap. Nothing moves until
 *     a location is off its target share by more than the hysteresis band, or
 *     must be vacated outright (read-only, gone, or out of headroom).
 *   - PURITY. No clock, no rotation state, no I/O. A genuine tie — two
 *     locations the capacity signal cannot separate — is handed to an INJECTED
 *     re-ranker (D37: the rotation is mutable, advisory state and lives outside
 *     the planner, so the planner stays a deterministic function).
 */

/** One location the planner may place work on. */
export interface PlacementCandidate {
  readonly locationId: string
  /** `recordings` / `recordingsLow` — demands prefer their own type's pool. */
  readonly type: string
  /**
   * Bytes this location can still absorb:
   * `min(free − minFreePercent·total, maxUsedGb − usedOnLocation)`, clamped ≥ 0.
   * Zero means "at its limit" — it is a candidate, but it wins nothing.
   *
   * `null` means UNMEASURABLE: `statfs` would not answer (a NAS that stopped
   * responding), or nothing measures this location at all. That is a different
   * fact from zero and the caller must be able to tell them apart — zero says
   * "vacate this disk", null says "I do not know", and they were the same
   * number until 2026-09-07, so one failed `statfs` evacuated a healthy disk.
   * A null location wins no new work (no signal to win with) and is never
   * evacuated on the strength of a reading nobody took.
   */
  readonly headroomBytes: number | null
}

/** One (camera, profile) unit of work, with its measured daily byte rate. */
export interface PlacementDemand {
  /** `<deviceId>:<profile>` — the assignment key. */
  readonly key: string
  /** The location type this demand prefers (`low` → `recordingsLow`). */
  readonly type: string
  /** Measured bytes/day. Zero when nothing has been measured yet. */
  readonly dailyBytes: number
}

/** Why one demand moved. */
export type PlacementChangeReason = 'unassigned' | 'gone' | 'evacuate' | 'off-target'

export interface PlacementChange {
  readonly key: string
  readonly from: string | null
  readonly to: string
  readonly reason: PlacementChangeReason
}

export interface PlacementPlanInput {
  readonly candidates: readonly PlacementCandidate[]
  readonly demands: readonly PlacementDemand[]
  /** The assignments in force right now — the thing stickiness protects. */
  readonly current: ReadonlyMap<string, string>
  /** Locations that must be vacated now (read-only, or over their limit). */
  readonly evacuate?: ReadonlySet<string>
  /** Reassign only when a location is off its target share by MORE than this. */
  readonly offTargetPp?: number
  /** Break a genuine tie. Default: lexicographically first (deterministic). */
  readonly breakTie?: (tied: readonly string[]) => string
}

export interface PlacementPlan {
  readonly assignments: ReadonlyMap<string, string>
  readonly changes: readonly PlacementChange[]
}

/**
 * Default hysteresis band. 15 percentage points off the target share is roughly
 * "one whole camera out of place on a two-disk cluster" — small enough that a
 * genuinely lopsided cluster corrects, wide enough that normal drift in the
 * measured byte rates never restarts a writer.
 */
export const DEFAULT_OFF_TARGET_PP = 15

/** Per-location running state while a pool is being planned. */
interface PoolSlot {
  readonly locationId: string
  readonly weight: number
  assignedBytes: number
}

/** The candidate pool a demand may be placed on: its own type, else everything.
 *  This is the same fallback chain `resolvePlacement` applies — a `low` profile
 *  on a cluster with no `recordingsLow` location lands on `recordings`. */
function poolFor(
  demand: PlacementDemand,
  candidates: readonly PlacementCandidate[],
): readonly PlacementCandidate[] {
  const typed = candidates.filter((c) => c.type === demand.type)
  return typed.length > 0 ? typed : candidates
}

function poolKey(pool: readonly PlacementCandidate[]): string {
  return pool
    .map((c) => c.locationId)
    .toSorted()
    .join('|')
}

/**
 * What one demand with NO measured rate weighs: the median of the rates that
 * WERE measured, and one unit when nothing in the pool was measured at all.
 *
 * Never zero, and that is the whole point (D387). `dailyBytes` is 0 for every
 * camera the recorder's RAM index has not accounted for — after D287 that is
 * most of a fleet at any moment — and a zero-byte demand is invisible to every
 * balance calculation here. Phase C reaches for the SMALLEST demand on an
 * overloaded location, which is one of those; moving 0 bytes moves neither side
 * towards its target, so the strict-improvement check fails and the rebalance
 * `break`s on its first iteration. A single measured camera in the pool was
 * enough to make every unmeasured one weightless and wedge the whole pass — on
 * a live hub that left 19 assignments pinned to an 89%-full disk with an empty
 * 4 TB one next to it, silently, on every 30 s tick.
 *
 * The median (rather than the mean) so one 24/7 4K camera does not decide what
 * an unknown camera is assumed to cost.
 */
function weightOfUnmeasured(demands: readonly PlacementDemand[]): number {
  const measured = demands
    .map((d) => d.dailyBytes)
    .filter((bytes) => bytes > 0)
    .toSorted((a, b) => a - b)
  if (measured.length === 0) return 1
  const mid = Math.floor(measured.length / 2)
  return measured.length % 2 === 1 ? measured[mid]! : (measured[mid - 1]! + measured[mid]!) / 2
}

/** Normalised weight per location: headroom share, or an even split when no
 *  location reports any headroom (nothing is known yet — never divide by 0).
 *  An UNMEASURABLE location (`headroomBytes: null`) contributes nothing and
 *  weighs nothing: it keeps what it already holds and attracts no new work. */
function weightsFor(pool: readonly PlacementCandidate[]): Map<string, number> {
  const total = pool.reduce((sum, c) => sum + Math.max(0, c.headroomBytes ?? 0), 0)
  const weights = new Map<string, number>()
  for (const c of pool) {
    weights.set(
      c.locationId,
      total > 0 ? Math.max(0, c.headroomBytes ?? 0) / total : 1 / pool.length,
    )
  }
  return weights
}

/** The location with the largest unmet share of the target, ties broken by the
 *  injected re-ranker over the tied ids (in stable, sorted order). */
function neediest(
  slots: readonly PoolSlot[],
  totalBytes: number,
  breakTie: (tied: readonly string[]) => string,
  exclude?: string,
): PoolSlot | undefined {
  const eligible = slots.filter((s) => s.locationId !== exclude)
  if (eligible.length === 0) return undefined
  let best = -Infinity
  for (const slot of eligible) {
    const deficit = slot.weight * totalBytes - slot.assignedBytes
    if (deficit > best) best = deficit
  }
  const tied = eligible
    .filter((s) => Math.abs(s.weight * totalBytes - s.assignedBytes - best) < 1e-9)
    .map((s) => s.locationId)
    .toSorted()
  if (tied.length === 1) return eligible.find((s) => s.locationId === tied[0])
  const chosen = breakTie(tied)
  return eligible.find((s) => s.locationId === chosen) ?? eligible[0]
}

/**
 * Plan the placement of every demand over the candidate locations. Pure: the
 * same input always yields the same plan.
 */
export function planPlacement(input: PlacementPlanInput): PlacementPlan {
  const breakTie = input.breakTie ?? ((tied: readonly string[]): string => tied[0]!)
  const offTargetPp = input.offTargetPp ?? DEFAULT_OFF_TARGET_PP
  const evacuate = input.evacuate ?? new Set<string>()

  const assignments = new Map<string, string>()
  const changes: PlacementChange[] = []
  if (input.candidates.length === 0) return { assignments, changes }

  // Group demands by the pool they may land on: two pools balance independently.
  const pools = new Map<
    string,
    { pool: readonly PlacementCandidate[]; demands: PlacementDemand[] }
  >()
  for (const demand of input.demands) {
    const pool = poolFor(demand, input.candidates)
    const key = poolKey(pool)
    const group = pools.get(key)
    if (group) group.demands.push(demand)
    else pools.set(key, { pool, demands: [demand] })
  }

  for (const { pool, demands } of pools.values()) {
    // Everything measures in bytes/day, and an UNMEASURED demand weighs a
    // measured peer — see `weightOfUnmeasured`. Before any rate is known at
    // all, every demand counts as one unit, so the planner balances by COUNT
    // rather than by nothing.
    const unmeasured = weightOfUnmeasured(demands)
    const bytesOf = (d: PlacementDemand): number => (d.dailyBytes > 0 ? d.dailyBytes : unmeasured)
    const totalBytes = demands.reduce((sum, d) => sum + bytesOf(d), 0)

    const weights = weightsFor(pool)
    const slots: PoolSlot[] = pool.map((c) => ({
      locationId: c.locationId,
      weight: weights.get(c.locationId) ?? 0,
      assignedBytes: 0,
    }))
    const slotById = new Map(slots.map((s) => [s.locationId, s]))
    // Vacating a location removes it as a TARGET, but never leaves a demand
    // with nowhere to go: when every location is evacuating, they all serve.
    const usable = slots.filter((s) => !evacuate.has(s.locationId))
    const targets = usable.length > 0 ? usable : slots

    const ordered = demands.toSorted((a, b) => a.key.localeCompare(b.key))
    const pending: PlacementDemand[] = []

    // ── Phase A: stickiness. Keep every valid current assignment. ──────────
    for (const demand of ordered) {
      const from = input.current.get(demand.key)
      if (from === undefined) {
        pending.push(demand)
        continue
      }
      const slot = slotById.get(from)
      if (!slot) {
        pending.push(demand)
        changes.push({ key: demand.key, from, to: '', reason: 'gone' })
        continue
      }
      if (evacuate.has(from) && targets.some((t) => t.locationId !== from)) {
        pending.push(demand)
        changes.push({ key: demand.key, from, to: '', reason: 'evacuate' })
        continue
      }
      assignments.set(demand.key, from)
      slot.assignedBytes += bytesOf(demand)
    }

    // ── Phase B: place everything unassigned, biggest first, by deficit. ───
    const toPlace = pending.toSorted(
      (a, b) => bytesOf(b) - bytesOf(a) || a.key.localeCompare(b.key),
    )
    for (const demand of toPlace) {
      const slot = neediest(targets, totalBytes, breakTie)
      if (!slot) continue
      assignments.set(demand.key, slot.locationId)
      slot.assignedBytes += bytesOf(demand)
      const pendingChange = changes.find((c) => c.key === demand.key && c.to === '')
      if (pendingChange) {
        changes.splice(changes.indexOf(pendingChange), 1, { ...pendingChange, to: slot.locationId })
      } else {
        changes.push({
          key: demand.key,
          from: input.current.get(demand.key) ?? null,
          to: slot.locationId,
          reason: 'unassigned',
        })
      }
    }

    // ── Phase C: rebalance only what is off target by MORE than the band. ──
    if (totalBytes > 0 && targets.length > 1) {
      const sharePp = (slot: PoolSlot): number => (slot.assignedBytes / totalBytes) * 100
      const targetPp = (slot: PoolSlot): number => slot.weight * 100
      for (let guard = 0; guard < demands.length; guard += 1) {
        const over = targets
          .filter((s) => sharePp(s) - targetPp(s) > offTargetPp)
          .toSorted((a, b) => sharePp(b) - targetPp(b) - (sharePp(a) - targetPp(a)))
        const from = over[0]
        if (!from) break
        const to = neediest(targets, totalBytes, breakTie, from.locationId)
        if (!to) break
        // Move the SMALLEST demand on the overloaded location: the least
        // disruptive correction that still reduces the excess.
        const movable = ordered
          .filter((d) => assignments.get(d.key) === from.locationId)
          .toSorted((a, b) => bytesOf(a) - bytesOf(b) || a.key.localeCompare(b.key))
        const demand = movable[0]
        if (!demand) break
        const moved = bytesOf(demand)
        // Only move when the pair is STRICTLY closer to target afterwards.
        // Without this a lone demand ping-pongs forever between two equal
        // locations: each side is 50pp off whichever way it sits.
        const before =
          Math.abs(from.assignedBytes - from.weight * totalBytes) +
          Math.abs(to.assignedBytes - to.weight * totalBytes)
        const after =
          Math.abs(from.assignedBytes - moved - from.weight * totalBytes) +
          Math.abs(to.assignedBytes + moved - to.weight * totalBytes)
        if (after >= before) break
        assignments.set(demand.key, to.locationId)
        from.assignedBytes -= moved
        to.assignedBytes += moved
        changes.push({
          key: demand.key,
          from: from.locationId,
          to: to.locationId,
          reason: 'off-target',
        })
      }
    }
  }

  return { assignments, changes: changes.filter((c) => c.to !== '') }
}
