/**
 * Battery-conditioned bands through the REAL controller: a band may carry a
 * charge range (`battery: { min, max }`), the charge is read from the owner's
 * slice, and a segment is judged by the charge its ATTACH was decided against.
 *
 * Real staging directory and `live.m3u8`, like `recording-controller-late-attach`:
 * the keep gate's verdict is a composition of the live decision and the segment
 * timestamps, and only the composition shows a charge that moved mid-write.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATTERY_BAND_DWELL_MS } from '../../battery-hysteresis.js'
import { RecordingController, type RecordingControllerDeps } from '../recording-controller'
import { settleUntil } from './settle.js'
import { recordingsLocationOfMode } from '../roots.js'

const DEVICE_ID = 77
const T = 1_787_010_352_000
const SEGMENT_SECONDS = 10

/** >= 50 % continuous, 20..50 % events on motion, below that nothing. */
const BANDED: RecordingConfig = {
  enabled: true,
  segmentSeconds: SEGMENT_SECONDS,
  bands: [
    { mode: 'continuous', days: [], start: '00:00', end: '00:00', battery: { min: 50 } },
    {
      mode: 'events',
      days: [],
      start: '00:00',
      end: '00:00',
      battery: { min: 20, max: 50 },
      triggers: { motion: true },
      postBufferSec: 30,
    },
  ],
}

/** A conditioned continuous band over an unconditioned events fallback. */
const WITH_FALLBACK: RecordingConfig = {
  enabled: true,
  segmentSeconds: SEGMENT_SECONDS,
  bands: [
    { mode: 'continuous', days: [], start: '00:00', end: '00:00', battery: { min: 0 } },
    {
      mode: 'events',
      days: [],
      start: '00:00',
      end: '00:00',
      triggers: { motion: true },
      postBufferSec: 30,
    },
  ],
}

interface LogCall {
  readonly level: string
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface Harness {
  readonly controller: RecordingController
  readonly finalized: number[]
  readonly logs: LogCall[]
  readonly outDir: string
  setClock(ms: number): void
  setLevel(level: number | null): void
}

function makeHarness(root: string, config: RecordingConfig): Harness {
  let clock = T
  let level: number | null = null
  const finalized: number[] = []
  const logs: LogCall[] = []
  const record =
    (lvl: string) =>
    (msg: string, fields?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> }) => {
      logs.push({ level: lvl, msg, meta: fields?.meta ?? {}, tags: fields?.tags ?? {} })
    }
  const logger: Record<string, unknown> = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  const api = {
    streamBroker: {
      getStreamWithCodec: {
        mutate: async () => ({
          url: 'rtsp://127.0.0.1:8554/cam77-high',
          videoCodec: 'H265' as const,
          audioCodec: 'aac' as const,
          resolution: { width: 1920, height: 1080 },
          transcoded: false,
          encoder: 'copy',
          pipelineKey: 'pk-77-high',
        }),
      },
      releaseStreamWithCodec: { mutate: async () => ({ released: true, refcount: 0 }) },
      listAllProfileSlots: {
        query: async () => [
          { deviceId: DEVICE_ID, profile: 'high', camStreamId: 'native:main', status: 'streaming' },
        ],
      },
    },
  } as never
  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger: logger as never,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: {
      onFinalized: async (input: { startMs: number }) => {
        finalized.push(input.startMs)
        return null
      },
    } as never,
    loadConfig: async () => config,
    enabledDeviceIds: async () => [DEVICE_ID],
    readBatteryLevel: async () => level,
    locations: () => [
      recordingsLocationOfMode({ id: 'recordings:default', type: 'recordings', root }, 'active'),
    ],
    spawn: (() => ({
      kill: vi.fn(),
      on: () => {},
      stderr: { on: () => {} },
    })) as never,
    segmentSeconds: SEGMENT_SECONDS,
    watchIntervalMs: 1_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
    now: () => clock,
  }
  return {
    controller: new RecordingController(deps),
    finalized,
    logs,
    outDir: path.join(root, '.rec-tmp', String(DEVICE_ID), 'high'),
    setClock: (ms) => {
      clock = ms
    },
    setLevel: (next) => {
      level = next
    },
  }
}

async function writeSegments(outDir: string, startsMs: readonly number[]): Promise<void> {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7']
  for (const startMs of startsMs) {
    const name = `${Math.floor(startMs / 1000)}.m4s`
    await fs.writeFile(path.join(outDir, name), 'fake-segment-bytes')
    lines.push('#EXTINF:10.000,', name)
  }
  await fs.writeFile(path.join(outDir, 'live.m3u8'), `${lines.join('\n')}\n`)
}

describe('battery-conditioned bands', () => {
  let root: string
  beforeEach(async () => {
    vi.useFakeTimers()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-battery-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps a segment by the charge the attach was decided against, not a fresh read', async () => {
    const h = makeHarness(root, BANDED)

    // 80 % -> the continuous band covers: the camera attaches.
    h.setLevel(80)
    await h.controller.onBatteryChanged(DEVICE_ID)
    await writeSegments(h.outDir, [T + 5_000, T + 15_000])

    // The charge falls to 30 % well past the dwell: the events band now covers
    // and no trigger asks for footage, so the writer detaches and flushes. The
    // flushed segments were written under the continuous attach, so they stay.
    h.setLevel(30)
    h.setClock(T + BATTERY_BAND_DWELL_MS + 60_000)
    await h.controller.onBatteryChanged(DEVICE_ID)
    await settleUntil(
      () => h.logs.some((l) => l.msg.includes('recorder unpinned broker source')),
      'the drop to the events band detached the writer',
    )

    expect(h.finalized).toEqual([T + 5_000, T + 15_000])
    expect(h.logs.find((l) => l.msg.includes('discarding'))).toBeUndefined()
    const moved = h.logs.findLast((l) => l.msg.includes('battery level moved the active band'))
    expect(moved?.tags).toMatchObject({ deviceId: DEVICE_ID })
    expect(moved?.meta).toMatchObject({ level: 30, toMode: 'events' })

    await h.controller.stop()
  })

  it('records nothing below every band and says so, with the deviceId', async () => {
    const h = makeHarness(root, BANDED)
    h.setLevel(10)
    await h.controller.onBatteryChanged(DEVICE_ID)

    expect(h.logs.some((l) => l.msg.includes('pinned broker source'))).toBe(false)
    const gone = h.logs.find((l) => l.msg.includes('left every band'))
    expect(gone?.tags).toMatchObject({ deviceId: DEVICE_ID })

    await h.controller.stop()
  })

  it('an UNKNOWN charge on a fresh start applies only unconditioned bands, logged once', async () => {
    const h = makeHarness(root, WITH_FALLBACK)
    h.setLevel(null)
    await h.controller.onBatteryChanged(DEVICE_ID)
    await h.controller.onBatteryChanged(DEVICE_ID)

    // The conditioned continuous band is NOT met, so the events fallback (no
    // trigger yet) demands nothing: no attach, and unknown was never read as 0.
    expect(h.logs.some((l) => l.msg.includes('pinned broker source'))).toBe(false)
    const unknown = h.logs.filter((l) => l.msg.includes('battery level unknown'))
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.tags).toMatchObject({ deviceId: DEVICE_ID })

    await h.controller.stop()
  })
})
