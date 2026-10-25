/**
 * Delivery-history tests — history is a read-only VIEW over the durable
 * outbox (single source of truth; no second write path). Covers
 * `NcOutbox.queryHistory` (filters: ruleId / deviceId / status / since..until,
 * newest-first ordering, empty results, limit bound) and the guarantee that a
 * TERMINAL outbox transition (sent / dead) produces exactly one queryable
 * history row. Fake store + fake clock.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords } from './support/nc-test-deps.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { type NcDeliverResult, NcOutbox, type NcOutboxEnqueueInput } from '../outbox.js'

function makeInput(overrides: Partial<NcOutboxEnqueueInput> = {}): NcOutboxEnqueueInput {
  const deviceId = overrides.deviceId ?? 104
  return {
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    ...overrides,
    payload: {
      ruleName: 'person rule',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      subject: {
        deviceId,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        label: 'Alice',
        confidence: 0.9,
        zones: ['gate'],
        timestamp: 1_000,
      },
      ...overrides.payload,
    },
  }
}

interface Harness {
  readonly world: InMemoryRecords
  readonly outbox: NcOutbox
  setNow(ts: number): void
  setResult(result: NcDeliverResult): void
}

function makeHarness(): Harness {
  const world = makeNcRecords()
  let now = 100_000
  let result: NcDeliverResult = { ok: true }
  const outbox = new NcOutbox({
    records: world.records,
    logger: makeSilentLogger(),
    deliver: async () => result,
    now: () => now,
    maxAttempts: 1,
  })
  return {
    world,
    outbox,
    setNow: (ts) => {
      now = ts
    },
    setResult: (r) => {
      result = r
    },
  }
}

describe('NcOutbox.queryHistory (delivery history view)', () => {
  let h: Harness

  beforeEach(async () => {
    h = makeHarness()
  })

  it('returns an empty page when nothing has fired', async () => {
    expect(await h.outbox.queryHistory({ limit: 100 })).toEqual([])
  })

  it('surfaces a pending row (view spans every lifecycle state)', async () => {
    await h.outbox.enqueue([makeInput()])
    const rows = await h.outbox.queryHistory({ limit: 100 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.payload.ruleName).toBe('person rule')
    expect(rows[0]!.payload.subject.label).toBe('Alice')
  })

  it('a terminal SENT transition yields exactly one queryable row', async () => {
    await h.outbox.enqueue([makeInput()])
    await h.outbox.drainOnce() // → sent
    const rows = await h.outbox.queryHistory({ limit: 100 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('sent')
    // A re-query does not duplicate — single source of truth.
    expect(await h.outbox.queryHistory({ limit: 100 })).toHaveLength(1)
  })

  it('a terminal DEAD transition yields exactly one row carrying the error', async () => {
    h.setResult({ ok: false, error: 'target deleted', permanent: true })
    await h.outbox.enqueue([makeInput()])
    await h.outbox.drainOnce() // → dead
    const rows = await h.outbox.queryHistory({ limit: 100 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('dead')
    expect(rows[0]!.lastError).toBe('target deleted')
  })

  it('orders newest-first by fire time', async () => {
    h.setNow(100_000)
    await h.outbox.enqueue([makeInput({ ruleId: 'r-old', trackId: 'a' })])
    h.setNow(200_000)
    await h.outbox.enqueue([makeInput({ ruleId: 'r-new', trackId: 'b' })])
    const rows = await h.outbox.queryHistory({ limit: 100 })
    expect(rows.map((r) => r.ruleId)).toEqual(['r-new', 'r-old'])
  })

  it('filters by ruleId', async () => {
    await h.outbox.enqueue([makeInput({ ruleId: 'r-a', trackId: 'a' })])
    await h.outbox.enqueue([makeInput({ ruleId: 'r-b', trackId: 'b' })])
    const rows = await h.outbox.queryHistory({ ruleId: 'r-b', limit: 100 })
    expect(rows.map((r) => r.ruleId)).toEqual(['r-b'])
  })

  it('filters by deviceId', async () => {
    await h.outbox.enqueue([makeInput({ trackId: 'a', deviceId: 104 })])
    await h.outbox.enqueue([makeInput({ trackId: 'b', deviceId: 102 })])
    const rows = await h.outbox.queryHistory({ deviceId: 102, limit: 100 })
    expect(rows.map((r) => r.deviceId)).toEqual([102])
  })

  it('filters by status', async () => {
    await h.outbox.enqueue([makeInput({ ruleId: 'sent-rule', trackId: 'a' })])
    await h.outbox.drainOnce() // → sent
    await h.outbox.enqueue([makeInput({ ruleId: 'pending-rule', trackId: 'b' })])
    const sent = await h.outbox.queryHistory({ status: 'sent', limit: 100 })
    expect(sent.map((r) => r.ruleId)).toEqual(['sent-rule'])
    const pending = await h.outbox.queryHistory({ status: 'pending', limit: 100 })
    expect(pending.map((r) => r.ruleId)).toEqual(['pending-rule'])
  })

  it('filters by the since..until fire-time window', async () => {
    h.setNow(100_000)
    await h.outbox.enqueue([makeInput({ ruleId: 'early', trackId: 'a' })])
    h.setNow(200_000)
    await h.outbox.enqueue([makeInput({ ruleId: 'mid', trackId: 'b' })])
    h.setNow(300_000)
    await h.outbox.enqueue([makeInput({ ruleId: 'late', trackId: 'c' })])
    const rows = await h.outbox.queryHistory({ since: 150_000, until: 250_000, limit: 100 })
    expect(rows.map((r) => r.ruleId)).toEqual(['mid'])
  })

  it('bounds the page to the limit (newest kept)', async () => {
    for (let i = 0; i < 5; i += 1) {
      h.setNow(100_000 + i * 1_000)
      await h.outbox.enqueue([makeInput({ ruleId: `r-${i}`, trackId: `t-${i}` })])
    }
    const rows = await h.outbox.queryHistory({ limit: 2 })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.ruleId)).toEqual(['r-4', 'r-3'])
  })
})
