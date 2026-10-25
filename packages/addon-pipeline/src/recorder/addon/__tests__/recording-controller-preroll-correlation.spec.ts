/**
 * The recorder's HALF of the pre-roll correlation.
 *
 * `rtsp-pre-roll-correlation.spec.ts` pins that the broker reports which
 * consumer received a pre-roll burst, keyed by the `User-Agent` on the RTSP
 * dial. That key is worth nothing unless the recorder (a) puts a per-attach
 * value there instead of the constant `recorder`, (b) prints it next to the
 * device and profile it belongs to, and (c) names the FILE its first segment
 * landed in — because the question being answered is "is the 9.4 s the broker
 * says it served inside THAT file", and a `sessionId` on one side and a
 * `deviceId` on the other never met.
 *
 * Field state this closes (2026-08-20): `restream prime` reported
 * `recordingPreRollSpanMs` 7.9–10.0 s with `preRollServed=1` on five cameras,
 * while `ffprobe` on a first segment of a 101/low attach reported 12.001 s of
 * media over 12 000 ms of wall clock — media accumulated live, no burst. Both
 * measurements stand; nothing ties them to the same attach.
 */
import { RECORDING_PRE_ROLL_REQUEST_MS } from '../../../stream-broker/rtsp/restream-intent.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordingController, type RecordingControllerDeps } from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

interface FakeProc {
  kill: ReturnType<typeof vi.fn>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: () => void }
}

function makeFakeProc(): FakeProc {
  return { kill: vi.fn(), on: () => {}, stderr: { on: () => {} } }
}

interface LogCall {
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface SpawnCall {
  readonly args: readonly string[]
}

interface Harness {
  readonly controller: RecordingController
  readonly logs: LogCall[]
  readonly spawns: SpawnCall[]
  readonly outDir: string
  setClock(ms: number): void
}

const DEVICE_ID = 101
const PROFILE = 'low'
const T = 1_787_243_450_000
const SEGMENT_SECONDS = 10
const realSetTimeout = setTimeout
// Captured before `vi.useFakeTimers()`, which fakes `performance` as well.
const realNow = performance.now.bind(performance)

const EVENTS_CONFIG: RecordingConfig = {
  enabled: true,
  segmentSeconds: SEGMENT_SECONDS,
  bands: [
    {
      mode: 'events',
      days: [],
      start: '00:00',
      end: '00:00',
      triggers: { motion: true },
      preBufferSec: 15,
      postBufferSec: 30,
    },
  ],
}

async function makeHarness(root: string): Promise<Harness> {
  let clock = T
  const logs: LogCall[] = []
  const spawns: SpawnCall[] = []

  const record =
    (tags: Record<string, unknown>) =>
    (msg: string, fields?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> }) => {
      logs.push({ msg, meta: fields?.meta ?? {}, tags: { ...tags, ...fields?.tags } })
    }
  const makeLogger = (tags: Record<string, unknown>): Record<string, unknown> => ({
    info: record(tags),
    warn: record(tags),
    error: record(tags),
    debug: () => {},
    child: () => makeLogger(tags),
    withTags: (extra: Record<string, unknown>) => makeLogger({ ...tags, ...extra }),
  })

  const api = {
    streamBroker: {
      getStreamWithCodec: {
        mutate: async () => ({
          url: 'rtsp://127.0.0.1:8554/cam101-low',
          videoCodec: 'H264' as const,
          audioCodec: 'aac' as const,
          resolution: { width: 640, height: 360 },
          transcoded: false,
          encoder: 'copy',
          pipelineKey: 'pk-101-low',
        }),
      },
      releaseStreamWithCodec: { mutate: async () => ({ released: true, refcount: 0 }) },
      listAllProfileSlots: {
        query: async () => [
          { deviceId: DEVICE_ID, profile: PROFILE, camStreamId: 'native:sub', status: 'streaming' },
        ],
      },
    },
  } as never

  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger: makeLogger({}) as never,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: async () => null } as never,
    loadConfig: async () => EVENTS_CONFIG,
    enabledDeviceIds: async () => [DEVICE_ID],
    locations: () => [
      recordingsLocationOfMode({ id: 'recordings:default', type: 'recordings', root }, 'active'),
    ],
    spawn: ((_cmd: string, args: readonly string[]) => {
      spawns.push({ args })
      return makeFakeProc()
    }) as never,
    segmentSeconds: SEGMENT_SECONDS,
    watchIntervalMs: 1_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
    now: () => clock,
  }

  return {
    controller: new RecordingController(deps),
    logs,
    spawns,
    outDir: path.join(root, '.rec-tmp', String(DEVICE_ID), PROFILE),
    setClock: (ms: number) => {
      clock = ms
    },
  }
}

async function writeSegments(
  outDir: string,
  segments: ReadonlyArray<{ startMs: number; extinf: number }>,
): Promise<string[]> {
  const paths: string[] = []
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7']
  for (const seg of segments) {
    const name = `${Math.floor(seg.startMs / 1000)}.m4s`
    const abs = path.join(outDir, name)
    await fs.writeFile(abs, 'fake-segment-bytes')
    paths.push(abs)
    lines.push(`#EXTINF:${seg.extinf.toFixed(3)},`, name)
  }
  await fs.writeFile(path.join(outDir, 'live.m3u8'), `${lines.join('\n')}\n`)
  return paths
}

/**
 * Advance the fake clock until `predicate` holds.
 *
 * Each watcher pass is real fs I/O (libuv thread pool) kicked from a faked
 * timer callback, and fake-timer advancement cannot await it. The previous
 * loop yielded with `setImmediate` and gave up after a fixed COUNT of turns:
 * `setImmediate` runs in the check phase right after the poll phase, so under
 * load the whole count was burnt in milliseconds, before the thread pool had
 * delivered one result, and the test failed as "did not settle" (CI
 * 38297678879; a later `retry: 2` only hid it). A real 1 ms timer lets the
 * loop actually reach the poll phase and take the I/O completions, and the
 * bound is wall-clock — a hung watcher still fails, a slow host does not.
 */
const SETTLE_BUDGET_MS = 20_000

async function settle(_h: Harness, predicate: () => boolean): Promise<void> {
  const startedAt = realNow()
  for (let i = 0; realNow() - startedAt < SETTLE_BUDGET_MS; i++) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(i % 20 === 19 ? 1_000 : 50)
    await new Promise<void>((resolve) => realSetTimeout(resolve, 1))
  }
  throw new Error('recorder watcher did not settle within the test budget')
}

function uaOf(args: readonly string[]): string | undefined {
  const i = args.indexOf('-user_agent')
  return i < 0 ? undefined : args[i + 1]
}

// Real fs I/O per watcher pass: a loaded host is slow, not wrong (see `settle`).
describe('the recorder names the dial it opened, and the file it produced', {
  timeout: 60_000,
}, () => {
  let root: string

  beforeEach(async () => {
    vi.useFakeTimers()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-preroll-corr-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('puts a per-attach consumer tag on the dial AND in `writer spawned`', async () => {
    const h = await makeHarness(root)
    h.setClock(T)
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T)
    await settle(h, () => h.spawns.length > 0)

    expect(h.spawns).toHaveLength(1)
    const ua = uaOf(h.spawns[0]!.args)
    // The old value was the constant `recorder` — shared by every writer on the
    // node, so a broker line naming it identified nothing.
    expect(ua).not.toBe('recorder')
    expect(ua).toMatch(/^recorder\/101\/low\/\d+$/)

    // The dial still declares the recording intent, or there is no burst to
    // correlate in the first place.
    const url = h.spawns[0]!.args[h.spawns[0]!.args.indexOf('-i') + 1]
    // The intent AND the amount (D382): the recorder asks for the whole
    // retained window rather than leaving the ask to a default.
    expect(url).toBe(
      `rtsp://127.0.0.1:8554/cam101-low/recording/preroll-${RECORDING_PRE_ROLL_REQUEST_MS}`,
    )

    const spawned = h.logs.find((l) => l.msg.includes('writer spawned'))
    expect(spawned).toBeDefined()
    expect(spawned!.meta.consumer).toBe(ua)
    expect(spawned!.tags).toMatchObject({ deviceId: DEVICE_ID })

    await h.controller.stop()
  })

  it('gives two attaches of the same device+profile DIFFERENT tags', async () => {
    // The ambiguity that makes `deviceId/profile` alone useless as a join key:
    // a device detaches when its window closes and re-attaches on the next
    // trigger, so the same pair names two different writers and two different
    // sets of files within one recorder run.
    const h = await makeHarness(root)
    h.setClock(T)
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T)
    await settle(h, () => h.spawns.length > 0)

    await h.controller.pause()
    h.setClock(T + 120_000)
    await h.controller.resume()
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T + 120_000)
    await settle(h, () => h.spawns.length > 1)

    expect(h.spawns.length).toBeGreaterThan(1)
    expect(uaOf(h.spawns[0]!.args)).not.toBe(uaOf(h.spawns[1]!.args))
    await h.controller.stop()
  })

  it('names the FILE and its media duration on the first segment of the attach', async () => {
    const h = await makeHarness(root)
    h.setClock(T)
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T)
    await settle(h, () => h.spawns.length > 0)

    await writeSegments(h.outDir, [
      { startMs: T + 9_000, extinf: 12.001 },
      { startMs: T + 21_000, extinf: 10.0 },
    ])
    h.setClock(T + 22_000)
    await settle(h, () => h.logs.some((l) => l.msg.includes('first segment of this attach')))

    const first = h.logs.find((l) => l.msg.includes('first segment of this attach'))
    expect(first).toBeDefined()
    // Without the file name the broker's "I served 9.4 s to recorder/101/low/1"
    // cannot be checked with `ffprobe` against anything.
    expect(first!.meta.file).toBe(`${(T + 9_000) / 1000}.m4s`)
    // The MEDIA duration, which is the whole question: 12 000 ms of media in a
    // segment whose name is 12 000 ms older than its successor's is media
    // accumulated live. A burst would show up as media far exceeding the wall
    // clock the file was open for.
    expect(first!.meta.durMs).toBe(12_000)
    expect(first!.meta.consumer).toBe(uaOf(h.spawns[0]!.args))
    expect(first!.tags).toMatchObject({ deviceId: DEVICE_ID })

    await h.controller.stop()
  })

  /**
   * Camera 3836, 2026-09-28: every attach printed exactly one "first segment"
   * line — at TEARDOWN, with `spawnToFirstSegmentMs` equal to the writer's
   * lifetime (514 309, 159 569 ms …). The latch was a (device, profile) key
   * cleared BEFORE the teardown flush, so the flush's final segment re-latched
   * it, and the stale latch then swallowed the next attach's genuine line.
   */
  it('logs ONE first segment per attach — not the teardown flush, and not never', async () => {
    const h = await makeHarness(root)
    h.setClock(T)
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T)
    await settle(h, () => h.spawns.length > 0)
    const firsts = (): LogCall[] =>
      h.logs.filter((l) => l.msg.includes('first segment of this attach'))

    await writeSegments(h.outDir, [
      { startMs: T + 1_000, extinf: 10.0 },
      { startMs: T + 11_000, extinf: 10.0 },
    ])
    h.setClock(T + 12_000)
    await settle(h, () => firsts().length > 0)
    expect(firsts()).toHaveLength(1)

    // Detach: the flush finalizes the held tail (T+11 s). It is NOT a first.
    h.setClock(T + 60_000)
    await h.controller.pause()
    expect(firsts()).toHaveLength(1)
    // The drained playlist is on the controller's ledger, for the next watcher
    // of this directory (and the census).
    expect(h.controller.drainedLedgerSize).toBe(1)
    expect(h.controller.memoryCensus().drainedPlaylists).toBe(1)

    // The next attach measures its OWN first segment.
    h.setClock(T + 120_000)
    await h.controller.resume()
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T + 120_000)
    await settle(h, () => h.spawns.length > 1)
    await writeSegments(h.outDir, [
      { startMs: T + 121_000, extinf: 10.0 },
      { startMs: T + 131_000, extinf: 10.0 },
    ])
    h.setClock(T + 132_000)
    await settle(h, () => firsts().length > 1)

    expect(firsts()).toHaveLength(2)
    expect(firsts()[1]!.meta.consumer).toBe(uaOf(h.spawns[1]!.args))
    expect(firsts()[1]!.meta.spawnToFirstSegmentMs).toBe(1_000)
    await h.controller.stop()
  })
})
