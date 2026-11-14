/**
 * StorageDrainEventMonitor — the operator-facing cadence for a drain's
 * progress (#538).
 *
 * A `drain` location (D385) and the pruning eviction that paces it (D386) ran
 * with no signal at all: an operator who put a disk into drain had to poll
 * `storage.listDrainProgress` by hand to learn it was still moving. This
 * decides WHEN a system event fires, not what it says — the sweep already
 * computed the figures (`drainProgressOf`); this only throttles them to the
 * cadence an operator can read without being paged every sweep.
 *
 * Two rules, no operator knob:
 *
 *  - PROGRESS fires once immediately (drain start, or this process's first
 *    sweep after a restart) and then at most once per `cadenceMs` — the named
 *    constant {@link DRAIN_PROGRESS_EVENT_INTERVAL_MS}, 15 minutes.
 *  - COMPLETE fires exactly once, the first sweep that reports the location
 *    drained — never again for the same location until it drains again.
 *
 * A sweep whose occupancy read failed is NOT skipped: the sample's bytes/
 * rate/ETA are `null` (D393 — never folded to 0) and the cadence still
 * applies, so the operator sees "still draining, figures unknown" rather than
 * silence that reads as "the drain stopped reporting".
 *
 * Pure except for the injected clock — same shape as
 * `StorageLocationBandMonitor`, stateful across `observe()` calls, one
 * transition per sweep.
 */

/** No operator-facing rate knob (#538): the cadence is this one constant. */
export const DRAIN_PROGRESS_EVENT_INTERVAL_MS: number = 15 * 60_000

export interface StorageDrainEventSample {
  readonly locationId: string
  readonly locationName: string
  readonly nodeId?: string
  /** `null` when this sweep's occupancy read failed — never folded to 0 (D393). */
  readonly bytesRemaining: number | null
  readonly rateBytesPerMs: number | null
  readonly estimatedEmptyAtMs: number | null
  readonly drained: boolean
}

export type StorageDrainEventKind = 'progress' | 'complete'

export interface StorageDrainEvent {
  readonly kind: StorageDrainEventKind
  readonly locationId: string
  readonly locationName: string
  readonly nodeId?: string
  readonly bytesRemaining: number | null
  readonly rateBytesPerMs: number | null
  readonly estimatedEmptyAtMs: number | null
}

interface DrainEmitState {
  readonly lastEmittedAtMs: number
  readonly completedEmitted: boolean
}

function toEvent(kind: StorageDrainEventKind, sample: StorageDrainEventSample): StorageDrainEvent {
  return {
    kind,
    locationId: sample.locationId,
    locationName: sample.locationName,
    ...(sample.nodeId !== undefined ? { nodeId: sample.nodeId } : {}),
    bytesRemaining: sample.bytesRemaining,
    rateBytesPerMs: sample.rateBytesPerMs,
    estimatedEmptyAtMs: sample.estimatedEmptyAtMs,
  }
}

export class StorageDrainEventMonitor {
  private readonly cadenceMs: number
  private readonly now: () => number
  private readonly state = new Map<string, DrainEmitState>()

  constructor(cadenceMs: number = DRAIN_PROGRESS_EVENT_INTERVAL_MS, now: () => number = Date.now) {
    this.cadenceMs = cadenceMs
    this.now = now
  }

  /**
   * Observe one sweep of draining locations. A location missing from `samples`
   * (switched back to `readonly`/`active`, or deleted) drops its schedule
   * silently: a later re-drain starts a fresh "begin" event rather than
   * resuming the old cadence clock.
   */
  observe(samples: readonly StorageDrainEventSample[]): readonly StorageDrainEvent[] {
    const nowMs = this.now()
    const seen = new Set<string>()
    const out: StorageDrainEvent[] = []
    for (const sample of samples) {
      seen.add(sample.locationId)
      const previous = this.state.get(sample.locationId)
      if (sample.drained) {
        if (previous?.completedEmitted !== true) {
          this.state.set(sample.locationId, { lastEmittedAtMs: nowMs, completedEmitted: true })
          out.push(toEvent('complete', sample))
        }
        continue
      }
      const due = previous === undefined || nowMs - previous.lastEmittedAtMs >= this.cadenceMs
      if (!due) continue
      this.state.set(sample.locationId, { lastEmittedAtMs: nowMs, completedEmitted: false })
      out.push(toEvent('progress', sample))
    }
    for (const id of this.state.keys()) {
      if (!seen.has(id)) this.state.delete(id)
    }
    return out
  }
}
