/**
 * **A thumbnail never FETCHES a clip, and never outranks a playback.**
 *
 * Shipped once without this rule and measured within minutes: 20 rows on 1436
 * spanning 898 s, each un-held tile paying a full realtime fetch of its clip
 * — minutes during which nothing could play. Then shipped too strictly, so a
 * clip nobody had opened never got a picture at all.
 *
 * What is proved here is the shape that survived both: a still takes the
 * camera's FIRST FRAME (433–528 ms of the slot, measured, whatever the clip's
 * length) and never the clip; it is SPECULATIVE, so an operator's tap evicts
 * it mid-replay; and an eviction or a busy slot is DEFERRED, because half a
 * second that lost a race is worth coming back for.
 *
 * The catalog module is mocked because the ROW is all these paths need.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import type { IScopedLogger } from '@camstack/types'

import type { HikvisionClipRow } from '../clip-catalog.js'
import { clipKeyFor } from '../clip-identity.js'
import type { HikvisionClipCamera } from '../clip-service.js'
import { ClipArtifactStore } from '../clip-artifact-store.js'
import { createReplayLane } from '../replay-lane.js'
import type {
  RtspReplayEnd,
  RtspReplayHandlers,
  RtspReplaySession,
} from '../rtsp/rtsp-replay-session.js'
import type { RtspVideoTrack } from '../rtsp/rtsp-sdp.js'

// The key the PROVIDER derives from a clip id, not one invented here: a row
// whose key does not match what `resolveRow` computes is a fixture that can
// only test the half of the path that does not use it.
const ROW: HikvisionClipRow = {
  clipKey: clipKeyFor(101, 'ch01_00000000447001'),
  trackId: 101,
  fileName: 'ch01_00000000447001',
  startMs: 1_790_000_000_000,
  endMs: 1_790_000_019_000,
  playbackPath: '/Streaming/tracks/101/?starttime=x&endtime=y',
  sizeBytes: 11_600_000,
  recordTypes: ['motion'],
}

vi.mock('../clip-catalog.js', () => ({
  readStorageState: async () => ({ kind: 'present' }),
  readArchivedTracks: async () => [{ id: 101, enabled: true, isVideo: true }],
  listClipRows: async () => ({ kind: 'ok', rows: [ROW], pages: 1 }),
}))

const { createClipService } = await import('../clip-service.js')
type ClipService = ReturnType<typeof createClipService>

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

const VIDEO_TRACK: RtspVideoTrack = {
  kind: 'video',
  codec: 'h265',
  payloadType: 96,
  clockRate: 90_000,
  control: 'trackID=1',
  parameterSets: [],
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43])

// A documented type boundary: no path under test reaches the ISAPI client, and
// the catalog module is mocked out from under the two that would.
const client = {} as unknown as HikvisionClipCamera['client']

interface Answered {
  status: number | null
  headers: Record<string, string>
  body: Buffer | null
}

function fakeResponse(): { res: ServerResponse; answered: Answered } {
  const answered: Answered = { status: null, headers: {}, body: null }
  const res = {
    headersSent: false,
    writeHead: (status: number, headers?: Record<string, string>) => {
      answered.status = status
      answered.headers = { ...answered.headers, ...headers }
      return res
    },
    write: () => true,
    once: () => res,
    end: (bytes?: Buffer) => {
      if (bytes !== undefined) answered.body = bytes
      return res
    },
    destroy: () => res,
  }
  // A documented type boundary: these routes touch writeHead/write/once/end.
  return { res: res as unknown as ServerResponse, answered }
}

function thumbRequest(): IncomingMessage {
  return {
    method: 'GET',
    url: `/1436/${ROW.clipKey}`,
    headers: {},
  } as unknown as IncomingMessage
}

/** An ffmpeg that answers with a JPEG on stdout, counting what it was fed. */
function fakeStill(): {
  spawn: (args: readonly string[]) => ChildProcess
  calls: () => number
  stdinBytes: () => number
} {
  let calls = 0
  let stdinBytes = 0
  return {
    calls: () => calls,
    stdinBytes: () => stdinBytes,
    spawn: () => {
      calls += 1
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      stdin.on('data', (chunk: Buffer) => {
        stdinBytes += chunk.byteLength
      })
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stdin,
        stderr: new PassThrough(),
      })
      queueMicrotask(() => {
        stdout.write(JPEG)
        child.emit('close', 0)
      })
      // A documented type boundary: this module touches stdin/stdout/stderr,
      // `once` and `kill`.
      return child as unknown as ChildProcess
    },
  }
}

/** Every fake access unit is this long, so "how much was kept" is countable. */
const UNIT_BYTES = 6

interface Built {
  readonly service: ClipService
  readonly opens: () => number
  readonly dataDir: string
  readonly still: ReturnType<typeof fakeStill>
  /** Let a held-open replay finish. */
  readonly release: () => void
  /** Take the lane as a PLAYBACK would, and say whether it was granted. */
  readonly lane: (deviceId: number) => Promise<string>
}

async function build(options: { deliverUnits?: number; holdOpen?: boolean } = {}): Promise<Built> {
  let opens = 0
  const dataDir = await mkdtemp(join(tmpdir(), 'hik-still-'))
  const still = fakeStill()
  const releases: (() => void)[] = []
  const openReplay = async (
    _target: unknown,
    handlers: RtspReplayHandlers,
  ): Promise<RtspReplaySession> => {
    opens += 1
    let settle: (end: RtspReplayEnd) => void = () => {}
    const ended = new Promise<RtspReplayEnd>((resolve) => {
      settle = resolve
    })
    releases.push(() => settle({ kind: 'complete', deliveredMs: 19_000 }))
    queueMicrotask(() => {
      for (let i = 0; i < (options.deliverUnits ?? 0); i += 1) {
        handlers.onVideo({
          bytes: Buffer.alloc(UNIT_BYTES, i),
          timestamp: i * 7_200,
          keyframe: i === 0,
        })
      }
      // `holdOpen` is a replay that has NOT yet produced enough: the slot is
      // genuinely occupied, which is what the busy and yield cases need.
      if (options.holdOpen !== true) settle({ kind: 'complete', deliveredMs: 19_000 })
    })
    return { ended, video: VIDEO_TRACK, hasAudio: false, close: async () => {} }
  }
  const lane = createReplayLane({ logger, waitMs: 40 })
  const service = createClipService({
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    dataDir,
    logger,
    resolveCamera: async () => ({
      deviceId: 1436,
      host: '203.0.113.1',
      username: 'u',
      password: 'p',
      client,
    }),
    replayWaitMs: 40,
    openReplay,
    spawnStill: still.spawn,
    spawnMux: () => {
      throw new Error('a still must never reach the clip mux — that is a whole-clip fetch')
    },
    lane,
  })
  await service.provider.listClips?.({
    deviceId: 1436,
    since: ROW.startMs - 1,
    until: ROW.endMs + 1,
    provider: 'provider-hikvision',
  })
  return {
    service,
    opens: () => opens,
    dataDir,
    still,
    release: () => {
      for (const r of releases) r()
    },
    lane: async (deviceId) => (await lane.acquire(deviceId, 'stream')).kind,
  }
}

describe('a Hikvision clip still', () => {
  it('takes the camera’s FIRST FRAME and never fetches the clip', async () => {
    // THE CLAIM. One replay, two access units, torn down — not a 20–150 s
    // whole-clip fetch. `spawnMux` throws, so reaching `prepareClipFile` at
    // all would fail the test rather than merely be slower.
    const built = await build({ deliverUnits: 4 })
    const { res, answered } = fakeResponse()
    await built.service.thumbHandler(thumbRequest(), res)

    expect(answered.status).toBe(200)
    expect(answered.headers['content-type']).toBe('image/jpeg')
    expect(answered.body).toEqual(JPEG)
    expect(built.opens()).toBe(1)
    expect(built.still.calls()).toBe(1)
    // Only the head was kept: the bytes handed to ffmpeg are the first two
    // access units, not the segment.
    expect(built.still.stdinBytes()).toBe(2 * UNIT_BYTES)
    // And nothing was archived: a still must not fill the media scratch.
    expect(await new ClipArtifactStore({ root: built.dataDir }).has(1436, ROW.clipKey)).toBe(false)
  })

  it('serves a cached still without touching the camera at all', async () => {
    const built = await build({ deliverUnits: 4 })
    const first = fakeResponse()
    await built.service.thumbHandler(thumbRequest(), first.res)
    expect(built.opens()).toBe(1)

    const second = fakeResponse()
    await built.service.thumbHandler(thumbRequest(), second.res)
    expect(second.answered.status).toBe(200)
    // No second replay and no second decode: the vouched artifact answers.
    expect(built.opens()).toBe(1)
    expect(built.still.calls()).toBe(1)
  })

  it('cuts from bytes already on this disk, opening no replay', async () => {
    const built = await build({ deliverUnits: 4 })
    // A clip the operator played or exported: the recording is already here.
    await new ClipArtifactStore({ root: built.dataDir }).put(
      1436,
      ROW.clipKey,
      Buffer.alloc(2048, 3),
    )
    const { res, answered } = fakeResponse()
    await built.service.thumbHandler(thumbRequest(), res)
    expect(answered.status).toBe(200)
    expect(built.opens()).toBe(0)
    expect(built.still.calls()).toBe(1)
  })

  it('DEFERS rather than refusing when the camera’s slot is busy', async () => {
    // Half a second that lost a race is worth coming back for — which is
    // exactly what was NOT true when a still cost the clip's whole duration,
    // and why that refusal was final and this one is not.
    const built = await build({ deliverUnits: 0, holdOpen: true })
    const slow = built.service.thumbHandler(thumbRequest(), fakeResponse().res)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const { res, answered } = fakeResponse()
    await built.service.thumbHandler(thumbRequest(), res)

    expect(answered.status).toBe(204)
    expect(answered.headers['x-camstack-reason-code']).toBe('queue-full')
    expect(answered.headers['x-camstack-disposition']).toBe('deferred')
    expect(answered.headers['retry-after']).toBeDefined()
    // The camera was asked ONCE: the second tile never reached it.
    expect(built.opens()).toBe(1)
    built.release()
    await slow
  })

  it('gives the slot back the instant a PLAYBACK wants it', async () => {
    // The rule the live numbers bought: twenty tiles must never cost the
    // operator his tap. The mint is evicted mid-replay and the stream gets
    // the camera; the tile is told `deferred`, not `final`.
    const built = await build({ deliverUnits: 0, holdOpen: true })
    const tile = fakeResponse()
    const minting = built.service.thumbHandler(thumbRequest(), tile.res)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const lease = await built.lane(1436)
    expect(lease).toBe('held')
    await minting
    expect(tile.answered.status).toBe(204)
    expect(tile.answered.headers['x-camstack-reason-code']).toBe('queue-full')
    expect(tile.answered.headers['x-camstack-disposition']).toBe('deferred')
  })
})
