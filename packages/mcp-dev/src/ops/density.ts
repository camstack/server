/**
 * `birth_decisions` and `event_density`: two named reads that were reachable
 * only through `hub_query` in P2. Each is one gated query plus the aggregate
 * a person would otherwise compute by hand.
 */
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { toToolOutput } from '@camstack/develop'
import { parseWire } from './wire.js'

const HOUR_MS = 3_600_000

const BirthRowSchema = z.looseObject({
  id: z.string(),
  at: z.number(),
  deviceId: z.number(),
  className: z.string(),
  verdict: z.enum(['confirmed', 'suppressed', 'exhausted-fallback']),
  reason: z.string().nullable().optional(),
  attempts: z.number().optional(),
  deferredForMs: z.number().optional(),
  birthLatencyMs: z.number().nullable().optional(),
  bestScore: z.number().nullable().optional(),
  appliedMinConfidence: z.number().nullable().optional(),
})
const BirthRowsSchema = z.array(BirthRowSchema)

export interface BirthDecisionsArgs {
  readonly deviceId?: number
  readonly hours?: number
  readonly verdict?: 'confirmed' | 'suppressed' | 'exhausted-fallback'
  readonly limit?: number
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx] ?? null
}

/** Verdict counts, per-class suppression, and birth-latency percentiles (D409). */
export async function birthDecisions(
  hub: OpsHub,
  args: BirthDecisionsArgs,
  now: number = Date.now(),
): Promise<unknown> {
  const hours = args.hours ?? 6
  const limit = args.limit ?? 200
  const raw = await hub.query('pipelineAnalytics.listBirthDecisions', {
    since: now - hours * HOUR_MS,
    limit,
    ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
    ...(args.verdict ? { verdict: args.verdict } : {}),
  })
  const rows = parseWire(BirthRowsSchema, raw, 'pipelineAnalytics.listBirthDecisions')
  const verdicts: Record<string, number> = {}
  const byClass: Record<string, Record<string, number>> = {}
  const latencies: number[] = []
  for (const row of rows) {
    verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1
    const perClass = (byClass[row.className] ??= {})
    perClass[row.verdict] = (perClass[row.verdict] ?? 0) + 1
    if (typeof row.birthLatencyMs === 'number') latencies.push(row.birthLatencyMs)
  }
  latencies.sort((a, b) => a - b)
  return toToolOutput({
    window: { hours, until: now },
    count: rows.length,
    capped: rows.length >= limit ? `limit ${limit} reached: a longer window is truncated` : null,
    verdicts,
    byClass,
    birthLatencyMs: {
      n: latencies.length,
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      max: latencies.at(-1) ?? null,
    },
    rows: rows.slice(0, 50),
  })
}

const DensityBucketSchema = z.looseObject({
  bucketStart: z.number(),
  motion: z.number(),
  object: z.number(),
  audio: z.number(),
})
const DensitySchema = z.array(DensityBucketSchema)

export interface EventDensityArgs {
  readonly deviceId: number
  readonly hours?: number
  readonly bucketMinutes?: number
}

/** Events per bucket (motion / object / audio) for one camera, with totals and the busiest buckets. */
export async function eventDensity(
  hub: OpsHub,
  args: EventDensityArgs,
  now: number = Date.now(),
): Promise<unknown> {
  const hours = args.hours ?? 24
  const bucketMs = (args.bucketMinutes ?? 60) * 60_000
  const raw = await hub.query('pipelineAnalytics.getEventDensity', {
    deviceId: args.deviceId,
    since: now - hours * HOUR_MS,
    until: now,
    bucketMs,
  })
  const buckets = parseWire(DensitySchema, raw, 'pipelineAnalytics.getEventDensity')
  const totals = { motion: 0, object: 0, audio: 0 }
  for (const b of buckets) {
    totals.motion += b.motion
    totals.object += b.object
    totals.audio += b.audio
  }
  const busiest = buckets
    .toSorted((a, b) => b.motion + b.object + b.audio - (a.motion + a.object + a.audio))
    .slice(0, 5)
  return toToolOutput({
    window: { hours, bucketMinutes: bucketMs / 60_000, until: now },
    buckets: buckets.length,
    totals,
    busiest,
    series: buckets,
  })
}
