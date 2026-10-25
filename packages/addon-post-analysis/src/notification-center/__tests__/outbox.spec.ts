/**
 * NcOutbox unit tests — durable enqueue + dedup, the drain state machine
 * (sent / transient backoff / dead-letter / permanent), boot hydration,
 * watermark round-trip and terminal-row pruning. Fake store + fake clock.
 */
import type { InMemoryRecords } from '@camstack/types'
import { ncTable, makeNcRecords } from './support/nc-test-deps.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  type NcDeliverResult,
  NcOutbox,
  type NcOutboxEnqueueInput,
  type NcOutboxEntry,
} from '../outbox.js'
import { outboxEntryId } from '../outbox-key.js'

function makeInput(overrides: Partial<NcOutboxEnqueueInput> = {}): NcOutboxEnqueueInput {
  return {
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 104,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    payload: {
      ruleName: 'r',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      subject: {
        deviceId: 104,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        zones: [],
        timestamp: 1_000,
      },
    },
    ...overrides,
  }
}

interface Harness {
  readonly world: InMemoryRecords
  readonly outbox: NcOutbox
  readonly delivered: NcOutboxEntry[]
  setNow(ts: number): void
  setResult(result: NcDeliverResult | 'throw'): void
}

function makeHarness(opts: { maxAttempts?: number } = {}): Harness {
  const world = makeNcRecords()
  const delivered: NcOutboxEntry[] = []
  let now = 100_000
  let result: NcDeliverResult | 'throw' = { ok: true }
  const outbox = new NcOutbox({
    records: world.records,
    logger: makeSilentLogger(),
    deliver: async (entry) => {
      delivered.push(entry)
      if (result === 'throw') throw new Error('boom')
      return result
    },
    now: () => now,
    backoffBaseMs: 5_000,
    backoffCapMs: 60_000,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  })
  return {
    world,
    outbox,
    delivered,
    setNow: (ts) => {
      now = ts
    },
    setResult: (r) => {
      result = r
    },
  }
}

function rowStatus(world: InMemoryRecords, id: string): unknown {
  return ncTable(world, 'outbox').get(id)?.['status']
}

describe('NcOutbox', () => {
  let h: Harness

  beforeEach(async () => {
    h = makeHarness()
  })

  describe('enqueue', () => {
    it('persists a pending row keyed rule:track:target', async () => {
      const inserted = await h.outbox.enqueue([makeInput()])
      expect(inserted).toBe(1)
      const id = outboxEntryId(makeInput())
      expect(id).toBe('rule-1:trk-1:tgt-1')
      expect(rowStatus(h.world, id)).toBe('pending')
    })

    it('dedups by the unique key — maxPerTrack:1 durably (same track, later event)', async () => {
      await h.outbox.enqueue([makeInput({ recordId: 'ev-1' })])
      const again = await h.outbox.enqueue([makeInput({ recordId: 'ev-2' })])
      expect(again).toBe(0)
      expect(ncTable(h.world, 'outbox').size).toBe(1)
    })

    it('a track-less record dedups per record — its rowid GENERATION, never the id alone (D694)', async () => {
      const { trackId: _t, ...noTrack } = makeInput()
      await h.outbox.enqueue([noTrack])
      expect(await h.outbox.enqueue([noTrack])).toBe(0)
      expect(rowStatus(h.world, 'rule-1:ev-1@104:1000:tgt-1')).toBe('pending')
    })

    it('distinct targets of the same fire produce one row each', async () => {
      const n = await h.outbox.enqueue([makeInput(), makeInput({ targetId: 'tgt-2' })])
      expect(n).toBe(2)
    })
  })

  describe('drain state machine', () => {
    it('deliver ok → sent (terminal, persisted)', async () => {
      await h.outbox.enqueue([makeInput()])
      await h.outbox.drainOnce()
      expect(h.delivered).toHaveLength(1)
      expect(rowStatus(h.world, 'rule-1:trk-1:tgt-1')).toBe('sent')
      expect(h.outbox.pendingCount()).toBe(0)
      // A drained row is never re-attempted.
      await h.outbox.drainOnce()
      expect(h.delivered).toHaveLength(1)
    })

    it('transient failure → pending with exponential backoff', async () => {
      h.setResult({ ok: false, error: 'temporarily down', permanent: false })
      await h.outbox.enqueue([makeInput()])
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')!.get('rule-1:trk-1:tgt-1')!
      expect(row['status']).toBe('pending')
      expect(row['attempts']).toBe(1)
      expect(row['nextAttemptAt']).toBe(100_000 + 5_000)
      expect(row['lastError']).toBe('temporarily down')

      // Not yet due → skipped.
      await h.outbox.drainOnce()
      expect(h.delivered).toHaveLength(1)

      // Due again → attempt 2, backoff doubles.
      h.setNow(105_000)
      await h.outbox.drainOnce()
      expect(h.delivered).toHaveLength(2)
      const row2 = ncTable(h.world, 'outbox')!.get('rule-1:trk-1:tgt-1')!
      expect(row2['attempts']).toBe(2)
      expect(row2['nextAttemptAt']).toBe(105_000 + 10_000)
    })

    it('backoff is capped', async () => {
      h = makeHarness({ maxAttempts: 100 })
      h.setResult({ ok: false, error: 'down', permanent: false })
      await h.outbox.enqueue([makeInput()])
      let now = 100_000
      for (let i = 0; i < 8; i += 1) {
        h.setNow(now)
        await h.outbox.drainOnce()
        now = ncTable(h.world, 'outbox')!.get('rule-1:trk-1:tgt-1')!['nextAttemptAt'] as number
      }
      const row = ncTable(h.world, 'outbox')!.get('rule-1:trk-1:tgt-1')!
      const lastDelay = (row['nextAttemptAt'] as number) - (row['updatedAt'] as number)
      expect(lastDelay).toBe(60_000) // capMs
    })

    it('transient failures dead-letter after maxAttempts', async () => {
      h = makeHarness({ maxAttempts: 3 })
      h.setResult({ ok: false, error: 'down', permanent: false })
      await h.outbox.enqueue([makeInput()])
      for (const t of [100_000, 200_000, 300_000]) {
        h.setNow(t)
        await h.outbox.drainOnce()
      }
      expect(h.delivered).toHaveLength(3)
      const row = ncTable(h.world, 'outbox')!.get('rule-1:trk-1:tgt-1')!
      expect(row['status']).toBe('dead')
      expect(row['attempts']).toBe(3)
      expect(h.outbox.pendingCount()).toBe(0)
    })

    it('permanent failure dead-letters immediately', async () => {
      h.setResult({ ok: false, error: 'target deleted', permanent: true })
      await h.outbox.enqueue([makeInput()])
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')!.get('rule-1:trk-1:tgt-1')!
      expect(row['status']).toBe('dead')
      expect(row['lastError']).toBe('target deleted')
    })

    it('a thrown deliver is treated as transient', async () => {
      h.setResult('throw')
      await h.outbox.enqueue([makeInput()])
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')!.get('rule-1:trk-1:tgt-1')!
      expect(row['status']).toBe('pending')
      expect(row['attempts']).toBe(1)
    })

    it('drains oldest-first', async () => {
      await h.outbox.enqueue([makeInput({ ruleId: 'rule-A', trackId: 'a' })])
      h.setNow(110_000)
      await h.outbox.enqueue([makeInput({ ruleId: 'rule-B', trackId: 'b' })])
      h.setNow(120_000)
      await h.outbox.drainOnce()
      expect(h.delivered.map((e) => e.ruleId)).toEqual(['rule-A', 'rule-B'])
    })
  })

  describe('boot hydration (load)', () => {
    it('re-hydrates pending rows and the dedup horizon', async () => {
      await h.outbox.enqueue([makeInput()])
      // Fresh instance over the same store — simulates a respawn.
      const delivered2: NcOutboxEntry[] = []
      const outbox2 = new NcOutbox({
        records: h.world.records,
        logger: makeSilentLogger(),
        deliver: async (e) => {
          delivered2.push(e)
          return { ok: true }
        },
        now: () => 200_000,
      })
      await outbox2.load()
      expect(outbox2.pendingCount()).toBe(1)
      // Dedup survives the restart.
      expect(await outbox2.enqueue([makeInput({ recordId: 'ev-99' })])).toBe(0)
      await outbox2.drainOnce()
      expect(delivered2).toHaveLength(1)
      expect(rowStatus(h.world, 'rule-1:trk-1:tgt-1')).toBe('sent')
    })

    it('sent rows hydrate the dedup set but not the pending map', async () => {
      await h.outbox.enqueue([makeInput()])
      await h.outbox.drainOnce() // → sent
      const outbox2 = new NcOutbox({
        records: h.world.records,
        logger: makeSilentLogger(),
        deliver: async () => ({ ok: true }),
        now: () => 200_000,
      })
      await outbox2.load()
      expect(outbox2.pendingCount()).toBe(0)
      expect(await outbox2.enqueue([makeInput()])).toBe(0)
    })
  })

  describe('watermark', () => {
    it('round-trips through the meta collection', async () => {
      expect(await h.outbox.getWatermark()).toBeNull()
      await h.outbox.setWatermark(123_456)
      expect(await h.outbox.getWatermark()).toBe(123_456)
    })
  })

  describe('pruneBefore', () => {
    it('removes only TERMINAL rows older than the cutoff', async () => {
      await h.outbox.enqueue([makeInput({ ruleId: 'old-sent', trackId: 'a' })])
      await h.outbox.enqueue([makeInput({ ruleId: 'old-pending', trackId: 'b' })])
      h.setResult({ ok: true })
      // Only drain the first (batch order oldest-first, both same createdAt —
      // drain both, then re-flag the second back to pending manually).
      await h.outbox.drainOnce()
      // Both were drained to sent; rewrite one as pending to simulate.
      const pendingId = 'old-pending:b:tgt-1'
      const row = ncTable(h.world, 'outbox')!.get(pendingId)!
      h.world.seed('outbox', { id: pendingId, data: { ...row, status: 'pending' } })

      const pruned = await h.outbox.pruneBefore(150_000)
      expect(pruned).toBe(1)
      expect(ncTable(h.world, 'outbox')!.has('old-sent:a:tgt-1')).toBe(false)
      expect(ncTable(h.world, 'outbox')!.has(pendingId)).toBe(true)
    })
  })

  describe('AI confirm verdict', () => {
    /**
     * The audit half of the gate. "Why did I not get a notification at 04:12"
     * has to be answerable from SQLite months later, not from a log line that
     * rotated — and the verdict must land on the very row it decided about,
     * through the one write path delivery state already uses.
     */
    it('writes the verdict returned by the dispatcher onto the delivered row', async () => {
      await h.outbox.enqueue([makeInput()])
      h.setResult({
        ok: true,
        confirm: {
          decision: 'suppressed',
          reason: 'the bay is empty',
          count: 0,
          model: 'qwen/qwen3-vl-8b',
          latencyMs: 4400,
          at: 100_000,
        },
      })
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')?.get('rule-1:trk-1:tgt-1')
      expect(row?.['status']).toBe('sent')
      expect(row?.['payload']).toMatchObject({
        confirmVerdict: { decision: 'suppressed', reason: 'the bay is empty', count: 0 },
      })
    })

    it('leaves the payload untouched when no gate ran', async () => {
      await h.outbox.enqueue([makeInput()])
      h.setResult({ ok: true })
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')?.get('rule-1:trk-1:tgt-1')
      expect(row?.['payload']).not.toHaveProperty('confirmVerdict')
    })
  })

  describe('artifact ids (history → artefact reference)', () => {
    /**
     * The other half of "which picture fired this trigger": the dispatcher's
     * artefact-index ids land on the SAME row the drain loop drives, through
     * the SAME write `attempt()` already does for the confirm verdict — no
     * second write path, so `getHistory` can never name an artefact a
     * delivery did not actually produce.
     */
    it('writes the artifact ids the dispatcher returned onto the delivered row', async () => {
      await h.outbox.enqueue([makeInput()])
      h.setResult({ ok: true, artifactIds: ['art-still', 'art-gif'] })
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')?.get('rule-1:trk-1:tgt-1')
      expect(row?.['status']).toBe('sent')
      expect(row?.['payload']).toMatchObject({ artifactIds: ['art-still', 'art-gif'] })
    })

    it('leaves the payload untouched when nothing was indexed', async () => {
      await h.outbox.enqueue([makeInput()])
      h.setResult({ ok: true })
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')?.get('rule-1:trk-1:tgt-1')
      expect(row?.['payload']).not.toHaveProperty('artifactIds')
    })

    it('does not write an empty artifactIds array', async () => {
      await h.outbox.enqueue([makeInput()])
      h.setResult({ ok: true, artifactIds: [] })
      await h.outbox.drainOnce()
      const row = ncTable(h.world, 'outbox')?.get('rule-1:trk-1:tgt-1')
      expect(row?.['payload']).not.toHaveProperty('artifactIds')
    })
  })

  describe('tryQueryRecentPersisted', () => {
    it('returns persisted rows since a timestamp (cooldown seeding)', async () => {
      await h.outbox.enqueue([makeInput()])
      const rows = (await h.outbox.tryQueryRecentPersisted(50_000)) ?? []
      expect(rows).toHaveLength(1)
      expect(rows[0]!.ruleId).toBe('rule-1')
      expect(rows[0]!.createdAt).toBe(100_000)
      expect(await h.outbox.tryQueryRecentPersisted(150_000)).toHaveLength(0)
    })
  })

  /**
   * The COMBINED alarm notification's other half. When the alarm's own row
   * carries the pictures, the detection row that was about to say the same
   * thing must not also go out — but only for the people the alarm reached.
   */
  describe('supersede', () => {
    it('drops a still-pending row for the named targets and leaves the others', async () => {
      await h.outbox.enqueue([makeInput({ targetId: 'tgt-1' }), makeInput({ targetId: 'tgt-2' })])
      expect(h.outbox.pendingCount()).toBe(2)
      const dropped = await h.outbox.supersede({
        ruleId: 'rule-1',
        recordId: 'ev-1',
        deviceId: 104,
        recordAt: 1_000,
        targetIds: ['tgt-1'],
      })
      expect(dropped).toBe(1)
      expect(h.outbox.pendingCount()).toBe(1)
      expect(ncTable(h.world, 'outbox')?.has('rule-1:trk-1:tgt-1')).toBe(false)
      // The row that WAS superseded must never be re-enqueued by a replay.
      await h.outbox.enqueue([makeInput({ targetId: 'tgt-1' })])
      expect(h.outbox.pendingCount()).toBe(1)
    })

    it('refuses to touch a row that has already been SENT', async () => {
      await h.outbox.enqueue([makeInput()])
      h.setResult({ ok: true })
      await h.outbox.drainOnce()
      const dropped = await h.outbox.supersede({
        ruleId: 'rule-1',
        recordId: 'ev-1',
        deviceId: 104,
        recordAt: 1_000,
        targetIds: ['tgt-1'],
      })
      expect(dropped).toBe(0)
      expect(ncTable(h.world, 'outbox')?.get('rule-1:trk-1:tgt-1')?.['status']).toBe('sent')
    })

    it('never touches another rule or another record', async () => {
      await h.outbox.enqueue([makeInput(), makeInput({ ruleId: 'rule-2' })])
      const record = { recordId: 'ev-1', deviceId: 104, recordAt: 1_000 }
      expect(await h.outbox.supersede({ ruleId: 'rule-9', ...record, targetIds: ['tgt-1'] })).toBe(
        0,
      )
      expect(
        await h.outbox.supersede({
          ruleId: 'rule-1',
          ...record,
          recordId: 'ev-9',
          targetIds: ['tgt-1'],
        }),
      ).toBe(0)
      expect(h.outbox.pendingCount()).toBe(2)
    })
  })
})
