/**
 * Which evaluation runs retention removes — pure, so the rule is a spec.
 *
 * The rule: per (dataset × device) the newest {@link EVAL_RUNS_KEPT_PER_DATASET_DEVICE}
 * runs stay; a REFERENCE run is never trimmed and does not take one of those
 * slots (it is the baseline the others are diffed against, and losing it
 * silently would turn every later diff into a diff against nothing). A run's
 * `eval-sample` rows go with it — they have no clock of their own.
 *
 * The engine cannot express this bound (`maxRowsPerDevice` keys on a device
 * id, and the exemption is a body field), so the kinds declare
 * `retention: { owner }` and the benchmark addon sweeps with this verdict.
 */
import type { EvalRunBody } from '../benchmark-schemas.js'

export const EVAL_RUNS_KEPT_PER_DATASET_DEVICE = 10

/** One stored run as retention sees it. */
export interface EvalRunRow {
  readonly id: string
  readonly body: Pick<EvalRunBody, 'datasetId' | 'deviceKey' | 'createdAt' | 'isReference'>
}

/** The ids of the runs to delete, oldest first within each (dataset × device). */
export function evalRunsToTrim(
  runs: readonly EvalRunRow[],
  keep: number = EVAL_RUNS_KEPT_PER_DATASET_DEVICE,
): readonly string[] {
  const groups = new Map<string, EvalRunRow[]>()
  for (const run of runs) {
    if (run.body.isReference) continue
    const key = JSON.stringify([run.body.datasetId, run.body.deviceKey])
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const trimmed: string[] = []
  for (const group of groups.values()) {
    const newestFirst = group.toSorted(
      (a, b) => b.body.createdAt - a.body.createdAt || b.id.localeCompare(a.id),
    )
    trimmed.push(
      ...newestFirst
        .slice(Math.max(0, keep))
        .toReversed()
        .map((r) => r.id),
    )
  }
  return trimmed
}
