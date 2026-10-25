/**
 * The per-runner series are written at device-history's cadence, never at the
 * snapshot's.
 *
 * Process snapshots arrive every 5 s; device-history holds a point series to
 * one point per 10 s (`rate`). Writing every snapshot meant every other
 * batch was refused whole — on the prod hub `accepted: 0, refused: { rate:
 * 291 }` every ~20 s for each node. The producer now downsamples on the same
 * slot grid the ingest door applies, so nothing it sends is refused for rate.
 *
 * The door here is the REAL `ProducerIngest` rule, not a fake that agrees
 * with the producer: a fake would vouch for whatever cadence the recorder
 * picked.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DeviceHistoryIngestResult, IScopedLogger } from '@camstack/types'
import {
  RECORD_MIN_INTERVAL_MS,
  RECORD_RATE_SLACK_MS,
} from '../../device-history/ingest/producer-ingest.js'
import {
  NodeMetricsHistoryRecorder,
  RUNNER_SAMPLE_MIN_INTERVAL_MS,
  RUNNER_SAMPLE_RATE_SLACK_MS,
  type NodeHistoryPoint,
  type NodeMetricsHistoryClient,
} from '../node-metrics-history-recorder.js'
import type { RetainedProcess } from '../load-series-types.js'

/** device-history's point door, rule for rule (`producer-ingest.ts` `record`). */
function rateDoor(): (points: readonly NodeHistoryPoint[]) => DeviceHistoryIngestResult {
  const slots = new Map<string, { lastTs: number; nextDue: number }>()
  return (points) => {
    let accepted = 0
    let refused = 0
    for (const p of points) {
      const id = `${p.key}|${p.subject.nodeId}|${p.scope}`
      const slot = slots.get(id)
      if (slot !== undefined && p.ts >= slot.lastTs && p.ts < slot.nextDue - RECORD_RATE_SLACK_MS) {
        refused += 1
        continue
      }
      slots.set(
        id,
        slot === undefined
          ? { lastTs: p.ts, nextDue: p.ts + RECORD_MIN_INTERVAL_MS }
          : p.ts < slot.lastTs
            ? slot
            : {
                lastTs: p.ts,
                nextDue: Math.max(slot.nextDue, p.ts) + RECORD_MIN_INTERVAL_MS,
              },
      )
      accepted += 1
    }
    return {
      accepted,
      refused: refused > 0 ? [{ key: 'any', reason: 'rate', count: refused }] : [],
    }
  }
}

function harness() {
  const door = rateDoor()
  const results: DeviceHistoryIngestResult[] = []
  const warn = vi.fn()
  const noop = vi.fn()
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  const client: NodeMetricsHistoryClient = {
    declareSeries: async (input) => ({
      key: `addon:metrics-native/${input.name}`,
    }),
    record: async (input) => {
      const result = door(input.points)
      results.push(result)
      return result
    },
    queryNode: async () => ({ series: [] }),
  }
  return {
    rec: new NodeMetricsHistoryRecorder({ deviceHistory: client, logger }),
    results,
    warn,
  }
}

const proc: RetainedProcess = {
  pid: 42,
  addonId: 'pipeline',
  classification: 'managed',
  cpuPercent: 10,
  memoryRssBytes: 100 * 1_048_576,
  cpuMainPercent: 4,
  cpuGcPercent: 1,
}

describe('per-runner history cadence', () => {
  it('mirrors the ingest door rule exactly — one authority, two copies pinned equal', () => {
    expect(RUNNER_SAMPLE_MIN_INTERVAL_MS).toBe(RECORD_MIN_INTERVAL_MS)
    expect(RUNNER_SAMPLE_RATE_SLACK_MS).toBe(RECORD_RATE_SLACK_MS)
  })

  it('a 5 s snapshot stream, with tick jitter, is never refused for rate', async () => {
    const { rec, results, warn } = harness()
    const t0 = 1_800_000_000_000
    // A minute of 5 s ticks, each a few ms early or late.
    for (let i = 0; i < 13; i += 1) {
      const jitter = i % 2 === 0 ? -7 : 11
      await rec.recordSample('hub', t0 + i * 5_000 + jitter, [proc], null)
    }
    expect(results.flatMap((r) => r.refused)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    // One batch per 10 s: t0, +10, +20 … +60 — seven, not thirteen.
    expect(results.length).toBe(7)
    expect(results.every((r) => r.accepted === 5)).toBe(true)
  })

  it('downsamples per NODE: one node’s write never spends another node’s slot', async () => {
    const { rec, results } = harness()
    await rec.recordSample('hub', 1_000, [proc], null)
    await rec.recordSample('agent-a', 1_000, [proc], null)
    expect(results.length).toBe(2)
  })
})
