/**
 * The reclaim's refusals, each on a fixture where the refusal and its absence
 * produce VISIBLY different numbers — never `expected 0 to be 1`, which is
 * also what "the pass did nothing" prints.
 */
import { describe, expect, it } from 'vitest'
import { makeLogRecorder, type LogRecorder } from '../../__tests__/test-helpers.js'
import type { MediaReclaimCandidate } from '../../store/media-store.js'
import {
  DEFAULT_MEDIA_RECLAIM_LIMITS,
  type MediaReclaimDeps,
  type MediaReclaimLimits,
  type MediaReclaimScope,
  reclaimDeviceScope,
  runMediaReclaim,
} from '../media-reclaim.js'

const NOW = 1_788_000_000_000
const OLD = NOW - 24 * 3600_000

// A media row's own id is a rowid (D482) — here just the row's sequence
// number, an arbitrary positive integer unrelated to owner or kind.
const row = (n: number, owner: string, bytes = 95_000): MediaReclaimCandidate => ({
  mediaId: n,
  ownerId: owner,
  timestamp: OLD + n,
  sizeBytes: bytes,
})

interface Harness {
  readonly deps: MediaReclaimDeps
  readonly deleted: number[]
  readonly log: LogRecorder
}

function harness(input: {
  rows: readonly MediaReclaimCandidate[]
  motionOwners?: readonly string[]
  pinnedOwners?: readonly string[]
  probeThrows?: boolean
  failDeleteFor?: (mediaId: number) => boolean
}): Harness {
  const deleted: number[] = []
  const log = makeLogRecorder()
  const remaining = [...input.rows]
  const deps: MediaReclaimDeps = {
    page: async ({ afterMs, limit }) =>
      remaining
        .filter((r) => r.timestamp >= afterMs && !deleted.includes(r.mediaId))
        .slice(0, limit),
    motionEventIds: async (ids) => {
      if (input.probeThrows === true) throw new Error('collection unreachable')
      const allow = new Set(input.motionOwners ?? [])
      return new Set(ids.filter((id) => allow.has(id)))
    },
    pinnedTrackIds: async (ids) => {
      if (input.probeThrows === true) throw new Error('collection unreachable')
      const pinned = new Set(input.pinnedOwners ?? [])
      return new Set(ids.filter((id) => pinned.has(id)))
    },
    reclaim: async (mediaId) => {
      if (input.failDeleteFor?.(mediaId) === true) {
        throw new Error(`media blob survived its delete: ${mediaId}`)
      }
      const found = remaining.find((r) => r.mediaId === mediaId)
      deleted.push(mediaId)
      return { rows: 1, bytes: found?.sizeBytes ?? 0 }
    },
    now: () => NOW,
    logger: log.logger,
  }
  return { deps, deleted, log }
}

const limits = (over: Partial<MediaReclaimLimits> = {}): MediaReclaimLimits => ({
  ...DEFAULT_MEDIA_RECLAIM_LIMITS,
  mode: 'reclaim',
  pageSize: 100,
  ...over,
})

const walk = (
  h: Harness,
  scope: MediaReclaimScope,
  over: Partial<MediaReclaimLimits> = {},
): ReturnType<typeof reclaimDeviceScope> =>
  reclaimDeviceScope({
    deviceId: 103,
    scope,
    cursor: 0,
    deps: h.deps,
    limits: limits(over),
    deadlineMs: NOW + 60_000,
    byteBudget: DEFAULT_MEDIA_RECLAIM_LIMITS.maxBytesPerRun,
  })

describe('media reclaim — motion stills', () => {
  it('report mode counts every eligible row and deletes none', async () => {
    const h = harness({
      rows: [row(1, 'ev-a'), row(2, 'ev-b'), row(3, 'ev-c')],
      motionOwners: ['ev-a', 'ev-b', 'ev-c'],
    })
    const r = await walk(h, 'motion-still', { mode: 'report' })
    expect(r.eligible).toBe(3)
    expect(r.reclaimed).toBe(0)
    expect(h.deleted).toEqual([])
  })

  it('reclaims the motion stills and accounts the bytes', async () => {
    const h = harness({
      rows: [row(1, 'ev-a'), row(2, 'ev-b'), row(3, 'ev-c')],
      motionOwners: ['ev-a', 'ev-b', 'ev-c'],
    })
    const r = await walk(h, 'motion-still')
    expect(r.reclaimed).toBe(3)
    expect(r.bytesReclaimed).toBe(285_000)
    expect(r.stoppedBy).toBe('exhausted')
  })

  /**
   * DISARM TARGET: the `!motionOwners.has(row.ownerId)` guard.
   *
   * The fixture makes the two outcomes different by COUNT, not by
   * zero-versus-one: 2 of 5 selected rows belong to something that is not a
   * motion event. Guard on → 3 deleted, 2 unresolved. Guard off → 5 deleted,
   * 0 unresolved. Neither number is 0, so "did nothing" cannot pass.
   */
  it('refuses a selected row whose owner is not a motion event', async () => {
    const h = harness({
      rows: [row(1, 'ev-a'), row(2, 'obj-1'), row(3, 'ev-b'), row(4, 'audio-9'), row(5, 'ev-c')],
      motionOwners: ['ev-a', 'ev-b', 'ev-c'],
    })
    const r = await walk(h, 'motion-still')
    expect(r.reclaimed).toBe(3)
    expect(r.unresolved).toBe(2)
    expect(h.deleted).toEqual([1, 3, 5])
  })

  it('a row younger than the grace window is left alone', async () => {
    const h = harness({
      rows: [
        { mediaId: 999, ownerId: 'ev-a', timestamp: NOW - 60_000, sizeBytes: 95_000 },
        row(1, 'ev-b'),
        row(2, 'ev-c'),
      ],
      motionOwners: ['ev-a', 'ev-b', 'ev-c'],
    })
    const r = await walk(h, 'motion-still')
    expect(r.withinGrace).toBe(1)
    expect(r.reclaimed).toBe(2)
    expect(h.deleted).not.toContain(999)
  })
})

describe('media reclaim — a pin must survive it', () => {
  /**
   * DISARM TARGET: the `pinnedOwners.has(row.ownerId)` guard.
   *
   * 4 filmstrip rows across 4 tracks; two of those tracks are pinned
   * (`staging` / `favourited`). Guard on → 2 deleted, 2 held. Guard off → 4
   * deleted, 0 held. Both outcomes are non-zero and name different keys.
   */
  it('never deletes the filmstrip of a staging or favourited track', async () => {
    const h = harness({
      rows: [
        row(1, 'trk-plain-1'),
        row(2, 'trk-staging'),
        row(3, 'trk-plain-2'),
        row(4, 'trk-favourite'),
      ],
      pinnedOwners: ['trk-staging', 'trk-favourite'],
    })
    const r = await walk(h, 'track-filmstrip')
    expect(r.reclaimed).toBe(2)
    expect(r.held).toBe(2)
    expect(h.deleted).toEqual([1, 3])
    expect(h.deleted).not.toContain(2)
    expect(h.deleted).not.toContain(4)
  })
})

describe('media reclaim — confirm before forgetting (D148)', () => {
  /**
   * DISARM TARGET: the `catch` around `deps.reclaim` that counts `refused`
   * and halts, versus swallowing and continuing.
   *
   * Row 2 of 4 refuses. The contract has three visible consequences and the
   * fixture separates all three: the refusing row is NOT deleted, the rows
   * AFTER it are not deleted either (the scope stops rather than stepping
   * over an unfinished row), and the cursor stays at the last row the pass
   * actually finished — so a resume re-offers the refusal instead of
   * skipping it forever.
   */
  it('a row whose blob delete fails is refused, not forgotten, and stops the scope', async () => {
    const h = harness({
      rows: [row(1, 'ev-a'), row(2, 'ev-b'), row(3, 'ev-c'), row(4, 'ev-d')],
      motionOwners: ['ev-a', 'ev-b', 'ev-c', 'ev-d'],
      failDeleteFor: (mediaId) => mediaId === 2,
    })
    const r = await walk(h, 'motion-still')
    expect(r.reclaimed).toBe(1)
    expect(r.refused).toBe(1)
    expect(r.stoppedBy).toBe('delete-refused')
    expect(h.deleted).toEqual([1])
    // The cursor stopped at row 1 — the last one it finished. Row 2 is offered
    // again next run; it is not stepped over.
    expect(r.nextCursor).toBe(OLD + 1)
  })

  it('a resumed run re-offers the refused row rather than skipping past it', async () => {
    const h = harness({
      rows: [row(1, 'ev-a'), row(2, 'ev-b'), row(3, 'ev-c')],
      motionOwners: ['ev-a', 'ev-b', 'ev-c'],
      failDeleteFor: (mediaId) => mediaId === 2,
    })
    const first = await walk(h, 'motion-still')
    const second = await reclaimDeviceScope({
      deviceId: 103,
      scope: 'motion-still',
      cursor: first.nextCursor,
      deps: h.deps,
      limits: limits(),
      deadlineMs: NOW + 60_000,
      byteBudget: DEFAULT_MEDIA_RECLAIM_LIMITS.maxBytesPerRun,
    })
    expect(second.refused).toBe(1)
    expect(h.deleted).toEqual([1])
  })

  /**
   * DISARM TARGET: the `catch` around the ownership probe.
   *
   * A probe that throws must abandon the device. If the failure were read as
   * "no owner is a motion event" the pass would delete nothing and look
   * identical — so the fixture asserts the STOP REASON and the log line, not
   * the delete count.
   */
  it('an ownership probe that throws abandons the device instead of reading as absence', async () => {
    const h = harness({
      rows: [row(1, 'ev-a'), row(2, 'ev-b')],
      motionOwners: ['ev-a', 'ev-b'],
      probeThrows: true,
    })
    const r = await walk(h, 'motion-still')
    expect(r.stoppedBy).toBe('probe-failed')
    expect(r.examined).toBe(0)
    expect(r.unresolved).toBe(0)
    expect(h.deleted).toEqual([])
    const abandoned = h.log.entries.filter(
      (e) => e.message === 'media reclaim: ownership probe failed — device abandoned for this run',
    )
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.extras?.tags).toEqual({ deviceId: 103 })
  })
})

describe('media reclaim — bounds and resumability', () => {
  it('stops at the per-device reclaim ceiling and resumes where it stopped', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, `ev-${i + 1}`))
    const h = harness({ rows, motionOwners: rows.map((r) => r.ownerId) })
    const first = await walk(h, 'motion-still', { maxReclaimPerDevice: 4 })
    expect(first.reclaimed).toBe(4)
    expect(first.stoppedBy).toBe('reclaim-ceiling')
    const second = await reclaimDeviceScope({
      deviceId: 103,
      scope: 'motion-still',
      cursor: first.nextCursor,
      deps: h.deps,
      limits: limits({ maxReclaimPerDevice: 4 }),
      deadlineMs: NOW + 60_000,
      byteBudget: DEFAULT_MEDIA_RECLAIM_LIMITS.maxBytesPerRun,
    })
    expect(second.reclaimed).toBe(4)
    expect(h.deleted).toHaveLength(8)
    expect(new Set(h.deleted).size).toBe(8)
  })

  it('stops on the shared byte budget without forgetting anything extra', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, `ev-${i + 1}`, 1_000))
    const h = harness({ rows, motionOwners: rows.map((r) => r.ownerId) })
    const r = await reclaimDeviceScope({
      deviceId: 103,
      scope: 'motion-still',
      cursor: 0,
      deps: h.deps,
      limits: limits(),
      deadlineMs: NOW + 60_000,
      byteBudget: 3_000,
    })
    expect(r.reclaimed).toBe(3)
    expect(r.bytesReclaimed).toBe(3_000)
    expect(r.stoppedBy).toBe('byte-ceiling')
  })

  it('logs ONE summary line per device per scope, never one per row', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, `ev-${i + 1}`))
    const h = harness({ rows, motionOwners: rows.map((r) => r.ownerId) })
    const { report } = await runMediaReclaim({
      deviceIds: [103],
      scopes: ['motion-still'],
      deps: h.deps,
      limits: limits({ pageSize: 5 }),
      cursors: new Map(),
    })
    expect(report.totalReclaimed).toBe(40)
    const summaries = h.log.entries.filter((e) => e.message === 'media reclaim window')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.extras?.tags).toEqual({ deviceId: 103 })
  })

  it('reports complete only when every device+scope is exhausted', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, `ev-${i + 1}`))
    const h = harness({ rows, motionOwners: rows.map((r) => r.ownerId) })
    const partial = await runMediaReclaim({
      deviceIds: [103],
      scopes: ['motion-still'],
      deps: h.deps,
      limits: limits({ maxReclaimPerDevice: 2 }),
      cursors: new Map(),
    })
    expect(partial.report.complete).toBe(false)
    expect(partial.cursors.get('motion-still:103')).toBeGreaterThan(0)
  })
})
