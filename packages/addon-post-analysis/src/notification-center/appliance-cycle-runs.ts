/**
 * The production {@link NcResolveApplianceCycleFacts}: the facts of a finished
 * cycle come from the durable run record (`device-runs`, D992) - the duration
 * the recorder measured and the energy it integrated - instead of a start the
 * notification centre remembered itself.
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
  type NcResolveApplianceCycleFacts,
} from './appliance-cycle.js'

export const CYCLE_FACTS_WAIT_MS = 3000
export const CYCLE_FACTS_POLL_MS = 250
/** A closed run belongs to this finish when it ended within this much of it. */
export const CYCLE_RUN_MATCH_MS: number = 10 * 60_000

export interface ApplianceCycleRunsPorts {
  /** The newest run of the device (open or closed), or `null` when it has none. */
  readonly newestRun: (deviceId: number) => Promise<DeviceRun | null>
  readonly sleep: (ms: number) => Promise<void>
}

function factsOfClosed(run: DeviceRun, finishedAtMs: number): NcApplianceCycleFacts {
  if (run.endedAt === null || Math.abs(run.endedAt - finishedAtMs) > CYCLE_RUN_MATCH_MS) {
    return NC_UNKNOWN_CYCLE_FACTS
  }
  return { durationMs: run.durationMs, energyKwh: run.detail.energyKwh }
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
