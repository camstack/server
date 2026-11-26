/**
 * `ghostLocationSweep` — the operator's door to the ghost-location reconcile
 * (`ghost-location-sweep.ts`) over `api.addons.custom`.
 *
 * `apply: false` (the default) lists, decides and reports per camera what the
 * pass WOULD repoint (and to which location) and forget, and writes nothing.
 * `apply: true` performs exactly that over the same rows. Neither ever touches
 * a file or evicts: only the ledger rows and the resident index move.
 *
 * A dry run cannot foresee a `durable-refused` forget (the ledger refusing the
 * write), so its counts are an UPPER BOUND on forgets, not exactly what apply
 * does. Every pass, dry or applied, takes the same first
 * `GHOST_MAX_HOURS_PER_PASS` (16) hours; the rest are reported as
 * `hoursDeferred`, so repeated dry runs preview the same 16 hours.
 */
import { z } from 'zod'
import { customAction, defineCustomActions } from '@camstack/types'
import type { GhostPassRefusal, GhostSkipReason, GhostSweepResult } from './ghost-location-sweep.js'

const GhostLocationSweepInputSchema = z.object({
  apply: z.boolean().default(false),
})

const GhostDeviceReportSchema = z.object({
  deviceId: z.number(),
  repointedHours: z.number(),
  repointedSegments: z.number(),
  repointedTo: z.array(z.string()).readonly(),
  forgottenHours: z.number(),
  forgottenSegments: z.number(),
  forgottenBytes: z.number(),
  skippedHours: z.number(),
  skipReasons: z.array(z.string()).readonly(),
  probes: z.number(),
})

const GhostLocationSweepOutputSchema = z.object({
  applied: z.boolean(),
  refused: z.string().nullable(),
  ghostLocations: z.array(z.string()).readonly(),
  ghostHours: z.number(),
  hoursExamined: z.number(),
  hoursRepointed: z.number(),
  hoursForgotten: z.number(),
  segmentsRepointed: z.number(),
  segmentsForgotten: z.number(),
  bytesForgotten: z.number(),
  hoursSkipped: z.number(),
  skippedByReason: z.record(z.string(), z.number()),
  probes: z.number(),
  hoursDeferred: z.number(),
  devices: z.array(GhostDeviceReportSchema).readonly(),
})

export const ghostSweepActions = defineCustomActions({
  ghostLocationSweep: customAction(GhostLocationSweepInputSchema, GhostLocationSweepOutputSchema, {
    auth: 'admin',
  }),
})

export type GhostSweepActions = typeof ghostSweepActions
export type GhostLocationSweepInput = z.infer<typeof GhostLocationSweepInputSchema>

/** The answer when the sweeper is not armed (no ledger, recorder not ready): refusal `not-armed`. */
export function ghostSweepUnavailable(apply: boolean): GhostSweepResult {
  const reasons: Record<GhostSkipReason, number> = {
    'live-tail': 0,
    'detail-unavailable': 0,
    'no-paths': 0,
    'unparseable-paths': 0,
    'probe-error': 0,
    'found-at-multiple-roots': 0,
    'durable-refused': 0,
    'probe-budget': 0,
  }
  const refused: GhostPassRefusal = 'not-armed'
  return {
    applied: apply,
    devices: [],
    ghostLocations: [],
    ghostHours: 0,
    hoursExamined: 0,
    hoursRepointed: 0,
    hoursForgotten: 0,
    segmentsRepointed: 0,
    segmentsForgotten: 0,
    bytesForgotten: 0,
    hoursSkipped: 0,
    skippedByReason: reasons,
    probes: 0,
    hoursDeferred: 0,
    refused,
  }
}
