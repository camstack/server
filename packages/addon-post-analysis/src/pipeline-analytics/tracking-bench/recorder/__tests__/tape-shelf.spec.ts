/**
 * The tape tenant of the `artifacts` class keeps its OWN retention and nothing
 * else (D341, spec §3.3): segments older than 24 h by the origin in their file
 * name go; `promoted/`, other tenants and non-camera directories are never
 * touched. Each sweep that deleted something says so per camera.
 *
 * Disarm: drop the `originMs < cutoff` condition (sweep every segment) — the
 * "keeps the 47 h segment" test must fail.
 *
 * (Task 10 fix round, M3) Disarm: in `readSegments`, answer a non-ENOENT
 * `readdir` failure with `{ ok: true, segments: [] }` — "a camera whose
 * segments cannot be read is unreadable, never empty" fails.
 *
 * (Task 12 fix round, L4) Disarm: record an unstat-able file as origin 0 —
 * "a segment it saw but could not stat is reported by the origin in its
 * name" fails.
 *
 * (D681 follow-up) Disarm: empty `logTapeSweepReport` — "logs rootUnreadable
 * and per-camera failed from the sweep report" fails.
 */
import { chmod, mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import { logTapeSweepReport, TapeShelf } from '../tape-shelf.js'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

/** `chmod 000` cannot deny root — skip EACCES cases instead of failing as false positives. */
const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('TapeShelf', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tape-shelf-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function touch(file: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'x')
  }

  it('names segments by device and origin, promoted tapes by id', () => {
    const shelf = new TapeShelf({ rootDir: root, logger: makeLogRecorder().logger, now: () => NOW })
    expect(shelf.segmentFile(101, 1_700_000_000_000)).toBe(
      path.join(root, '101', 'tracking-tapes', 'segments', '1700000000000.jsonl.gz'),
    )
    expect(shelf.promotedFile(101, 'a1b2c3d4-0000')).toBe(
      path.join(root, '101', 'tracking-tapes', 'promoted', 'a1b2c3d4-0000.jsonl.gz'),
    )
    expect(() => shelf.promotedFile(101, '../etc')).toThrow()
  })

  it('sweeps segments older than 24 h and keeps the 23 h one', async () => {
    const { logger, entries } = makeLogRecorder()
    const shelf = new TapeShelf({ rootDir: root, logger, now: () => NOW })
    const old = shelf.segmentFile(101, NOW - 25 * HOUR)
    const young = shelf.segmentFile(101, NOW - 23 * HOUR)
    await touch(old)
    await touch(young)

    const report = await shelf.sweep()

    expect(await readdir(path.dirname(old))).toEqual([path.basename(young)])
    expect(report.perDevice.get(101)).toEqual({ files: 1, bytes: 1 })
    expect(report.rootUnreadable).toBeNull()
    const line = entries.find((e) => e.message === 'tracking tape segments swept')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
  })

  it.skipIf(runsAsRoot)(
    'reports the shelf root as unreadable, never as "nothing to sweep" (EACCES)',
    async () => {
      const { logger, entries } = makeLogRecorder()
      const shelf = new TapeShelf({ rootDir: root, logger, now: () => NOW })
      await touch(shelf.segmentFile(101, NOW - 25 * HOUR))
      await chmod(root, 0o000)
      try {
        const report = await shelf.sweep()
        expect(report.perDevice.size).toBe(0)
        expect(report.rootUnreadable).toEqual(expect.any(String))
        const line = entries.find((e) => e.level === 'warn' && e.message.includes('shelf root'))
        expect(line).toBeDefined()
        expect(line?.extras?.tags).toBeUndefined()
      } finally {
        await chmod(root, 0o755)
      }
    },
  )

  it.skipIf(runsAsRoot)(
    'reports one camera bucket as unreadable, never as "nothing to sweep" (EACCES)',
    async () => {
      const { logger, entries } = makeLogRecorder()
      const shelf = new TapeShelf({ rootDir: root, logger, now: () => NOW })
      const old = shelf.segmentFile(101, NOW - 25 * HOUR)
      await touch(old)
      const segmentsDir = path.dirname(old)
      await chmod(segmentsDir, 0o000)
      try {
        const report = await shelf.sweep()
        expect(report.perDevice.get(101)).toEqual({ failed: true, reason: expect.any(String) })
        const line = entries.find(
          (e) =>
            e.level === 'warn' &&
            e.message === 'tracking tape segments directory could not be read',
        )
        expect(line?.extras?.tags).toEqual({ deviceId: 101 })
      } finally {
        await chmod(segmentsDir, 0o755)
      }
    },
  )

  it('never touches promoted tapes, other tenants or non-camera directories', async () => {
    const shelf = new TapeShelf({ rootDir: root, logger: makeLogRecorder().logger, now: () => NOW })
    const promoted = shelf.promotedFile(101, 'keep-me-forever')
    const artefact = path.join(root, '101', 'nc-artifacts', 'kept', 'x.jpg')
    const exported = path.join(root, 'exports', '101', 'clip.mp4')
    for (const f of [promoted, artefact, exported]) {
      await touch(f)
      await utimes(f, new Date(0), new Date(0))
    }

    await shelf.sweep()

    for (const f of [promoted, artefact, exported]) {
      await expect(readdir(path.dirname(f))).resolves.toContain(path.basename(f))
    }
  })

  it.skipIf(runsAsRoot)(
    'a camera whose segments cannot be read is unreadable, never empty (D393)',
    async () => {
      const shelf = new TapeShelf({
        rootDir: root,
        logger: makeLogRecorder().logger,
        now: () => NOW,
      })
      const file = shelf.segmentFile(101, NOW - HOUR)
      await touch(file)
      const segmentsDir = path.dirname(file)
      await chmod(segmentsDir, 0o000)
      try {
        expect(await shelf.readSegments(101)).toEqual({ ok: false, reason: expect.any(String) })
      } finally {
        await chmod(segmentsDir, 0o755)
      }
      // A camera with no tapes at all is a real, measured empty.
      expect(await shelf.readSegments(104)).toEqual({ ok: true, segments: [], unstatted: [] })
    },
  )

  it.skipIf(runsAsRoot)(
    'a segment it saw but could not stat is reported by the origin in its name (Task 12 fix round, L4)',
    async () => {
      const shelf = new TapeShelf({
        rootDir: root,
        logger: makeLogRecorder().logger,
        now: () => NOW,
      })
      const file = shelf.segmentFile(616, NOW - HOUR)
      await touch(file)
      const segmentsDir = path.dirname(file)
      // Readable (the name is listed) but not searchable (the stat fails).
      await chmod(segmentsDir, 0o400)
      try {
        expect(await shelf.readSegments(616)).toEqual({
          ok: true,
          segments: [],
          unstatted: [NOW - HOUR],
        })
      } finally {
        await chmod(segmentsDir, 0o755)
      }
    },
  )

  it('lists a camera’s segments oldest first with their sizes', async () => {
    const shelf = new TapeShelf({ rootDir: root, logger: makeLogRecorder().logger, now: () => NOW })
    await touch(shelf.segmentFile(102, NOW - 2 * HOUR))
    await touch(shelf.segmentFile(102, NOW - 3 * HOUR))
    const listing = await shelf.readSegments(102)
    if (!listing.ok) throw new Error(`expected a listing: ${listing.reason}`)
    expect(listing.segments.map((s) => s.originMs)).toEqual([NOW - 3 * HOUR, NOW - 2 * HOUR])
    expect(listing.segments[0]?.bytes).toBe(1)
    expect(listing.unstatted).toEqual([])
  })

  it('logs rootUnreadable and per-camera failed from the sweep report (D681 follow-up)', () => {
    const { logger, entries } = makeLogRecorder()
    logTapeSweepReport(
      {
        rootUnreadable: 'EACCES',
        perDevice: new Map([
          [101, { failed: true, reason: 'EIO' }],
          [102, { files: 2, bytes: 100 }],
        ]),
      },
      logger,
    )
    const refusals = entries.filter((e) => e.message === 'tracking tape sweep refused')
    expect(refusals).toHaveLength(2)
    expect(refusals[0]).toMatchObject({
      level: 'warn',
      extras: { meta: { reason: 'EACCES', scope: 'root' } },
    })
    expect(refusals[1]).toMatchObject({
      level: 'warn',
      extras: { tags: { deviceId: 101 }, meta: { reason: 'EIO', scope: 'camera' } },
    })
  })
})
