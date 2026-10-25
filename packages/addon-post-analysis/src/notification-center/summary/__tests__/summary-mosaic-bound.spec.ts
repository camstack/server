/**
 * The mosaic's owner and its BOUND (D480).
 *
 * 675 delivered digest mosaics — 271 MiB on one camera, one rule, growing
 * ~27 MiB/day — accumulated because the writer filed them under a synthetic
 * `summary-<ruleId>-<windowEndMs>` id in a table's namespace (`event`, then
 * `object`). Nothing owned them, so nothing bounded them and no sweep could
 * safely collect them.
 *
 * What has to hold now: the owner kind is the mosaic's own, the owner id is
 * the RULE, the count per rule is bounded BY THE WRITER, and every eviction
 * goes through the delete that confirms its blob.
 */
import { describe, expect, it } from 'vitest'
import type { MediaFileRef } from '@camstack/types'
import { makeLogRecorder } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import {
  isWriterBoundedOwnerKind,
  OWNER_KINDS,
  SUMMARY_MOSAIC_OWNER_KIND,
} from '../../../pipeline-analytics/store/media-store.js'
import {
  boundRuleMosaics,
  fileSummaryMosaic,
  mosaicOwnerId,
  mosaicsToEvict,
  SUMMARY_MOSAIC_DEFAULT_WINDOW_MS,
  type SummaryMosaicPorts,
} from '../summary-mosaic.js'

function ref(mediaId: number, timestamp: number, sizeBytes = 400_000): MediaFileRef {
  return { mediaId, kind: 'fullFrame', timestamp, sizeBytes }
}

interface Harness {
  readonly ports: SummaryMosaicPorts
  readonly written: { ownerId: string; timestamp: number }[]
  readonly deleted: number[]
  readonly logs: ReturnType<typeof makeLogRecorder>
}

function harness(input: {
  held?: readonly MediaFileRef[]
  /** Media ids whose blob refuses to go — `deleteConfirmed` throws. */
  unlinkFails?: readonly number[]
}): Harness {
  const written: { ownerId: string; timestamp: number }[] = []
  const deleted: number[] = []
  const logs = makeLogRecorder()
  const unlinkFails = new Set(input.unlinkFails ?? [])
  const held = [...(input.held ?? [])]
  // Rowids start where SQLite's do, and a `held` seeded by a caller may already
  // occupy some — so start past the highest rather than at 1.
  let nextMediaId = held.reduce((max, r) => Math.max(max, r.mediaId), 0) + 1
  return {
    written,
    deleted,
    logs,
    ports: {
      // Mints a rowid the way SQLite does, because production's `put` answers
      // with the id the row REALLY got (D482). A fake that answered a composite
      // key would keep this spec green against a shape production no longer
      // produces — which is how the previous version of this file passed.
      put: async ({ ownerId, timestamp }) => {
        written.push({ ownerId, timestamp })
        const mediaId = nextMediaId++
        held.push(ref(mediaId, timestamp))
        return mediaId
      },
      // The store answers oldest-first; the bound must not trust the order.
      listInfo: async () => [...held].sort((a, b) => a.timestamp - b.timestamp),
      deleteConfirmed: async (mediaId) => {
        if (unlinkFails.has(mediaId)) throw new Error(`media blob survived its delete: ${mediaId}`)
        const row = held.find((r) => r.mediaId === mediaId)
        const at = held.findIndex((r) => r.mediaId === mediaId)
        if (at >= 0) held.splice(at, 1)
        deleted.push(mediaId)
        return { rows: 1, bytes: row?.sizeBytes ?? 0 }
      },
      logger: logs.logger,
    },
  }
}

describe('the mosaic owner', () => {
  it('is a declared owner kind whose lifetime the WRITER owns', () => {
    expect(OWNER_KINDS).toContain(SUMMARY_MOSAIC_OWNER_KIND)
    expect(isWriterBoundedOwnerKind(SUMMARY_MOSAIC_OWNER_KIND)).toBe(true)
  })

  it('is the RULE, not a window-stamped string', () => {
    expect(mosaicOwnerId('rule-1')).toBe('rule-1')
    expect(mosaicOwnerId('rule-1')).not.toContain('summary-')
  })

  it('leaves the caller no owner kind to choose', () => {
    const h = harness({})
    // The port carries deviceId/ownerId/timestamp/jpeg and nothing else: the
    // owner kind is decided once, in the wiring. A third borrowed kind has to
    // be a type error, not a review catch.
    void h.ports.put({
      deviceId: 1,
      ownerId: 'r',
      timestamp: 0,
      jpeg: Buffer.alloc(0),
    })
  })
})

describe('mosaicsToEvict', () => {
  it('evicts by age, whatever order it was handed', () => {
    const rows = [ref(1, 300), ref(2, 100), ref(3, 200)]
    expect(
      mosaicsToEvict(rows, { olderThanMs: 250 })
        .map((r) => r.mediaId)
        .toSorted(),
    ).toEqual([2, 3])
    expect(mosaicsToEvict(rows, { olderThanMs: 50 })).toEqual([])
    expect(
      mosaicsToEvict(rows, { all: true })
        .map((r) => r.mediaId)
        .toSorted(),
    ).toEqual([1, 2, 3])
  })

  it('has a bound at all — the property that was missing', () => {
    expect(SUMMARY_MOSAIC_DEFAULT_WINDOW_MS).toBeGreaterThan(0)
    expect(Number.isFinite(SUMMARY_MOSAIC_DEFAULT_WINDOW_MS)).toBe(true)
  })
})

describe('the write path holds the rule to its bound', () => {
  it('files the mosaic and evicts everything past the bound, through the CONFIRMED delete', async () => {
    const held = Array.from({ length: 4 }, (_u, i) => ref(i + 1, 1_000 + i))
    const h = harness({ held })
    const mediaId = await fileSummaryMosaic(h.ports, {
      deviceId: 101,
      ruleId: 'rule-1',
      timestamp: 9_000,
      jpeg: Buffer.from('jpeg'),
      olderThanMs: 1_003,
    })
    expect(mediaId).toBe(5)
    expect(h.written).toEqual([{ ownerId: 'rule-1', timestamp: 9_000 }])
    // Held are at 1000..1003; the cutoff is 1003, so the three strictly older
    // go and the one written AT the cutoff stays, alongside the new one.
    expect(h.deleted.toSorted()).toEqual([1, 2, 3])
  })

  it('never costs the write: a bound that throws leaves the mosaic filed', async () => {
    const h = harness({ held: [ref(1, 1)] })
    const ports: SummaryMosaicPorts = {
      ...h.ports,
      listInfo: async () => {
        throw new Error('store unreachable')
      },
    }
    const mediaId = await fileSummaryMosaic(ports, {
      deviceId: 101,
      ruleId: 'rule-1',
      timestamp: 9_000,
      jpeg: Buffer.from('jpeg'),
      olderThanMs: Number.MAX_SAFE_INTEGER,
    })
    // One mosaic was already held (id 1), so the write gets the next rowid.
    expect(mediaId).toBe(2)
    expect(h.logs.entries.some((e) => e.level === 'warn' && e.message.includes('bound'))).toBe(true)
  })

  it('KEEPS a mosaic whose blob could not be confirmed gone, and says so', async () => {
    const h = harness({ held: [ref(1, 1), ref(2, 2)], unlinkFails: [1] })
    const result = await boundRuleMosaics(h.ports, { ruleId: 'rule-1', rule: { all: true } })
    expect(h.deleted).toEqual([2])
    expect(result.failed).toBe(1)
    expect(result.evicted).toBe(1)
    expect(result.bytes).toBe(400_000)
    expect(
      h.logs.entries.some(
        (e) => e.level === 'warn' && e.message.includes('could not be confirmed'),
      ),
    ).toBe(true)
  })

  it('a deleted rule takes its mosaics with it — { all: true } frees every one', async () => {
    const h = harness({ held: [ref(1, 1), ref(2, 2), ref(3, 3)] })
    const result = await boundRuleMosaics(h.ports, { ruleId: 'rule-1', rule: { all: true } })
    expect(h.deleted.toSorted()).toEqual([1, 2, 3])
    expect(result.bytes).toBe(1_200_000)
  })
})
