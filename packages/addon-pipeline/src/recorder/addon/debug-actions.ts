/**
 * `debug.storeCensus` — arm / read the recorder's row-store call-site census
 * (`store/read-census.ts`) over `api.addons.custom`.
 *
 * Ships with a plain `camstack deploy packages/addon-pipeline` (a custom
 * action, not a capability — no framework train). Admin-only: the census
 * exposes source-line call sites, which is an implementation detail, not
 * operator-facing information.
 */
import { z } from 'zod'
import { customAction, defineCustomActions, type IScopedLogger } from '@camstack/types'
import { CENSUS_MAX_WINDOW_MS, logCensus, type StoreReadCensus } from './store/read-census.js'

/** How many call sites one census read may return. */
export const MAX_CENSUS_SITES = 200

/**
 * `armMs: 0` (or omitted) READS the window that already ran — that is how a
 * measurement is collected after its window closed, and re-arming to read
 * would throw away exactly the numbers being asked for (`StoreReadCensus.arm`
 * clears on every call).
 */
const StoreCensusInputSchema = z.object({
  armMs: z.number().int().min(0).max(CENSUS_MAX_WINDOW_MS).optional(),
  limit: z.number().int().positive().max(MAX_CENSUS_SITES).optional(),
})

const StoreCensusRowSchema = z.object({
  op: z.string(),
  site: z.string(),
  calls: z.number(),
  /** Calls extrapolated to a minute, directly comparable with the live-hub
   *  profiler's own `get recorder:recording-configs` rate. */
  perMin: z.number(),
  rows: z.number(),
})

const StoreCensusOutputSchema = z.object({
  armed: z.boolean(),
  elapsedMs: z.number(),
  sites: z.number(),
  calls: z.number(),
  rows: z.array(StoreCensusRowSchema).readonly(),
})

export const recorderDebugActions = defineCustomActions({
  'debug.storeCensus': customAction(StoreCensusInputSchema, StoreCensusOutputSchema, {
    auth: 'admin',
  }),
})

export type RecorderDebugActions = typeof recorderDebugActions
export type DebugStoreCensusInput = z.infer<typeof StoreCensusInputSchema>
export type DebugStoreCensusOutput = z.infer<typeof StoreCensusOutputSchema>

/**
 * Arm-or-read, pulled out of the addon class so it is testable without
 * booting `RecorderV2Addon` — feed it a bare `StoreReadCensus` and a logger.
 *
 * The result is also logged (via {@link logCensus}), because a measurement
 * that exists only in an HTTP response is a measurement that is gone when the
 * next session asks what happened.
 */
export function handleStoreCensusAction(
  census: StoreReadCensus,
  logger: IScopedLogger,
  input: DebugStoreCensusInput,
): DebugStoreCensusOutput {
  const limit = input.limit ?? MAX_CENSUS_SITES
  if (input.armMs !== undefined && input.armMs > 0) {
    census.arm(input.armMs)
    return { armed: true, elapsedMs: 0, sites: 0, calls: 0, rows: [] }
  }
  const rows = logCensus(census, logger, limit)
  const elapsedMs = census.elapsedMs()
  return {
    armed: census.armed,
    elapsedMs,
    sites: rows.length,
    calls: rows.reduce((acc, r) => acc + r.calls, 0),
    rows: rows.slice(0, limit).map((r) => ({
      op: r.op,
      site: r.site,
      calls: r.calls,
      perMin: elapsedMs === 0 ? 0 : Math.round((r.calls * 60_000) / elapsedMs),
      rows: r.rows,
    })),
  }
}
