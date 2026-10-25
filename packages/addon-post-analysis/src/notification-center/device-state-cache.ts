/**
 * The device states the `deviceState` rule gate reads.
 *
 * The gate runs on the persist hook, per event, so it cannot do I/O — it reads
 * this cache with no await. The cache is refreshed on the existing rule-reload
 * tick (D8: reconcile on a schedule, never trust an event to have arrived).
 *
 * Three properties, and each exists because its opposite is a silent failure:
 *
 *  - **A cold cache reads `undefined`**, and `undefined` never matches. Until
 *    the first successful refresh, a gated rule does not fire. Silence is the
 *    safe failure for a gate.
 *  - **A device missing from a refresh reads `undefined`, not its previous
 *    value.** Keeping the last-known state would let a rule stay armed by an
 *    alarm that has been gone for hours.
 *  - **A FAILED refresh keeps the previous map — but it ages out.** Dropping
 *    every state on one transient error would un-gate the whole rule set at
 *    once, which is the loud failure; keeping it forever is the silent one.
 *    Past {@link MAX_AGE_MS} every entry reads `undefined` again.
 */

import type { IScopedLogger } from '@camstack/types'

/**
 * How long a state may go unrefreshed before it stops counting.
 *
 * Deliberately several reload ticks: one failed refresh must not un-gate
 * everything, and a sustained failure must not keep rules armed indefinitely.
 */
export const MAX_AGE_MS = 5 * 60_000

export interface NcDeviceStateCacheDeps {
  readonly logger: IScopedLogger
  /**
   * Read the current state of each id. A device that cannot be read is simply
   * absent from the returned map — never present with a stale or invented
   * value.
   */
  readonly readStates: (ids: readonly number[]) => Promise<ReadonlyMap<number, string>>
  readonly now?: () => number
}

export class NcDeviceStateCache {
  private states: ReadonlyMap<number, string> = new Map()
  /**
   * States a device in THIS process reported the moment it changed.
   *
   * The refresh tick is the only writer for everything the centre reaches over
   * RPC, and 30 seconds of lag is the honest cost of that. It is not honest for
   * a device living in this very process: the alarm panel published `disarmed`
   * and the gate went on answering `armed_away` for up to half a minute, so
   * every rule the mode armed kept firing after the operator disarmed. A direct
   * call, not an event (D8) — a gate refreshed by droppable telemetry is a gate
   * that is sometimes wrong and never says so.
   *
   * They AGE OUT on the same {@link MAX_AGE_MS} as the refreshed ones, so a
   * panel that has stopped publishing falls back to the reconciled answer
   * rather than pinning a state forever.
   */
  private readonly noted = new Map<number, { readonly state: string; readonly at: number }>()
  private lastOkAt = 0
  private ids: readonly number[] = []
  private readonly now: () => number

  constructor(private readonly deps: NcDeviceStateCacheDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * The device ids worth reading — recomputed from the rule set, so a cluster
   * with no gated rule does no work at all.
   */
  setWatched(ids: readonly number[]): void {
    this.ids = [...new Set(ids)].sort((a, b) => a - b)
  }

  watched(): readonly number[] {
    return this.ids
  }

  /**
   * "This device, in this process, is in this state, NOW."
   *
   * Synchronous by contract — the caller is a device's own publish path and the
   * next rule evaluation must already see it. See {@link noted}.
   */
  note(deviceId: number, state: string): void {
    this.noted.set(deviceId, { state, at: this.now() })
  }

  /** Hot-path read. No I/O, no await — this is called per event. */
  get(deviceId: number): string | undefined {
    const now = this.now()
    // The in-process answer OUTRANKS the refreshed one: it is newer by
    // construction, and it is the only one that can be right in the thirty
    // seconds after a local device changed.
    const noted = this.noted.get(deviceId)
    if (noted !== undefined) {
      if (now - noted.at <= MAX_AGE_MS) return noted.state
      this.noted.delete(deviceId)
    }
    if (now - this.lastOkAt > MAX_AGE_MS) return undefined
    return this.states.get(deviceId)
  }

  /**
   * Re-read every watched state. Never throws: a gate that could fail the
   * evaluation tick would take the notification pipeline with it.
   */
  async refresh(): Promise<void> {
    if (this.ids.length === 0) {
      this.states = new Map()
      return
    }
    try {
      const next = await this.deps.readStates(this.ids)
      this.states = new Map(next)
      this.lastOkAt = this.now()
      // A watched device that answered nothing is a rule that has quietly
      // stopped being able to fire — the operator has to be able to find that.
      for (const id of this.ids) {
        if (!next.has(id)) {
          this.deps.logger.info('device-state gate: no state for a watched device', {
            tags: { deviceId: id },
          })
        }
      }
    } catch (err) {
      this.deps.logger.warn(
        'device-state refresh failed — keeping the previous states until they age out',
        {
          meta: { watched: this.ids.length, error: String(err) },
        },
      )
    }
  }
}
