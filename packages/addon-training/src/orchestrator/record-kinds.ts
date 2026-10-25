/**
 * Record kinds owned by the training orchestrator (records plan phase 2).
 */
import { defineRecordKinds, RECORD_MAX_DATA_BYTES, TrainingJobSchema } from '@camstack/types'

export const trainingRecordKinds = defineRecordKinds({
  jobs: {
    schema: TrainingJobSchema,
    class: 'ledger',
    writeTrigger:
      'one row per training job, rewritten on every state change by the job engine (upload, submit, reconcile, collect, register, canary, rollback)',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'idem', fields: ['idempotencyKey'], unique: true }],
    retention: {
      none: 'a job row is the record of what ran; it leaves only when the operator deletes it',
    },
    // Frame id lists can push a job past the 64 KiB default.
    maxDataBytes: RECORD_MAX_DATA_BYTES,
  },
})
