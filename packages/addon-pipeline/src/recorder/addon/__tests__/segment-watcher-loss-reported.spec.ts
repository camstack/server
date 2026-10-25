/**
 * The watcher's `rolledOff` reaches the ledger (D521).
 *
 * `rolledOff > 0` is the ONE moment the recorder knows finalizes were missed:
 * the bounded playlist advanced past entries this watcher never handled. On
 * 2026-09-17 camera 101 logged `rolledOff=175, processed=0` after a runner
 * respawn and the line went nowhere — the same process then sealed that hour as
 * complete and took two hours of intact footage off the timeline.
 *
 * So the loss is REPORTED, with the media span it covers, and the line that
 * announces it carries `tags: { deviceId }` like every other line about a
 * camera. It used to carry `meta` only, with a comment claiming the logger was
 * device-scoped by the controller — which is not the same thing as the tag
 * being on the line, and a miss rate is always asked per camera.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type DrainedPlaylist,
  type MissedSegments,
  planFinalizations,
  rolledOffIsDrainedPredecessor,
  startSegmentWatcher,
} from '../segment-watcher.js'

const DEVICE = 101
/** Segment 0 of the run, at a whole second. */
const T0 = 1_726_500_000

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly entry: { readonly tags?: { readonly deviceId?: number } }
}

function recorder(lines: LoggedLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, entry: LoggedLine['entry'] = {}): void => {
      lines.push({ level, message, entry })
    }
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  } as unknown as IScopedLogger
  return logger
}

/** A playlist window of `count` entries whose first is global index `base`. */
function window(base: number, count: number, segSeconds = 10): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-MEDIA-SEQUENCE:${base.toString()}`]
  for (let i = 0; i < count; i += 1) {
    lines.push(`#EXTINF:${segSeconds.toFixed(3)},`)
    lines.push(`${(T0 + (base + i) * segSeconds).toString()}.m4s`)
  }
  return lines.join('\n')
}

describe('a plan that rolled past entries says WHEN the missed media was', () => {
  it('bounds the loss between the writer front and the count it skipped', () => {
    // The watcher was at 4; the playlist front is global 20 at T0+200s.
    const plan = planFinalizations(window(20, 4), 4)
    expect(plan.rolledOff).toBe(16)
    expect(plan.rolledOffToMs).toBe((T0 + 200) * 1000)
    // 16 entries at the longest segment length the body shows (10 s).
    expect(plan.rolledOffFromMs).toBe((T0 + 200) * 1000 - 16 * 10_000)
  })

  it('says nothing it cannot know: no roll-off, no span', () => {
    const plan = planFinalizations(window(20, 4), 20)
    expect(plan.rolledOff).toBe(0)
    expect(plan.rolledOffFromMs).toBeNull()
    expect(plan.rolledOffToMs).toBeNull()
  })

  it('reports a null span when the front entry is not epoch-named', () => {
    // A relocated or otherwise non-epoch name: the count is still real, the
    // span is not derivable, and a made-up span would mark the wrong hours.
    const body = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:9', '#EXTINF:10.000,', 'live-0.m4s'].join('\n')
    const plan = planFinalizations(body, 2)
    expect(plan.rolledOff).toBe(7)
    expect(plan.rolledOffFromMs).toBeNull()
    expect(plan.rolledOffToMs).toBeNull()
  })
})

describe('the running watcher hands that loss to its caller', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
  })

  async function outDir(body: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camstack-watcher-'))
    dirs.push(dir)
    await fs.writeFile(path.join(dir, 'live.m3u8'), body, 'utf8')
    return dir
  }

  it('calls onSegmentsMissed once, with the count and the span', async () => {
    const dir = await outDir(window(20, 4))
    const lines: LoggedLine[] = []
    const missed: MissedSegments[] = []
    const handle = startSegmentWatcher({
      outDir: dir,
      deviceId: DEVICE,
      intervalMs: 5,
      writerStartedMs: T0 * 1000,
      onFinalized: () => undefined,
      onSegmentsMissed: (report) => missed.push(report),
      logger: recorder(lines),
    })
    await handle.flush?.()
    handle.stop()

    expect(missed).toHaveLength(1)
    expect(missed[0]?.count).toBe(20)
    expect(missed[0]?.deviceId).toBe(DEVICE)
    expect(missed[0]?.fromMs).toBe((T0 + 200) * 1000 - 20 * 10_000)
    expect(missed[0]?.toMs).toBe((T0 + 200) * 1000)
  })

  it('tags the roll-off warning with the camera it is about', async () => {
    const dir = await outDir(window(20, 4))
    const lines: LoggedLine[] = []
    const handle = startSegmentWatcher({
      outDir: dir,
      deviceId: DEVICE,
      intervalMs: 5,
      writerStartedMs: T0 * 1000,
      onFinalized: () => undefined,
      logger: recorder(lines),
    })
    await handle.flush?.()
    handle.stop()

    const rolled = lines.find((line) => line.message.includes('rolled past'))
    expect(rolled?.level).toBe('warn')
    expect(rolled?.entry.tags?.deviceId).toBe(DEVICE)
  })

  it('reports nothing when nothing rolled off', async () => {
    const dir = await outDir(window(0, 4))
    const missed: MissedSegments[] = []
    const handle = startSegmentWatcher({
      outDir: dir,
      deviceId: DEVICE,
      intervalMs: 5,
      writerStartedMs: T0 * 1000,
      onFinalized: () => undefined,
      onSegmentsMissed: (report) => missed.push(report),
      logger: recorder([]),
    })
    await handle.flush?.()
    handle.stop()

    expect(missed).toHaveLength(0)
  })
})

/**
 * A fresh watcher's first read is usually the PREVIOUS run's bounded playlist.
 * Measured 2026-09-28: 1149 "rolled past … processed=0" lines in 90 minutes,
 * one per spawn on every camera, each holding its hours unsealed — for entries
 * the previous watcher of this same process had already handled. After a
 * RUNNER RESPAWN the same read is D521's real loss, so it must still report;
 * and a drain vouches only for the body its final pass READ.
 */
describe('a drained previous run is not a roll-off; an undrained one still is', () => {
  const dirs: string[] = []
  /** The previous run's body: 4 entries from global 38, the last at T0+410 s. */
  const PREVIOUS_BODY = window(38, 4)
  /** A NEWER body in the same directory: 4 entries from global 50. */
  const NEWER_BODY = window(50, 4)
  /** The new writer spawns after every entry of both bodies was named. */
  const NEW_WRITER_MS = (T0 + 50 * 10 + 4 * 10 + 5) * 1000

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
  })

  async function outDir(body: string | null): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camstack-watcher-drain-'))
    dirs.push(dir)
    if (body !== null) await fs.writeFile(path.join(dir, 'live.m3u8'), body, 'utf8')
    return dir
  }

  interface Run {
    readonly lines: LoggedLine[]
    readonly missed: MissedSegments[]
    readonly drained: DrainedPlaylist | null
  }

  /** One watcher's life, spawn to (optionally) its final flush. */
  async function runWatcher(
    dir: string,
    writerStartedMs: number,
    drainedPredecessor: DrainedPlaylist | null,
    flush = true,
  ): Promise<Run> {
    const lines: LoggedLine[] = []
    const missed: MissedSegments[] = []
    let drained: DrainedPlaylist | null = null
    const handle = startSegmentWatcher({
      outDir: dir,
      deviceId: DEVICE,
      intervalMs: 3_600_000,
      writerStartedMs,
      onFinalized: () => undefined,
      onSegmentsMissed: (report) => missed.push(report),
      drainedPredecessor,
      onDrained: (d) => {
        drained = d
      },
      logger: recorder(lines),
    })
    if (flush) await handle.flush?.()
    handle.stop()
    return { lines, missed, drained }
  }

  it('the next watcher of a directory this process drained reports nothing', async () => {
    const dir = await outDir(PREVIOUS_BODY)
    const previous = await runWatcher(dir, T0 * 1000, null)
    expect(previous.drained).toEqual({
      lastSegStartMs: (T0 + 410) * 1000,
      lastMediaSequence: 41,
    })

    const next = await runWatcher(dir, NEW_WRITER_MS, previous.drained)
    expect(next.missed).toHaveLength(0)
    expect(next.lines.some((l) => l.message.includes('rolled past'))).toBe(false)
    // Not silent: the skip is named, per camera, at debug.
    const named = next.lines.find((l) => l.message.includes('drained previous run'))
    expect(named?.level).toBe('debug')
    expect(named?.entry.tags?.deviceId).toBe(DEVICE)
  })

  it('after a runner respawn (nothing drained in THIS process) the loss is still reported — D521', async () => {
    const dir = await outDir(PREVIOUS_BODY)
    const next = await runWatcher(dir, NEW_WRITER_MS, null)
    expect(next.missed).toHaveLength(1)
    expect(next.missed[0]?.count).toBe(38)
    expect(next.lines.find((l) => l.message.includes('rolled past'))?.level).toBe('warn')
  })

  it('a predecessor stopped WITHOUT its final flush vouches for nothing', async () => {
    const dir = await outDir(PREVIOUS_BODY)
    const previous = await runWatcher(dir, T0 * 1000, null, false)
    expect(previous.drained).toBeNull()
    const next = await runWatcher(dir, NEW_WRITER_MS, previous.drained)
    expect(next.missed).toHaveLength(1)
  })

  it('a final pass that could not READ the playlist vouches for nothing', async () => {
    // The playlist is unreadable at the predecessor's flush, then appears with
    // entries before global 38 that nobody handled or reported.
    const dir = await outDir(null)
    const previous = await runWatcher(dir, T0 * 1000, null)
    expect(previous.drained).toBeNull()
    await fs.writeFile(path.join(dir, 'live.m3u8'), PREVIOUS_BODY, 'utf8')

    const next = await runWatcher(dir, NEW_WRITER_MS, previous.drained)
    expect(next.missed).toHaveLength(1)
    expect(next.missed[0]?.count).toBe(38)
  })

  it('a NEWER playlist in a drained directory is not the one drained — its roll-off is reported', async () => {
    // A foreign or later writer rewrote the playlist after the drain.
    const dir = await outDir(PREVIOUS_BODY)
    const previous = await runWatcher(dir, T0 * 1000, null)
    await fs.writeFile(path.join(dir, 'live.m3u8'), NEWER_BODY, 'utf8')

    const next = await runWatcher(dir, NEW_WRITER_MS, previous.drained)
    expect(next.missed).toHaveLength(1)
    expect(next.missed[0]?.count).toBe(50)
  })

  it("a body whose front is THIS writer's own is reported, whatever was drained", async () => {
    // A drain record that would cover everything; the body's entries are named
    // after this writer spawned, so what rolled off is this writer's loss.
    const dir = await outDir(PREVIOUS_BODY)
    const coversAll: DrainedPlaylist = {
      lastSegStartMs: Number.MAX_SAFE_INTEGER,
      lastMediaSequence: Number.MAX_SAFE_INTEGER,
    }
    const next = await runWatcher(dir, T0 * 1000, coversAll)
    expect(next.missed).toHaveLength(1)
    expect(next.missed[0]?.count).toBe(38)
  })

  it('the drain vouches only for bodies no newer than it and fronts before this writer', () => {
    const drained: DrainedPlaylist = { lastSegStartMs: (T0 + 410) * 1000, lastMediaSequence: 41 }
    const base = {
      rolledOffToMs: (T0 + 380) * 1000,
      writerStartedMs: NEW_WRITER_MS,
      bodyTail: drained,
      drained,
    }
    expect(rolledOffIsDrainedPredecessor(base)).toBe(true)
    expect(rolledOffIsDrainedPredecessor({ ...base, drained: null })).toBe(false)
    expect(rolledOffIsDrainedPredecessor({ ...base, bodyTail: null })).toBe(false)
    expect(rolledOffIsDrainedPredecessor({ ...base, rolledOffToMs: null })).toBe(false)
    expect(
      rolledOffIsDrainedPredecessor({
        ...base,
        bodyTail: { ...drained, lastSegStartMs: drained.lastSegStartMs + 10_000 },
      }),
    ).toBe(false)
    expect(
      rolledOffIsDrainedPredecessor({
        ...base,
        bodyTail: { ...drained, lastMediaSequence: 42 },
      }),
    ).toBe(false)
    expect(rolledOffIsDrainedPredecessor({ ...base, rolledOffToMs: NEW_WRITER_MS + 60_000 })).toBe(
      false,
    )
  })
})
