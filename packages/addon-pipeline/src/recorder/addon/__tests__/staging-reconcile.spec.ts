/**
 * Recovery of `.rec-tmp` segments a writer restart orphaned.
 *
 * ffmpeg opens `-segment_list live.m3u8` in TRUNCATE mode, so every writer
 * respawn destroys the only record the watcher has of what it still owes.
 * Anything written but not yet relocated at that instant becomes unreachable:
 * no playlist names it, `parseSegmentPath` cannot see it (the staging dir is
 * dot-prefixed and flat), and the only `.rec-tmp` sweep that exists touches
 * locations with ZERO placement assignments — never the live one.
 *
 * Live proof (2026-08-14, hub): `/recordings/.rec-tmp/104/high/live.m3u8` held
 * 50 entries, all named at or after the current writer's start of 20:28:31,
 * while 5 863 older `.m4s` files sat in the same directory referenced by
 * nobody — the oldest from 2026-07-04. 179 GB of operator footage across the
 * fleet, on an array at 90%.
 */
import { describe, expect, it, vi } from 'vitest'
import { LoopPacer } from '../../loop-pacer.js'
import {
  planStagingRecovery,
  recoverAllStagedOrphans,
  recoverStagingOrphans,
  type StagedFinalizeInput,
  type StagingOrphan,
} from '../staging-reconcile.js'

/** 20:28:31 on the incident day, in ms — the live writer's start. */
const WRITER_STARTED_MS = 1_786_732_111_000
const SEGMENT_SECONDS = 10

function name(epochSec: number): string {
  return `${epochSec}.m4s`
}

function quietLogger(): {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly debug: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

describe('planStagingRecovery', () => {
  it('recovers only what a PREVIOUS run wrote, never this run’s live segments', () => {
    const thisRun = Math.floor(WRITER_STARTED_MS / 1000)
    const plan = planStagingRecovery({
      names: [
        name(thisRun - 40),
        name(thisRun - 30),
        // This run — the live watcher owns these; touching them races ffmpeg's
        // still-open segment.
        name(thisRun + 10),
        name(thisRun + 20),
      ],
      writerStartedMs: WRITER_STARTED_MS,
      segmentSeconds: SEGMENT_SECONDS,
    })

    expect(plan.map((o) => o.name)).toEqual([name(thisRun - 40), name(thisRun - 30)])
  })

  it('derives duration from the SUCCESSOR’s start for a consecutive pair', () => {
    const base = Math.floor(WRITER_STARTED_MS / 1000) - 100
    const plan = planStagingRecovery({
      names: [name(base), name(base + 12)],
      writerStartedMs: WRITER_STARTED_MS,
      segmentSeconds: SEGMENT_SECONDS,
    })

    // 12 s apart — the real duration, not the nominal 10 s.
    expect(plan[0]?.durMs).toBe(12_000)
  })

  it('never claims a multi-hour duration across a run boundary', () => {
    const base = Math.floor(WRITER_STARTED_MS / 1000) - 100_000
    const plan = planStagingRecovery({
      names: [name(base), name(base + 86_400)],
      writerStartedMs: WRITER_STARTED_MS,
      segmentSeconds: SEGMENT_SECONDS,
    })

    // A day-wide gap is a restart, not a segment. Overstating it would paint a
    // solid timeline bar over footage that does not exist.
    expect(plan[0]?.durMs).toBe(SEGMENT_SECONDS * 1000)
  })

  it('leaves an entry the CURRENT playlist still names to the watcher', () => {
    const older = Math.floor(WRITER_STARTED_MS / 1000) - 50
    const plan = planStagingRecovery({
      names: [name(older)],
      writerStartedMs: WRITER_STARTED_MS,
      segmentSeconds: SEGMENT_SECONDS,
      playlistNames: new Set([name(older)]),
    })

    expect(plan).toEqual([])
  })

  it('ignores everything that is not an epoch-named segment', () => {
    const older = Math.floor(WRITER_STARTED_MS / 1000) - 50
    const plan = planStagingRecovery({
      names: ['live.m3u8', 'notes.txt', '.partial', name(older)],
      writerStartedMs: WRITER_STARTED_MS,
      segmentSeconds: SEGMENT_SECONDS,
    })

    expect(plan.map((o) => o.name)).toEqual([name(older)])
  })

  it('orders the plan by start, whatever order the directory listed', () => {
    const base = Math.floor(WRITER_STARTED_MS / 1000) - 500
    const plan = planStagingRecovery({
      names: [name(base + 20), name(base), name(base + 10)],
      writerStartedMs: WRITER_STARTED_MS,
      segmentSeconds: SEGMENT_SECONDS,
    })

    expect(plan.map((o) => o.startMs)).toEqual([
      base * 1000,
      (base + 10) * 1000,
      (base + 20) * 1000,
    ])
  })
})

describe('recoverStagingOrphans', () => {
  const dir = '/recordings/.rec-tmp/104/high'

  it('finalizes every orphan it found, with its absolute staging path', async () => {
    const base = Math.floor(WRITER_STARTED_MS / 1000) - 500
    const finalized: Array<{ orphan: StagingOrphan; absPath: string }> = []
    const report = await recoverStagingOrphans(
      dir,
      { writerStartedMs: WRITER_STARTED_MS, segmentSeconds: SEGMENT_SECONDS },
      {
        listDir: async () => [name(base), name(base + 10)],
        readPlaylist: async () => null,
        finalize: async (orphan, absPath) => {
          finalized.push({ orphan, absPath })
        },
        logger: quietLogger(),
      },
    )

    expect(report.found).toBe(2)
    expect(report.recovered).toBe(2)
    expect(finalized.map((f) => f.absPath)).toEqual([
      `${dir}/${name(base)}`,
      `${dir}/${name(base + 10)}`,
    ])
  })

  it('keeps going after a failure, and LOGS the segment it dropped', async () => {
    const base = Math.floor(WRITER_STARTED_MS / 1000) - 500
    const logger = quietLogger()
    const recovered: string[] = []
    const report = await recoverStagingOrphans(
      dir,
      { writerStartedMs: WRITER_STARTED_MS, segmentSeconds: SEGMENT_SECONDS },
      {
        listDir: async () => [name(base), name(base + 10), name(base + 20)],
        readPlaylist: async () => null,
        finalize: async (orphan) => {
          if (orphan.name === name(base + 10)) throw new Error('EXDEV')
          recovered.push(orphan.name)
        },
        logger,
      },
    )

    // One bad segment must not cost the other two.
    expect(recovered).toEqual([name(base), name(base + 20)])
    expect(report.recovered).toBe(2)
    expect(report.failed).toBe(1)
    // Silence reads as "never happened": the dropped one is named.
    const warned = logger.warn.mock.calls.map((c) => JSON.stringify(c))
    expect(warned.some((c) => c.includes(name(base + 10)))).toBe(true)
  })

  it('excludes what the live playlist still owns', async () => {
    const older = Math.floor(WRITER_STARTED_MS / 1000) - 50
    const finalized: string[] = []
    const report = await recoverStagingOrphans(
      dir,
      { writerStartedMs: WRITER_STARTED_MS, segmentSeconds: SEGMENT_SECONDS },
      {
        listDir: async () => [name(older)],
        readPlaylist: async () => `#EXTM3U\n#EXTINF:10.000,\n${name(older)}\n`,
        finalize: async (orphan) => {
          finalized.push(orphan.name)
        },
        logger: quietLogger(),
      },
    )

    expect(finalized).toEqual([])
    expect(report.found).toBe(0)
  })

  it('says nothing and does nothing when staging is clean', async () => {
    const logger = quietLogger()
    const report = await recoverStagingOrphans(
      dir,
      { writerStartedMs: WRITER_STARTED_MS, segmentSeconds: SEGMENT_SECONDS },
      {
        listDir: async () => ['live.m3u8'],
        readPlaylist: async () => null,
        finalize: async () => {
          throw new Error('must not be called')
        },
        logger,
      },
    )

    expect(report).toEqual({ found: 0, recovered: 0, failed: 0, aborted: false })
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('yields between chunks so 5 863 orphans cannot monopolise the loop', async () => {
    const base = Math.floor(WRITER_STARTED_MS / 1000) - 100_000
    const names = Array.from({ length: 250 }, (_, i) => name(base + i * 10))
    let yields = 0
    const report = await recoverStagingOrphans(
      dir,
      { writerStartedMs: WRITER_STARTED_MS, segmentSeconds: SEGMENT_SECONDS },
      {
        listDir: async () => names,
        readPlaylist: async () => null,
        finalize: async () => {},
        logger: quietLogger(),
        chunkSize: 50,
        yieldBetween: async () => {
          yields += 1
        },
      },
    )

    expect(report.recovered).toBe(250)
    expect(yields).toBeGreaterThanOrEqual(4)
  })
})

describe('recoverAllStagedOrphans (boot reconcile)', () => {
  const ROOT = '/recordings'
  const BOOT_MS = WRITER_STARTED_MS

  /** A fake staging tree: dir path → entries. */
  function tree(entries: Record<string, readonly string[]>): {
    listDir: (dir: string) => Promise<readonly string[]>
  } {
    return {
      listDir: async (dir: string) => {
        const hit = entries[dir]
        if (hit === undefined) throw new Error(`ENOENT: ${dir}`)
        return hit
      },
    }
  }

  it('sweeps every camera and profile, including one nothing is attached to', async () => {
    const old = Math.floor(BOOT_MS / 1000) - 5_000
    const t = tree({
      [`${ROOT}/.rec-tmp`]: ['104', '1438'],
      [`${ROOT}/.rec-tmp/104`]: ['high', 'low'],
      [`${ROOT}/.rec-tmp/104/high`]: [`${old}.m4s`, 'live.m3u8'],
      [`${ROOT}/.rec-tmp/104/low`]: [`${old + 1}.m4s`],
      // Device 1438 records nothing right now — an attach-time hook would
      // never reach it, and its backlog would sit there for ever.
      [`${ROOT}/.rec-tmp/1438`]: ['mid'],
      [`${ROOT}/.rec-tmp/1438/mid`]: [`${old + 2}.m4s`],
    })
    const finalized: StagedFinalizeInput[] = []

    const report = await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir: t.listDir,
      readPlaylist: async () => null,
      finalize: async (input) => {
        finalized.push(input)
      },
      logger: quietLogger(),
      bootMs: BOOT_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
    })

    expect(report.found).toBe(3)
    expect(report.recovered).toBe(3)
    expect(finalized.map((f) => `${f.deviceId}/${f.profile}`)).toEqual([
      '104/high',
      '104/low',
      '1438/mid',
    ])
    // The location is carried through, so the relocate stays a same-fs rename.
    expect(finalized[0]?.locationId).toBe('recordings:default')
    expect(finalized[0]?.locationRoot).toBe(ROOT)
    expect(finalized[0]?.flatAbsPath).toBe(`${ROOT}/.rec-tmp/104/high/${old}.m4s`)
  })

  it('asks for the config map ONCE per pass, however many devices staged', async () => {
    // The per-device predecessor of this dep re-read the recorder\'s whole
    // 201 KB config blob through hub-main on every call — the ENTIRE walkMs
    // (45–267 s across boots) while the readdirs cost 16 ms. The map is also
    // where a configured value must land: 104 has 4 s configured, 1438 falls
    // back to the default.
    const old = Math.floor(BOOT_MS / 1000) - 5_000
    const t = tree({
      [`${ROOT}/.rec-tmp`]: ['104', '1438'],
      [`${ROOT}/.rec-tmp/104`]: ['high', 'low'],
      [`${ROOT}/.rec-tmp/104/high`]: [`${old}.m4s`],
      [`${ROOT}/.rec-tmp/104/low`]: [`${old + 1}.m4s`],
      [`${ROOT}/.rec-tmp/1438`]: ['mid'],
      [`${ROOT}/.rec-tmp/1438/mid`]: [`${old + 2}.m4s`],
    })
    const finalized: StagedFinalizeInput[] = []
    const mapReads = vi.fn(() => new Map<number, number>([[104, 4]]))

    await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir: t.listDir,
      readPlaylist: async () => null,
      finalize: async (input) => {
        finalized.push(input)
      },
      logger: quietLogger(),
      bootMs: BOOT_MS,
      segmentSecondsByDevice: mapReads,
      defaultSegmentSeconds: SEGMENT_SECONDS,
    })

    expect(mapReads).toHaveBeenCalledTimes(1)
    const by = new Map(finalized.map((f) => [`${f.deviceId}/${f.profile}`, f.durMs]))
    expect(by.get('104/high')).toBe(4_000)
    expect(by.get('1438/mid')).toBe(SEGMENT_SECONDS * 1000)
  })

  it('cannot touch a LIVE writer’s segments — everything named after boot is off limits', async () => {
    const afterBoot = Math.floor(BOOT_MS / 1000) + 30
    const t = tree({
      [`${ROOT}/.rec-tmp`]: ['104'],
      [`${ROOT}/.rec-tmp/104`]: ['high'],
      [`${ROOT}/.rec-tmp/104/high`]: [`${afterBoot}.m4s`, 'live.m3u8'],
    })
    const finalized: StagedFinalizeInput[] = []

    const report = await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir: t.listDir,
      readPlaylist: async () => null,
      finalize: async (input) => {
        finalized.push(input)
      },
      logger: quietLogger(),
      bootMs: BOOT_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
    })

    expect(finalized).toEqual([])
    expect(report.found).toBe(0)
  })

  it('ignores non-profile and non-numeric directories', async () => {
    const old = Math.floor(BOOT_MS / 1000) - 5_000
    const t = tree({
      [`${ROOT}/.rec-tmp`]: ['104', 'lost+found'],
      [`${ROOT}/.rec-tmp/104`]: ['high', 'events', 'strips'],
      [`${ROOT}/.rec-tmp/104/high`]: [`${old}.m4s`],
    })
    const finalized: StagedFinalizeInput[] = []

    const report = await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir: t.listDir,
      readPlaylist: async () => null,
      finalize: async (input) => {
        finalized.push(input)
      },
      logger: quietLogger(),
      bootMs: BOOT_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
    })

    expect(report.dirs).toBe(1)
    expect(finalized).toHaveLength(1)
  })

  it('is harmless when a location has no staging tree, and still says it RAN', async () => {
    const logger = quietLogger()
    const report = await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir: async () => {
        throw new Error('ENOENT')
      },
      readPlaylist: async () => null,
      finalize: async () => {
        throw new Error('must not be called')
      },
      logger,
      bootMs: BOOT_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
    })

    expect(report).toEqual({ dirs: 0, found: 0, recovered: 0, failed: 0, aborted: false })
    // A missing staging tree is the normal case for a fresh root — nothing to
    // warn about, and nothing per-directory to say.
    expect(logger.warn).not.toHaveBeenCalled()
    // But the PASS still reports both ends. "Ran and found zero" and "never got
    // there" are different answers, and only one of them is reassuring; the
    // whole class of loss D148 closed survived six weeks because nothing said
    // anything either way.
    const lines = logger.info.mock.calls.map((c) => String(c[0]))
    expect(lines).toEqual([
      'recorder: staging boot reconcile starting',
      'recorder: staging boot reconcile complete',
    ])
    expect(logger.info.mock.calls[1]![1]).toMatchObject({
      meta: { dirs: 0, found: 0, recovered: 0, failed: 0, aborted: false },
    })
  })

  it('tags every line with the deviceId it is about', async () => {
    const old = Math.floor(BOOT_MS / 1000) - 5_000
    const t = tree({
      [`${ROOT}/.rec-tmp`]: ['102'],
      [`${ROOT}/.rec-tmp/102`]: ['high'],
      [`${ROOT}/.rec-tmp/102/high`]: [`${old}.m4s`],
    })
    const logger = quietLogger()

    await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir: t.listDir,
      readPlaylist: async () => null,
      finalize: async () => {},
      logger,
      bootMs: BOOT_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
    })

    const perDir = logger.info.mock.calls.find((c) => String(c[0]).includes('orphaned in staging'))
    expect(perDir?.[1]).toMatchObject({ tags: { deviceId: 102 } })
  })
})

describe('recoverAllStagedOrphans guards', () => {
  const ROOT = '/recordings'
  const BOOT_MS = WRITER_STARTED_MS
  const old = Math.floor(BOOT_MS / 1000) - 5_000

  function listDirOf(entries: Record<string, readonly string[]>) {
    return async (dir: string): Promise<readonly string[]> => {
      const hit = entries[dir]
      if (hit === undefined) throw new Error(`ENOENT: ${dir}`)
      return hit
    }
  }

  it('never files a segment under a non-numeric device directory', async () => {
    // A populated NON-camera directory: without the numeric guard this files
    // segments under `deviceId: NaN`, which poisons every per-device query and
    // every `tags: { deviceId }` line downstream.
    const listDir = listDirOf({
      [`${ROOT}/.rec-tmp`]: ['lost+found'],
      [`${ROOT}/.rec-tmp/lost+found`]: ['high'],
      [`${ROOT}/.rec-tmp/lost+found/high`]: [`${old}.m4s`],
    })
    const finalized: StagedFinalizeInput[] = []

    const report = await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir,
      readPlaylist: async () => null,
      finalize: async (input) => {
        finalized.push(input)
      },
      logger: quietLogger(),
      bootMs: BOOT_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
    })

    expect(finalized).toEqual([])
    expect(report.dirs).toBe(0)
  })

  it('stops on shutdown, reports it, and leaves the remainder on disk', async () => {
    const listDir = listDirOf({
      [`${ROOT}/.rec-tmp`]: ['104'],
      [`${ROOT}/.rec-tmp/104`]: ['high'],
      [`${ROOT}/.rec-tmp/104/high`]: [
        `${old}.m4s`,
        `${old + 10}.m4s`,
        `${old + 20}.m4s`,
        `${old + 30}.m4s`,
      ],
    })
    const finalized: StagedFinalizeInput[] = []
    let stopping = false
    const logger = quietLogger()

    const report = await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: ROOT }],
      listDir,
      readPlaylist: async () => null,
      finalize: async (input) => {
        finalized.push(input)
        // Shutdown begins after the second segment lands.
        if (finalized.length === 2) stopping = true
      },
      logger,
      bootMs: BOOT_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
      shouldStop: () => stopping,
    })

    // Two moved, two untouched and still on disk for the next boot.
    expect(finalized).toHaveLength(2)
    expect(report.aborted).toBe(true)
    expect(report.recovered).toBe(2)
    // A branch that drops work says so, with what is left.
    const warned = logger.warn.mock.calls.find((c) =>
      String(c[0]).includes('stopped short by shutdown'),
    )
    expect(warned).toBeDefined()
    expect(warned?.[1]).toMatchObject({ meta: { remaining: 2 }, tags: { deviceId: 104 } })
  })
})

/**
 * A pass that runs for minutes says so WHILE it runs (D160).
 *
 * The 2026-08-14 recovery moved 123 000 segments and reported one line per
 * directory, at the end. From outside there was no difference between "half way
 * through 5 863 files" and "hung", and there was nothing to correlate the cap
 * timeouts and stalled writers against.
 */
describe('recoverStagingOrphans — phase reporting', () => {
  const thisRun = Math.floor(WRITER_STARTED_MS / 1000)

  /** `count` orphans, all named comfortably BEFORE the writer's start. */
  function dirOf(count: number): string[] {
    return Array.from({ length: count }, (_, i) => name(thisRun - 10 * count - 10 + i * 10))
  }

  it('announces the directory BEFORE the first rename, with what it found', async () => {
    const logger = quietLogger()
    await recoverStagingOrphans(
      '/recordings/.rec-tmp/104/high',
      { writerStartedMs: WRITER_STARTED_MS, segmentSeconds: SEGMENT_SECONDS },
      {
        listDir: async () => dirOf(3),
        readPlaylist: async () => null,
        finalize: async () => {
          // By the time ANY work happens the start line must already be out.
          expect(logger.info.mock.calls[0]![0]).toBe(
            'recorder: staging recovery starting on a directory',
          )
        },
        logger,
      },
    )
    expect(logger.info.mock.calls[0]![1]).toMatchObject({
      meta: { dir: '/recordings/.rec-tmp/104/high', found: 3, staged: 3 },
    })
  })

  it('reports progress every 1 000 orphans, not only at the end', async () => {
    const logger = quietLogger()
    const report = await recoverStagingOrphans(
      '/recordings/.rec-tmp/104/high',
      { writerStartedMs: WRITER_STARTED_MS, segmentSeconds: SEGMENT_SECONDS },
      {
        listDir: async () => dirOf(2_500),
        readPlaylist: async () => null,
        finalize: async () => {},
        logger,
        chunkSize: 500,
        yieldBetween: async () => {},
      },
    )
    expect(report.recovered).toBe(2_500)
    const progress = logger.info.mock.calls.filter(
      (c) => c[0] === 'recorder: staging recovery progress',
    )
    expect(progress.map((c) => (c[1] as { meta: { done: number } }).meta.done)).toEqual([
      1_000, 2_000,
    ])
  })
})

describe('recoverAllStagedOrphans — pacing (D160)', () => {
  const thisRun = Math.floor(WRITER_STARTED_MS / 1000)

  it('yields through the injected hop, so ONE pacer paces every directory', async () => {
    const logger = quietLogger()
    let hops = 0
    const files = Array.from({ length: 40 }, (_, i) => name(thisRun - 10_000 + i * 10))
    await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: '/recordings' }],
      listDir: async (dir: string) => {
        if (dir.endsWith('.rec-tmp')) return ['104']
        if (dir.endsWith('/104')) return ['high', 'low']
        return files
      },
      readPlaylist: async () => null,
      finalize: async () => {},
      logger,
      bootMs: WRITER_STARTED_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
      chunkSize: 10,
      yieldBetween: async () => {
        hops += 1
      },
    })
    // 2 profiles x 40 orphans at 10 per chunk = 3 mid-directory yields each,
    // plus one hop per directory LISTING: the staging root, `104/`, and each
    // of the two profile directories. Without the wiring the per-directory
    // pass falls back to its own bare macrotask and the pacer never sees the
    // contention at all.
    expect(hops).toBe(6 + 4)
  })

  /**
   * The WALK is the whole cost on a cold share, and it used to be invisible.
   *
   * Boot of 2026-08-19 05:35, FUSE cold: `staging boot reconcile complete …
   * ms=547592` with `pacing={"hops":0,"contendedHops":0,"pausedMs":0,
   * "maxLagMs":0}` — 58 staging directories at ~9.4 s per `listDir`, and only
   * 25 orphans in total, far below one chunk. So the only yields that existed
   * (between segment chunks) never fired: 547 s of un-paced round-trips
   * reported as "nothing else ever wanted the loop". The same walk costs 4.1 s
   * once the share is warm, which is why only a power-cycle shows it.
   */
  it('paces every directory listing, and the pacer SEES what the cold share cost', async () => {
    // The share model: a listing leaves a deep queue behind it, and the next
    // zero-delay probe is what observes that. Clock and sleep are injected —
    // nothing here waits on real time, and one profile keeps the walk serial
    // so the back-off sequence is exact rather than lane-dependent.
    const COLD_LIST_MS = 9_400
    let clock = 0
    let pendingLagMs = 0
    const sleeps: number[] = []
    const pacer = new LoopPacer({
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        if (ms > 0) {
          clock += ms
          return
        }
        clock += pendingLagMs
        pendingLagMs = 0
      },
      busyLagMs: 25,
      backoffStepMs: 25,
      maxBackoffMs: 100,
    })

    await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: '/recordings' }],
      listDir: async (dir: string) => {
        clock += COLD_LIST_MS
        pendingLagMs = COLD_LIST_MS
        if (dir.endsWith('.rec-tmp')) return ['104']
        if (dir.endsWith('/104')) return ['high']
        // Not one orphan: the walk alone is the 547 s.
        return ['live.m3u8']
      },
      readPlaylist: async () => null,
      finalize: async () => {
        throw new Error('must not be called')
      },
      logger: quietLogger(),
      bootMs: WRITER_STARTED_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
      yieldBetween: () => pacer.hop(),
    })

    // Three listings — staging root, `104/`, and the profile directory — and
    // every one of them is a hop the pacer can price.
    expect(pacer.stats()).toEqual({
      hops: 3,
      contendedHops: 3,
      pausedMs: 25 + 50 + 75,
      maxLagMs: COLD_LIST_MS,
    })
    // It stands further back the longer the share stays slow, instead of
    // walking at full tilt across a recorder that is trying to start writing.
    expect(sleeps.filter((ms) => ms > 0)).toEqual([25, 50, 75])
  })

  it('counts the walk in the completion line — `hops: 0` was a false all-clear', async () => {
    const logger = quietLogger()

    await recoverAllStagedOrphans({
      locations: () => [{ id: 'recordings:default', root: '/recordings' }],
      listDir: async (dir: string) => {
        if (dir.endsWith('.rec-tmp')) return ['104']
        if (dir.endsWith('/104')) return ['high', 'low']
        return ['live.m3u8']
      },
      readPlaylist: async () => null,
      finalize: async () => {},
      logger,
      bootMs: WRITER_STARTED_MS,
      segmentSecondsByDevice: () => new Map<number, number>(),
      defaultSegmentSeconds: SEGMENT_SECONDS,
      // No injected hop: the pass builds its own pacer, and what that pacer
      // REPORTS is the only evidence a cold boot leaves behind.
    })

    const complete = logger.info.mock.calls.find(
      (c) => c[0] === 'recorder: staging boot reconcile complete',
    )
    // Four listings, zero orphans. Anything less than 4 means the walk is
    // still outside the pacer and the counters are lying about it.
    expect(complete?.[1]).toMatchObject({
      meta: { found: 0, pacing: { hops: 4 } },
    })
    // And the walk's own cost is separated from the recovery's, so the next
    // cold boot answers "which half was the 547 s" without a stopwatch.
    expect(complete?.[1]).toMatchObject({ meta: { walkMs: expect.any(Number) } })
  })
})
