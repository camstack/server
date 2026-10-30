/**
 * The camera's one playback slot, proved where it is ENFORCED.
 *
 * `replay-lane.spec.ts` proves the lane. This proves the service WIRES it: a
 * second stream against a camera whose replay is open is refused by name, with
 * a status that says "come back" rather than "this is broken", and — the part
 * that matters — the camera is never asked a second time. The operator's
 * report was *"ho provato a fare seek, non ha funzionato ed e' morto tutto"*;
 * the line underneath it was `SETUP of the video track answered 500`, seven
 * seconds after the previous stream had been cut.
 *
 * The catalog module is mocked because the ROW is all this path needs and
 * every other thing `listClips` touches is an ISAPI round trip.
 */
import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import type { HikvisionClipRow } from '../clip-catalog.js'
import type { HikvisionClipCamera } from '../clip-service.js'
import type {
  RtspReplayEnd,
  RtspReplayHandlers,
  RtspReplaySession,
} from '../rtsp/rtsp-replay-session.js'
import type { RtspVideoTrack } from '../rtsp/rtsp-sdp.js'

const ROW: HikvisionClipRow = {
  clipKey: 'b'.repeat(40),
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

interface Answered {
  status: number | null
  headers: Record<string, string>
}

/** Just enough of a `ServerResponse` for the route's sink and its refusal. */
function fakeResponse(): { res: ServerResponse; answered: Answered } {
  const answered: Answered = { status: null, headers: {} }
  const res = {
    headersSent: false,
    writeHead: (status: number, headers?: Record<string, string>) => {
      answered.status = status
      answered.headers = { ...answered.headers, ...headers }
      return res
    },
    write: () => true,
    once: () => res,
    end: () => res,
    destroy: () => res,
  }
  return { res: res as unknown as ServerResponse, answered }
}

function request(clipKey: string): IncomingMessage {
  return { method: 'GET', url: `/1436/${clipKey}.mp4`, headers: {} } as unknown as IncomingMessage
}

describe('the clip service’s replay lane', () => {
  it('refuses a second stream by name and 503, and never opens a second replay', async () => {
    let opens = 0
    let release: (end: RtspReplayEnd) => void = () => {}
    const held = new Promise<RtspReplayEnd>((resolve) => {
      release = resolve
    })
    const openReplay = async (
      _target: unknown,
      _handlers: RtspReplayHandlers,
    ): Promise<RtspReplaySession> => {
      opens += 1
      return { ended: held, video: VIDEO_TRACK, hasAudio: false, close: async () => {} }
    }
    // A documented test boundary: the ISAPI client is a class of two dozen
    // methods and the stream path reaches none of them — the row is already
    // mirrored by the time the route runs, and the catalog module is mocked.
    const client = {} as unknown as HikvisionClipCamera['client']
    const service: ClipService = createClipService({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      dataDir: await mkdtemp(join(tmpdir(), 'hik-lane-')),
      logger,
      resolveCamera: async () => ({
        deviceId: 1436,
        host: '203.0.113.1',
        username: 'u',
        password: 'p',
        client,
      }),
      // Short, so the test proves the REFUSAL and not the timer.
      replayWaitMs: 20,
      openReplay,
      spawnMux: () => {
        throw new Error('no unit ever completes the probe, so no mux is spawned')
      },
    })
    // The route resolves its row from what the provider listed, exactly as it
    // does in production.
    await service.provider.listClips?.({
      deviceId: 1436,
      since: ROW.startMs - 1,
      until: ROW.endMs + 1,
      provider: 'provider-hikvision',
    })

    const firstRes = fakeResponse()
    const first = service.streamHandler(request(ROW.clipKey), firstRes.res)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const secondRes = fakeResponse()
    await service.streamHandler(request(ROW.clipKey), secondRes.res)

    // 503 — the slot is held and will not be held long. 502 would blame the
    // camera and 404 would deny the clip; neither is true.
    expect(secondRes.answered.status).toBe(503)
    expect(secondRes.answered.headers['x-camstack-reason-code']).toBe('replay-busy')
    expect(secondRes.answered.headers['x-camstack-reason']).toContain('one playback session')
    // The camera was asked ONCE. That is the whole claim.
    expect(opens).toBe(1)

    release({ kind: 'complete', deliveredMs: null })
    await first
  })
})
