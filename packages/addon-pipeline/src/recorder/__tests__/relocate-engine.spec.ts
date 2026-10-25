/**
 * Footage relocation engine (Phase 4): copy-if-absent → verify → delete →
 * index re-point, resumable, single-flight, cancel-safe.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'
import { RecordingIndex } from '../recording-index.js'
import { moveFile, profileBelongsToClass, RelocateEngine } from '../relocate-engine.js'
import { segmentRelPath } from '../segment-path.js'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  withTags: () => noopLogger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

function makeRoots(): { from: RecordingsLocation; to: RecordingsLocation } {
  const fromRoot = mkdtempSync(path.join(tmpdir(), 'reloc-from-'))
  const toRoot = mkdtempSync(path.join(tmpdir(), 'reloc-to-'))
  return {
    from: recordingsLocationOfMode(
      { id: 'recordings:old', type: 'recordings', root: fromRoot },
      'readonly',
    ),
    to: recordingsLocationOfMode(
      { id: 'recordings:new', type: 'recordings', root: toRoot },
      'active',
    ),
  }
}

function seedSegments(
  index: RecordingIndex,
  root: string,
  locationId: string,
  deviceId: number,
  specs: readonly { startMs: number; bytes: number }[],
): string[] {
  const rels = specs.map((s) => {
    const rel = segmentRelPath(deviceId, 'high', s.startMs, 1_000, s.bytes)
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, Buffer.alloc(s.bytes, 7))
    return rel
  })
  // ONE hydrate call — hydrateDevice replaces the device's row set.
  index.hydrateDevice(deviceId, locationId, rels)
  return rels
}

async function waitDone(engine: RelocateEngine, jobId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const job = engine.list().find((j) => j.jobId === jobId)
    if (job && job.state !== 'running' && job.state !== 'queued') return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('job never finished')
}

/** Seed one device WITHOUT clobbering the others (hydrateDevice replaces a
 *  device's whole row set, so a multi-device fixture must add row by row). */
function seedDevice(
  index: RecordingIndex,
  root: string,
  locationId: string,
  deviceId: number,
  specs: readonly { profile: string; startMs: number; bytes: number }[],
): void {
  for (const s of specs) {
    const rel = segmentRelPath(deviceId, s.profile, s.startMs, 1_000, s.bytes)
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, Buffer.alloc(s.bytes, 7))
    index.addSegment({
      deviceId,
      profile: s.profile,
      startMs: s.startMs,
      durMs: 1_000,
      bytes: s.bytes,
      path: rel,
      locationId,
    })
  }
}

function makeEngine(
  index: RecordingIndex,
  from: RecordingsLocation,
  to: RecordingsLocation,
): RelocateEngine {
  let n = 0
  return new RelocateEngine({
    index,
    locations: () => [from, to],
    logger: noopLogger,
    now: () => 0,
    newId: () => `job-${n++}`,
    sleep: async () => {},
    // A roomy destination, stated rather than measured. Without this every
    // test below silently depends on how full the machine running it happens
    // to be: the drain refuses a destination under its `minFreePercent` floor
    // (default 10, the same default placement applies), and these fixtures
    // live in `os.tmpdir()`. See `RelocateEngine destination headroom` for the
    // tests that are actually about free space.
    freePercentOf: async () => 100,
  })
}

describe('moveFile', () => {
  it('copies, verifies size, deletes the source', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-'))
    const src = path.join(dir, 'a/src.bin')
    mkdirSync(path.dirname(src), { recursive: true })
    writeFileSync(src, Buffer.alloc(64, 1))
    const dst = path.join(dir, 'b/dst.bin')
    expect(await moveFile(src, dst, 64)).toBe(64)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dst).length).toBe(64)
  })

  it('adopts an equal-size destination without re-copying (resume)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mv-'))
    const src = path.join(dir, 'src.bin')
    const dst = path.join(dir, 'dst.bin')
    writeFileSync(src, Buffer.alloc(32, 1))
    writeFileSync(dst, Buffer.alloc(32, 2)) // already complete from a prior run
    expect(await moveFile(src, dst, 32)).toBe(0) // nothing copied
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dst)[0]).toBe(2) // destination untouched
  })
})

describe('RelocateEngine', () => {
  it('filters relocation by profile-derived logical class', () => {
    expect(profileBelongsToClass('high', 'recordings')).toBe(true)
    expect(profileBelongsToClass('mid', 'recordings')).toBe(true)
    expect(profileBelongsToClass('low', 'recordings')).toBe(false)
    expect(profileBelongsToClass('low', 'recordingsLow')).toBe(true)
    expect(profileBelongsToClass('high', 'recordingsLow')).toBe(false)
  })

  it('moves segments to the target root and re-points the index rows', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    const [rel1, rel2] = seedSegments(index, from.root, from.id, 104, [
      { startMs: 1_000, bytes: 100 },
      { startMs: 2_000, bytes: 200 },
    ]) as [string, string]
    const finished: string[] = []
    const engine = new RelocateEngine({
      index,
      locations: () => [from, to],
      logger: noopLogger,
      now: () => 1_000,
      newId: () => 'job-1',
      onFinished: (j) => finished.push(j.state),
      sleep: async () => {},
      // A roomy destination, stated rather than measured — see `makeEngine`.
      freePercentOf: async () => 100,
    })
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: to.id })
    await waitDone(engine, jobId)

    const job = engine.list()[0]!
    expect(job.state).toBe('done')
    expect(job.filesMoved).toBe(2)
    expect(job.bytesMoved).toBe(300)
    expect(finished).toEqual(['done'])
    // Files moved on disk…
    expect(existsSync(path.join(from.root, rel1))).toBe(false)
    expect(existsSync(path.join(to.root, rel1))).toBe(true)
    expect(existsSync(path.join(to.root, rel2))).toBe(true)
    // …and the index rows now point at the target location.
    expect(index.segmentsOnLocation(from.id)).toHaveLength(0)
    expect(index.segmentsOnLocation(to.id)).toHaveLength(2)
  })

  it('rejects a read-only target and same-root pairs, synchronously', () => {
    const { from, to } = makeRoots()
    const engine = makeEngine(new RecordingIndex(), from, to)
    expect(() => engine.start({ fromLocationId: to.id, toLocationId: from.id })).toThrow(
      /read-only/,
    )
    expect(() => engine.start({ fromLocationId: from.id, toLocationId: from.id })).toThrow(
      /identical/,
    )
    expect(() => engine.start({ fromLocationId: 'recordings:ghost', toLocationId: to.id })).toThrow(
      /unknown source/,
    )
  })

  it('skips a missing source file and finishes the rest of the job', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    seedDevice(index, from.root, from.id, 101, [{ profile: 'high', startMs: 1_000, bytes: 100 }])
    const ghostRel = segmentRelPath(101, 'high', 2_000, 1_000, 50)
    index.addSegment({
      deviceId: 101,
      profile: 'high',
      startMs: 2_000,
      durMs: 1_000,
      bytes: 50,
      path: ghostRel,
      locationId: from.id,
    })
    const engine = makeEngine(index, from, to)
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: to.id })
    await waitDone(engine, jobId)
    const job = engine.list()[0]!
    expect(job.state).toBe('done')
    expect(existsSync(path.join(to.root, ghostRel))).toBe(false)
    expect(index.segmentsOnLocation(from.id)).toHaveLength(0)
    expect(index.segmentsOnLocation(to.id)).toHaveLength(1)
  })
})

/**
 * Phase 2 of multi-location recordings (D116). Two behaviours the operator-armed
 * rebalance needs and the drain-only engine did not have: a move scoped to ONE
 * camera, and a QUEUE — a rebalance enqueues one job per (camera, profile) pile,
 * and refusing the second turned a fifteen-camera rebalance into fifteen manual
 * retries.
 */
describe('RelocateEngine — per-device scope', () => {
  it('moves only the named camera, and says which one on the job', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    seedDevice(index, from.root, from.id, 101, [{ profile: 'high', startMs: 1_000, bytes: 100 }])
    seedDevice(index, from.root, from.id, 102, [{ profile: 'high', startMs: 1_000, bytes: 200 }])
    const engine = makeEngine(index, from, to)

    const jobId = engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId: 101 })
    await waitDone(engine, jobId)

    const job = engine.list().find((j) => j.jobId === jobId)!
    expect(job.state).toBe('done')
    expect(job.deviceId).toBe(101)
    expect(job.filesMoved).toBe(1)
    // 102 never moved: its row is still on the source location.
    expect(index.segmentsOnLocation(from.id).map((r) => r.deviceId)).toEqual([102])
    expect(index.segmentsOnLocation(to.id).map((r) => r.deviceId)).toEqual([101])
  })

  it('scopes to specific PROFILES — finer than the footage class, which cannot split high from mid', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    seedDevice(index, from.root, from.id, 101, [
      { profile: 'high', startMs: 1_000, bytes: 100 },
      { profile: 'mid', startMs: 1_000, bytes: 50 },
    ])
    const engine = makeEngine(index, from, to)

    const jobId = engine.start({
      fromLocationId: from.id,
      toLocationId: to.id,
      deviceId: 101,
      profiles: ['high'],
    })
    await waitDone(engine, jobId)

    expect(index.segmentsOnLocation(to.id).map((r) => r.profile)).toEqual(['high'])
    expect(index.segmentsOnLocation(from.id).map((r) => r.profile)).toEqual(['mid'])
  })

  it('moves only segments at or after sinceMs', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    seedDevice(index, from.root, from.id, 101, [
      { profile: 'high', startMs: 1_000, bytes: 100 },
      { profile: 'high', startMs: 10_000, bytes: 50 },
    ])
    const engine = makeEngine(index, from, to)
    const jobId = engine.start({
      fromLocationId: from.id,
      toLocationId: to.id,
      sinceMs: 5_000,
    })
    await waitDone(engine, jobId)
    const job = engine.list()[0]!
    expect(job.state).toBe('done')
    expect(job.filesMoved).toBe(1)
    expect(index.segmentsOnLocation(to.id).map((r) => r.startMs)).toEqual([10_000])
    expect(index.segmentsOnLocation(from.id).map((r) => r.startMs)).toEqual([1_000])
  })
})

describe('RelocateEngine — the FIFO queue behind single-flight', () => {
  it('queues a second job instead of refusing it, and runs them in order', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    seedDevice(index, from.root, from.id, 101, [{ profile: 'high', startMs: 1_000, bytes: 100 }])
    seedDevice(index, from.root, from.id, 102, [{ profile: 'high', startMs: 1_000, bytes: 200 }])
    const engine = makeEngine(index, from, to)

    const first = engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId: 101 })
    const second = engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId: 102 })
    // Synchronously after both starts: one runs, one waits. Neither is refused.
    expect(engine.list().find((j) => j.jobId === second)!.state).toBe('queued')

    await waitDone(engine, first)
    await waitDone(engine, second)
    expect(
      engine
        .list()
        .map((j) => j.state)
        .sort(),
    ).toEqual(['done', 'done'])
    // FIFO: the first-enqueued job finished first.
    const order = engine.list().toSorted((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    expect(order[0]!.jobId).toBe(first)
    expect(index.segmentsOnLocation(from.id)).toHaveLength(0)
  })

  it('never runs two movers at once — a second disk of jobs waits its turn', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    for (const deviceId of [101, 102, 108]) {
      seedDevice(index, from.root, from.id, deviceId, [
        { profile: 'high', startMs: 1_000, bytes: 100 },
      ])
    }
    let concurrent = 0
    let peak = 0
    const engine = new RelocateEngine({
      index,
      locations: () => [from, to],
      logger: noopLogger,
      now: () => 0,
      newId: (() => {
        let n = 0
        return () => `job-${n++}`
      })(),
      // A roomy destination, stated rather than measured — see `makeEngine`.
      freePercentOf: async () => 100,
      // The pacing sleep is the only await inside a run — a second mover
      // entering here would show up as a concurrency of 2.
      sleep: async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise((r) => setTimeout(r, 5))
        concurrent -= 1
      },
    })
    const ids = [101, 102, 108].map((deviceId) =>
      engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId }),
    )
    for (const id of ids) await waitDone(engine, id)
    expect(peak).toBe(1)
    expect(engine.list().every((j) => j.state === 'done')).toBe(true)
  })

  it('cancels a QUEUED job without ever running it — the source bytes stay put', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    seedDevice(index, from.root, from.id, 101, [{ profile: 'high', startMs: 1_000, bytes: 100 }])
    seedDevice(index, from.root, from.id, 102, [{ profile: 'high', startMs: 1_000, bytes: 200 }])
    const engine = makeEngine(index, from, to)

    const first = engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId: 101 })
    const second = engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId: 102 })
    expect(engine.cancel(second)).toBe(true)

    await waitDone(engine, first)
    await waitDone(engine, second)
    const cancelled = engine.list().find((j) => j.jobId === second)!
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.filesMoved).toBe(0)
    // 102's footage never left the source.
    expect(index.segmentsOnLocation(from.id).map((r) => r.deviceId)).toEqual([102])
  })

  it('a failing job does not strand the queue behind it', async () => {
    const { from, to } = makeRoots()
    const index = new RecordingIndex()
    seedDevice(index, from.root, from.id, 101, [{ profile: 'high', startMs: 1_000, bytes: 100 }])
    // 101's destination subtree cannot be created — `<to.root>/101` is a FILE,
    // so the copy's `mkdir` raises ENOTDIR and the job fails.
    //
    // This used to be an index that claimed 100 B over a 50 B file, back when a
    // recorded size that disagreed with the disk failed the verify. It no
    // longer does, and must not: that comparison could only ever fail when the
    // LEDGER was wrong, and it killed a 110 749-file drain on one row
    // (`relocate-size-truth.spec.ts`). This test is about the QUEUE, so it now
    // fails the job with something that is genuinely a failure.
    writeFileSync(path.join(to.root, '101'), 'not a directory')
    seedDevice(index, from.root, from.id, 102, [{ profile: 'high', startMs: 1_000, bytes: 200 }])
    const engine = makeEngine(index, from, to)

    const first = engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId: 101 })
    const second = engine.start({ fromLocationId: from.id, toLocationId: to.id, deviceId: 102 })
    await waitDone(engine, first)
    await waitDone(engine, second)

    expect(engine.list().find((j) => j.jobId === first)!.state).toBe('failed')
    expect(engine.list().find((j) => j.jobId === second)!.state).toBe('done')
  })
})

/**
 * Destination-full handling. ENOSPC is already SAFE — D291 copies and verifies
 * before any durable re-point, so a full destination loses nothing — but it is
 * a raw errno halfway through a thirty-hour drain instead of a refusal the
 * operator can act on.
 */
describe('RelocateEngine destination headroom', () => {
  function makeEngineWithFreeSpace(
    index: RecordingIndex,
    from: RecordingsLocation,
    to: RecordingsLocation,
    freePercentOf: (root: string) => Promise<number | null>,
  ): RelocateEngine {
    let n = 0
    return new RelocateEngine({
      index,
      locations: () => [from, to],
      logger: noopLogger,
      now: () => 0,
      newId: () => `headroom-${n++}`,
      sleep: async () => {},
      freePercentOf,
    })
  }

  it('refuses before reading a byte when the destination is past its floor', async () => {
    const { from, to } = makeRoots()
    const guarded: RecordingsLocation = { ...to, minFreePercent: 20 }
    const index = new RecordingIndex()
    const [rel] = seedSegments(index, from.root, from.id, 104, [{ startMs: 1_000, bytes: 100 }])
    const engine = makeEngineWithFreeSpace(index, from, guarded, async () => 5)
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: guarded.id })
    await waitDone(engine, jobId)
    const job = engine.list().find((j) => j.jobId === jobId)
    expect(job?.state).toBe('failed')
    expect(job?.error).toContain('destination full')
    expect(job?.error).toContain('below its 20% floor')
    // Nothing moved, and the source is untouched — the point of asking the
    // cheap question before loading anything.
    expect(existsSync(path.join(from.root, rel!))).toBe(true)
    expect(existsSync(path.join(guarded.root, rel!))).toBe(false)
  })

  it('stops BETWEEN hours when the destination fills during the drain', async () => {
    const { from, to } = makeRoots()
    const guarded: RecordingsLocation = { ...to, minFreePercent: 20 }
    const index = new RecordingIndex()
    // Two hours of one (device, profile) — the mover's batch is the hour.
    const [hour1, hour2] = seedSegments(index, from.root, from.id, 104, [
      { startMs: 1_000, bytes: 100 },
      { startMs: 2 * 3_600_000 + 1_000, bytes: 100 },
    ])
    // Roomy for the up-front check and the first hour; full by the second.
    let checks = 0
    const engine = makeEngineWithFreeSpace(index, from, guarded, async () => {
      checks++
      return checks <= 2 ? 50 : 1
    })
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: guarded.id })
    await waitDone(engine, jobId)
    const job = engine.list().find((j) => j.jobId === jobId)
    expect(job?.state).toBe('failed')
    expect(job?.error).toContain('destination full')
    // The first hour landed and left the source; the second is WHOLLY still at
    // the source. "Readable from both", never "invisible on one".
    expect(existsSync(path.join(guarded.root, hour1!))).toBe(true)
    expect(existsSync(path.join(from.root, hour1!))).toBe(false)
    expect(existsSync(path.join(from.root, hour2!))).toBe(true)
    expect(existsSync(path.join(guarded.root, hour2!))).toBe(false)
  })

  it('drains anyway when free space is UNREADABLE — null is not "no room"', async () => {
    const { from, to } = makeRoots()
    const guarded: RecordingsLocation = { ...to, minFreePercent: 20 }
    const index = new RecordingIndex()
    const [rel] = seedSegments(index, from.root, from.id, 104, [{ startMs: 1_000, bytes: 100 }])
    const engine = makeEngineWithFreeSpace(index, from, guarded, async () => null)
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: guarded.id })
    await waitDone(engine, jobId)
    expect(engine.list().find((j) => j.jobId === jobId)?.state).toBe('done')
    expect(existsSync(path.join(guarded.root, rel!))).toBe(true)
  })

  it('never even asks about a move onto the SAME physical root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'reloc-same-'))
    const from: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordings:old', type: 'recordings', root },
      'readonly',
    )
    const to: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordingsLow:same', type: 'recordingsLow', root, minFreePercent: 90 },
      'active',
    )
    const index = new RecordingIndex()
    seedSegments(index, root, from.id, 104, [{ startMs: 1_000, bytes: 100 }])
    const asked: string[] = []
    const engine = makeEngineWithFreeSpace(index, from, to, async (askedRoot) => {
      asked.push(askedRoot)
      return 1
    })
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: to.id })
    await waitDone(engine, jobId)
    // A same-root move is a re-stamp: it consumes no net space, so refusing it
    // would block the one relocation that RELIEVES a full disk.
    expect(engine.list().find((j) => j.jobId === jobId)?.state).toBe('done')
    expect(asked).toEqual([])
  })
})
