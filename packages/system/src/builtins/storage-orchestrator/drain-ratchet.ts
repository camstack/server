/**
 * The growth-matched drain ratchet (D386).
 *
 * `readonly` takes a location OUT of pressure eviction. `drain` must instead
 * SHRINK it — and priority ordering alone does nothing, because the draining
 * disk and the destination are different physical devices: pressure on one can
 * never trigger eviction on the other.
 *
 * So a draining location gets a **monotonically descending effective usage
 * cap**, enforced through the existing `relieveToUsageCap` machinery rather
 * than a second eviction path. The pace is GROWTH-MATCHED: each sweep, the
 * draining location cedes as many bytes as the ACTIVE locations of its class
 * gained since the previous sweep. There is no operator-facing rate — the
 * operator sets one flag and nothing else.
 *
 * The properties this module exists to hold, each one a named test:
 *
 *   - no growth in the destination ⇒ nothing is deleted this sweep;
 *   - the cap never rises again — a shrunken cap survives a sweep where growth
 *     is negative or unmeasurable;
 *   - the state survives a process restart (it is PERSISTED, never recomputed
 *     from scratch — a recomputed cap would start again at today's usage and
 *     silently undo every byte of progress);
 *   - reaching zero stops the ratchet and reports the location as drained;
 *   - switching back to `readonly` or `active` stops it immediately (the caller
 *     clears the state; nothing here keeps running on its own).
 *
 * Pure. Every input is a parameter, every output is a new object.
 */

/** What one sweep measured about a draining location and its class. */
export interface DrainObservation {
  readonly locationId: string
  /** Evictable bytes on the DRAINING location, now. */
  readonly usedBytes: number
  /**
   * Evictable bytes held by the ACTIVE locations of the same class, now.
   * `null` when this sweep could not measure them — no active peer, or a
   * provider read that failed. Unmeasurable is NOT zero growth with a
   * different name: it must never be allowed to move the cap in either
   * direction, and it must never be folded into the observed growth rate the
   * estimate is derived from.
   */
  readonly peerUsedBytes: number | null
  readonly atMs: number
}

/** The persisted ratchet state for one draining location. */
export interface DrainState {
  readonly locationId: string
  /** When the drain began. Persisted so a restart reports real elapsed time. */
  readonly startedAtMs: number
  /** Evictable bytes at that moment — the denominator of "progress". */
  readonly startBytes: number
  /** The effective usage cap. NEVER rises. */
  readonly capBytes: number
  /** Peer footprint at the previous sweep; the next sweep's growth is measured
   *  against it. `null` until a sweep manages to measure it. */
  readonly lastPeerBytes: number | null
  readonly lastSweepMs: number
  /** Total MEASURED growth ceded so far, and the wall time it took. The empty
   *  estimate is derived from these two and from nothing else — a rate the
   *  system has not observed is reported as absent, never as a date. */
  readonly observedGrowthBytes: number
  readonly observedElapsedMs: number
}

/** One sweep's decision. */
export interface DrainStep {
  readonly state: DrainState
  /**
   * The cap to enforce this sweep, or `null` when nothing is to be evicted —
   * the first sweep (no growth measured yet) and a location already drained.
   */
  readonly capBytes: number | null
  /** The location holds nothing more: the ratchet stops and the caller reports
   *  it drained. */
  readonly drained: boolean
  /** Growth measured this sweep, or `null` when it was unmeasurable. */
  readonly growthBytes: number | null
}

/** Progress a UI can render. */
export interface DrainProgress {
  readonly locationId: string
  readonly startedAtMs: number
  readonly startBytes: number
  readonly bytesRemaining: number
  readonly drained: boolean
  /**
   * Epoch ms this location is expected to be empty, or `null` when the growth
   * rate is unknown. Never a fabricated date: a drain with no observed growth
   * has no honest ETA, and inventing one is how an operator learns not to
   * believe the screen.
   */
  readonly estimatedEmptyAtMs: number | null
}

/** The state a drain starts from. No deletion happens on this sweep. */
export function beginDrain(observation: DrainObservation): DrainState {
  return {
    locationId: observation.locationId,
    startedAtMs: observation.atMs,
    startBytes: observation.usedBytes,
    capBytes: observation.usedBytes,
    lastPeerBytes: observation.peerUsedBytes,
    lastSweepMs: observation.atMs,
    observedGrowthBytes: 0,
    observedElapsedMs: 0,
  }
}

/**
 * Advance the ratchet by one sweep. `previous` is `null` on the first sweep of
 * a drain (and after a state the caller cleared), which only ARMS the ratchet:
 * the first growth can be measured no earlier than the second sweep, and a cap
 * derived from no measurement would be a rate the operator never asked for.
 */
export function stepDrain(previous: DrainState | null, observation: DrainObservation): DrainStep {
  if (previous === null) {
    const state = beginDrain(observation)
    return {
      state,
      capBytes: null,
      drained: observation.usedBytes <= 0,
      growthBytes: null,
    }
  }

  const growthBytes =
    previous.lastPeerBytes !== null && observation.peerUsedBytes !== null
      ? observation.peerUsedBytes - previous.lastPeerBytes
      : null
  // Only POSITIVE growth is ceded. A destination that shrank (its own eviction
  // ran) has not earned the draining disk any deletion, and negative growth
  // must never widen the cap.
  const ceded = growthBytes !== null && growthBytes > 0 ? growthBytes : 0
  // `min` with the current usage is what makes the ratchet converge when a
  // previous sweep over-delivered; it can only ever LOWER the cap.
  const nextCap = Math.max(0, Math.min(previous.capBytes, observation.usedBytes) - ceded)

  const state: DrainState = {
    ...previous,
    capBytes: nextCap,
    // The peer footprint is recorded on EVERY sweep that measured it, so the
    // next growth is measured against the latest reading rather than against
    // whatever the last successful *cede* saw.
    lastPeerBytes: observation.peerUsedBytes ?? previous.lastPeerBytes,
    lastSweepMs: observation.atMs,
    observedGrowthBytes: previous.observedGrowthBytes + ceded,
    observedElapsedMs:
      growthBytes === null
        ? previous.observedElapsedMs
        : previous.observedElapsedMs + Math.max(0, observation.atMs - previous.lastSweepMs),
  }

  if (observation.usedBytes <= 0) {
    return { state: { ...state, capBytes: 0 }, capBytes: null, drained: true, growthBytes }
  }
  return { state, capBytes: nextCap, drained: false, growthBytes }
}

/** Progress for a UI, derived from the persisted state and today's usage. */
export function drainProgressOf(
  state: DrainState,
  usedBytes: number,
  nowMs: number,
): DrainProgress {
  const bytesRemaining = Math.max(0, usedBytes)
  const rateBytesPerMs =
    state.observedGrowthBytes > 0 && state.observedElapsedMs > 0
      ? state.observedGrowthBytes / state.observedElapsedMs
      : null
  return {
    locationId: state.locationId,
    startedAtMs: state.startedAtMs,
    startBytes: state.startBytes,
    bytesRemaining,
    drained: bytesRemaining <= 0,
    estimatedEmptyAtMs:
      rateBytesPerMs === null || bytesRemaining <= 0
        ? null
        : nowMs + Math.ceil(bytesRemaining / rateBytesPerMs),
  }
}
