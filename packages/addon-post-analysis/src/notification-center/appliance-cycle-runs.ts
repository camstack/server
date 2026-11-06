/**
 * The production {@link NcResolveApplianceCycleFacts}: the facts of a finished
 * cycle come from the durable run record (`device-runs`, D992) - the duration
 * the recorder measured and the energy it integrated - instead of a start the
 * notification centre remembered itself.
 *
 * The run's `endedAt` is the last real active instant (the start of the pending
 * stop, planning#424), so the duration is the time the appliance really worked -
 * not that plus the stop dwell the finish notification waited.
 *
 * The run may close a moment AFTER the sensor event that drives this lookup
 * (both come from the same `running-state` flip, through two different
 * subscribers). So the newest run is read, and while it is still OPEN the read
 * is repeated, for at most {@link CYCLE_FACTS_WAIT_MS}. If it is still open after
 * that, the cycle's duration is the open run's start up to the finish and the
 * energy stays unknown - a bounded wait, never a blocked notification.
 *
 * Both facts are `null` when unknown (D393): no run at all, a newest run that
 * ended at some other time (this cycle left no record), an energy the recorder
 * could not measure. A rejected read propagates; the dispatcher turns it into
 * "unknown" (D49).
 */
import type { DeviceRun } from '@camstack/types'
import {
  NC_UNKNOWN_CYCLE_FACTS,
  type NcApplianceCycleFacts,
  type NcNotRealCycleReason,
  type NcResolveApplianceCycleFacts,
} from './appliance-cycle.js'

export const CYCLE_FACTS_WAIT_MS = 3000
export const CYCLE_FACTS_POLL_MS = 250
/** A closed run belongs to this finish when it ended within this much AFTER it. */
export const CYCLE_RUN_MATCH_MS: number = 10 * 60_000
/**
 * ... or up to this long BEFORE it: a run ends at the last real active instant
 * (the start of the pending stop), and the finish is announced one stop dwell
 * later - the longest a stop dwell is proposed is 20 minutes.
 */
export const CYCLE_RUN_END_LAG_MS: number = 30 * 60_000

/**
 * A cycle below these is a plug blip or a door-open flicker, not a wash: real
 * cycles measured 0.34-1.4 kWh over 43-133 min, the fake ones 0.0001 kWh. 2 Wh
 * and 3 min sit far below any real program and far above a standby sample.
 * The energy floor applies only when the energy is KNOWN (null is never 0, D393).
 */
export const CYCLE_MIN_ENERGY_KWH = 0.002
export const CYCLE_MIN_DURATION_MS: number = 3 * 60_000

export interface ApplianceCycleRunsPorts {
  /** The newest run of the device (open or closed), or `null` when it has none. */
  readonly newestRun: (deviceId: number) => Promise<DeviceRun | null>
  readonly sleep: (ms: number) => Promise<void>
}

function factsOfClosed(run: DeviceRun, finishedAtMs: number): NcApplianceCycleFacts {
  if (run.endedAt === null) return NC_UNKNOWN_CYCLE_FACTS
  const lag = finishedAtMs - run.endedAt
  if (lag > CYCLE_RUN_END_LAG_MS || -lag > CYCLE_RUN_MATCH_MS) return NC_UNKNOWN_CYCLE_FACTS
  const facts = { durationMs: run.durationMs, energyKwh: run.detail.energyKwh }
  const notReal = notRealReason(run)
  return notReal === null ? facts : { ...facts, notReal }
}

function notRealReason(run: DeviceRun): NcNotRealCycleReason | null {
  if (run.outcome === 'aborted') return 'aborted'
  const energy = run.detail.energyKwh
  if (energy !== null && energy < CYCLE_MIN_ENERGY_KWH) return 'below-energy-floor'
  if (run.durationMs !== null && run.durationMs < CYCLE_MIN_DURATION_MS)
    return 'below-duration-floor'
  return null
}

export function applianceCycleFactsFromRuns(
  ports: ApplianceCycleRunsPorts,
): NcResolveApplianceCycleFacts {
  return async ({ deviceId, finishedAtMs }) => {
    let waited = 0
    for (;;) {
      const run = await ports.newestRun(deviceId)
      if (run === null) return NC_UNKNOWN_CYCLE_FACTS
      if (run.state === 'closed') return factsOfClosed(run, finishedAtMs)
      if (run.startedAt > finishedAtMs) return NC_UNKNOWN_CYCLE_FACTS
      if (waited >= CYCLE_FACTS_WAIT_MS) {
        return { durationMs: finishedAtMs - run.startedAt, energyKwh: null }
      }
      await ports.sleep(CYCLE_FACTS_POLL_MS)
      waited += CYCLE_FACTS_POLL_MS
    }
  }
}
