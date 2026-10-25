/**
 * Record kinds owned by the benchmark addon: the accuracy evaluation's runs
 * and their per-sample outcomes (D901 — new state is a record kind).
 *
 * No side effects: the records guards import this module.
 */
import { defineRecordKinds } from '@camstack/types'
import { EvalRunBodySchema, EvalSampleBodySchema } from './benchmark-schemas.js'
import { EVAL_RUNS_KEPT_PER_DATASET_DEVICE } from './accuracy/eval-retention.js'

/** One `transact` may write a run and its samples together. */
const EVAL_FAMILY = 'accuracy-eval'

export const benchmarkRecordKinds = defineRecordKinds({
  'eval-run': {
    schema: EvalRunBodySchema,
    database: 'events',
    class: 'audit',
    writeTrigger:
      'an operator starts an accuracy evaluation of one dataset on one node×device with one pinned model; patched as it progresses and once when it is scored',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'dataset_device', fields: ['datasetId', 'deviceKey', 'createdAt'] }],
    retention: {
      owner: 'benchmark',
      reason: `the newest ${EVAL_RUNS_KEPT_PER_DATASET_DEVICE} runs per dataset×device are kept (evalRunsToTrim); a reference run is never trimmed; a trimmed run's eval-sample rows go with it`,
    },
    transactFamily: EVAL_FAMILY,
  },
  'eval-sample': {
    schema: EvalSampleBodySchema,
    database: 'events',
    class: 'audit',
    writeTrigger:
      'one row per dataset sample an evaluation run replayed — the slim detections of the full pass and the final output, the step timings, or the reason it did not run',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'run_sample', fields: ['runId', 'sampleId'], unique: true }],
    retention: {
      owner: 'benchmark',
      reason:
        'owned by its eval-run: deleted with the run (deleteWhere runId), never on a clock of its own',
    },
    transactFamily: EVAL_FAMILY,
  },
})
