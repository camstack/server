/**
 * The core-blocks side of a conditional step (#472): a step's `if` is read on a
 * mirror filled over `ctx.api` (`deviceState.getCapSlice`), the same state
 * every other consumer of the ONE `when` tree reads. A run on behalf of a
 * non-admin may only branch on devices that caller can see — a branch is an
 * answer, and an out-of-scope answer is a leak — so a tree naming any other
 * device (or a stable id, which cannot be proven) reads `unknown`: neither side
 * runs, and the trace says why.
 *
 * A `time-is` leaf reads the site clock: the door reads `system.getSiteLocation`
 * for a tree that holds one (never for a tree that does not). A site that
 * cannot be read is `unknown`, as any other read the guard depends on.
 */
import {
  type AddonApi,
  collectWhenMirrorSources,
  type EvaluateStepCondition,
  evaluateStepCondition,
  hasTimeLeaves,
  siteFor,
  stableIdMapOf,
  type TimeSite,
  zoneOnlySite,
} from '@camstack/types'

/** Builds the evaluator for one run, bound to the devices its caller may read (`undefined` = all). */
export type StepConditionDoor = (readable?: readonly number[]) => EvaluateStepCondition

export function conditionDoorOver(api: () => AddonApi | undefined): StepConditionDoor {
  return (readable) => async (when) => {
    const current = api()
    if (current === undefined) {
      return {
        result: 'unknown',
        reason: 'this node has no ctx.api to read state through',
      }
    }
    if (readable !== undefined) {
      const outside = collectWhenMirrorSources(when).filter(
        (source) => source.kind === 'stable' || !readable.includes(source.deviceId),
      )
      if (outside.length > 0) {
        return {
          result: 'unknown',
          reason: 'the condition reads a device this caller was not proven to see',
        }
      }
    }
    // a `time-is` leaf is judged on the site clock: read it with the rest of the state, only when the tree needs it
    let site: TimeSite | undefined
    if (hasTimeLeaves(when)) {
      try {
        const reading = await current.system.getSiteLocation.query()
        site = siteFor(reading) ?? zoneOnlySite(reading.timeZone)
      } catch (error) {
        return {
          result: 'unknown',
          reason: `the site could not be read, so the time window cannot be judged (${
            error instanceof Error ? error.message : String(error)
          })`,
        }
      }
    }
    return evaluateStepCondition(
      when,
      {
        fetchSlice: (deviceId, cap) =>
          current.deviceState.getCapSlice.query({ deviceId, capName: cap }),
        fetchStableIds: async () => stableIdMapOf(await current.deviceManager.listAll.query({})),
      },
      () => Date.now(),
      undefined,
      site,
    )
  }
}

/** The evaluator a step run is given; `undefined` when the consumer has no door. */
export function stepConditionEvaluator(
  door: StepConditionDoor | undefined,
  readable?: readonly number[],
): EvaluateStepCondition | undefined {
  return door === undefined ? undefined : door(readable)
}

/** The `evaluateCondition` dep of a step run, or nothing (a guarded step then reads `unknown`). */
export function conditionDeps(evaluator: EvaluateStepCondition | undefined): {
  readonly evaluateCondition?: EvaluateStepCondition
} {
  return evaluator === undefined ? {} : { evaluateCondition: evaluator }
}
