import { describe, it, expect } from 'vitest'
import { aiRecordKinds, USAGE_RETENTION_MS } from '../record-kinds.js'
import { UsageStore } from '../usage/usage-store.js'
import type { UsageRowInput } from '../usage/usage-port.js'
import { makeAiRecords } from './support/fake-records.js'
import { createTestLogger } from './support/logger.js'

const DAY = 24 * 60 * 60 * 1000

function row(overrides: Partial<UsageRowInput> = {}): UsageRowInput {
  return {
    ts: Date.parse('2026-07-15T10:00:00Z'),
    consumer: 'ai-summary',
    profileId: 'p1',
    kind: 'openai',
    model: 'gpt-4o-mini',
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
    ok: true,
    imageCount: 0,
    ...overrides,
  }
}

async function newStore() {
  const world = await makeAiRecords()
  return { world, store: UsageStore.of(world.records) }
}

describe('UsageStore', () => {
  it('declares the 90-day TTL from `at` and no budgets kind (D881 phase 0)', () => {
    const decl = aiRecordKinds.usage.declaration
    expect(decl.at).toBe('required')
    expect(decl.retention).toEqual({ ttlMs: USAGE_RETENTION_MS, from: 'at' })
    expect(USAGE_RETENTION_MS).toBe(90 * DAY)
    expect(Object.keys(aiRecordKinds)).not.toContain('budgets')
  })

  it('records one row per call (ok and error shapes), with `at` = the call time', async () => {
    const { world, store } = await newStore()
    await store.record(row())
    await store.record(row({ ok: false, errorCode: 'timeout' }))
    const stored = [...(world.tables.get('usage')?.values() ?? [])]
    expect(stored).toHaveLength(2)
    expect(stored.every((r) => r.at === Date.parse('2026-07-15T10:00:00Z'))).toBe(true)
    // the call time is the record clock, not a duplicated body field
    expect(stored.every((r) => !('ts' in r.data))).toBe(true)
  })

  it('the engine TTL stamps expiry 90 days after the call, so the sweep ages it out', async () => {
    const { world, store } = await newStore()
    const ts = Date.parse('2026-07-15T10:00:00Z')
    await store.record(row({ ts }))
    await store.record(row({ ts: ts + 95 * DAY }))
    const expiries = [...(world.tables.get('usage')?.values() ?? [])].map((r) => r.expiresAt)
    expect(expiries).toEqual([ts + 90 * DAY, ts + 95 * DAY + 90 * DAY])
    expect(world.sweep(ts + 91 * DAY)).toBe(1)
    const rollup = await store.rollup({})
    expect(rollup.reduce((sum, r) => sum + r.calls, 0)).toBe(1)
  })

  it('rollup groups by (UTC day, consumer, profileId)', async () => {
    const { store } = await newStore()
    await store.record(row())
    await store.record(
      row({
        ok: false,
        errorCode: 'timeout',
        inputTokens: 3,
        outputTokens: 0,
        latencyMs: 300,
      }),
    )
    const rollup = await store.rollup({})
    expect(rollup).toHaveLength(1)
    expect(rollup[0]).toMatchObject({
      day: '2026-07-15',
      consumer: 'ai-summary',
      profileId: 'p1',
      calls: 2,
      okCalls: 1,
      errorCalls: 1,
      inputTokens: 13,
      outputTokens: 5,
      avgLatencyMs: 200,
    })
  })

  it('filters by since/until and consumer/profileId', async () => {
    const { store } = await newStore()
    await store.record(row({ ts: Date.parse('2026-07-10T00:00:00Z') }))
    await store.record(row({ ts: Date.parse('2026-07-15T00:00:00Z'), consumer: 'other' }))
    const filtered = await store.rollup({
      since: Date.parse('2026-07-12T00:00:00Z'),
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.consumer).toBe('other')
    const until = await store.rollup({ until: Date.parse('2026-07-12T00:00:00Z') })
    expect(until).toHaveLength(1)
    expect(until[0]?.consumer).toBe('ai-summary')
    const byConsumer = await store.rollup({ consumer: 'other' })
    expect(byConsumer).toHaveLength(1)
  })

  it('rows missing profileId roll up under empty profileId', async () => {
    const { store } = await newStore()
    await store.record(row({ profileId: undefined }))
    const rollup = await store.rollup({})
    expect(rollup[0]?.profileId).toBe('')
  })

  it('rolls up an adopted error row (no profile/kind/model keys)', async () => {
    const { world, store } = await newStore()
    world.seed('usage', {
      id: 'err-row',
      at: Date.parse('2026-07-15T11:00:00Z'),
      data: {
        consumer: 'notifier-rules',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 300,
        ok: false,
        errorCode: 'no-profile',
        imageCount: 0,
      },
    })
    const rollup = await store.rollup({})
    expect(rollup.find((r) => r.profileId === '')?.errorCalls).toBe(1)
  })

  it('says how many rows it discarded instead of answering "no usage" silently', async () => {
    const world = await makeAiRecords()
    const log = createTestLogger()
    const store = UsageStore.of(world.records, log.logger)
    world.seed('usage', { id: 'bad', at: 1, data: { consumer: 5 } })
    await store.record(row())
    const rollup = await store.rollup({})
    expect(rollup.reduce((sum, r) => sum + r.calls, 0)).toBe(1)
    expect(log.entries.map((e) => e.message)).toContain('usage rollup discarded unparseable rows')
  })
})
