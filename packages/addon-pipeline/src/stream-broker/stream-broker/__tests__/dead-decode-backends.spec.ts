/**
 * "vaapi is dead in this process" has to OUTLIVE the memo that answers "what
 * should decode this".
 *
 * The two were the same object, and the memo is a read-cadence cache: it exists
 * so a per-session resolve is not a per-session `decoder.getInfo`, so it expires
 * after 60 s. One minute after a failure the decoder answers `vaapi` again and
 * the next cold child pays another ~3 s death before its own software retry.
 *
 * Measured on camera 101 on 2026-08-07, in one process (pid 342 then 3452), on a
 * hub where this backend has never once produced a packet from the broker
 * runner: 22:17:07, 22:18:42, 22:28:48, 22:30:52, 22:32:39, 22:34:07, 22:52:07.
 * One per memo window. The client's watchdog is 5 s and the death is ~3 s of it.
 *
 * The gate below is the discriminating one: a SECOND cold child, spawned after
 * the old memo would have expired, must not carry `-hwaccel`.
 */
import type {
  CameraStream,
  EgressTranscodeRequest,
  EncodedPacket,
  IScopedLogger,
  PushAudioInfo,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  createDeadDecodeBackends,
  DEAD_BACKEND_QUARANTINE_MS,
  resolveWithQuarantine,
} from '../dead-decode-backends.js'
import {
  EgressTranscodeManager,
  type EgressPushSink,
  type PushReaderCallbacks,
} from '../egress-transcode-manager.js'

function logger(): IScopedLogger {
  const log: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  } as unknown as IScopedLogger
  return log
}

const STREAM: CameraStream = {
  camStreamId: 'native:main',
  deviceId: 101,
  kind: 'rtsp',
  url: 'rtsp://cam/main',
  codec: 'h264',
  resolution: { width: 2560, height: 1440 },
} as unknown as CameraStream

const PACKET: EncodedPacket = {
  type: 'video',
  codec: 'h264',
  data: Buffer.from([0, 0, 0, 1, 0x65]),
  keyframe: true,
  pts: 0,
  dts: 0,
} as unknown as EncodedPacket

function request(): EgressTranscodeRequest {
  return {
    deviceId: 101,
    source: { kind: 'profile', profile: 'high' },
    encode: { video: { codec: 'h264', width: 1280, height: 720 }, audio: 'passthrough' },
    publishLocally: true,
  }
}

interface FakeReader {
  args: readonly string[]
  callbacks: PushReaderCallbacks
  destroyed: boolean
  connect(): void
  destroy(): void
}

/**
 * The PRODUCTION composition, assembled the way `StreamBrokerManager` assembles
 * it: a decoder that keeps answering `vaapi` (it is the node's best backend and
 * the decoder addon is right about that — it decodes ten 4K streams in its OWN
 * process), the quarantine on top, and the manager's failure report wired back
 * into it. A fake that stopped answering `vaapi` would be testing nothing.
 */
function harness(): {
  manager: EgressTranscodeManager
  readers: FakeReader[]
  decoderAnswers: number
  advance(ms: number): void
} {
  const readers: FakeReader[] = []
  const clock = { t: 1_000_000 }
  const dead = createDeadDecodeBackends({ now: () => clock.t })
  const state = { decoderAnswers: 0 }
  const sink: EgressPushSink = {
    push: () => {},
    audioInfo: (_info: PushAudioInfo) => {},
    videoCodec: () => {},
    release: async () => {},
  }
  const manager = new EgressTranscodeManager({
    logger: logger(),
    cameraStreamLookup: () => [STREAM],
    resolveProfileSource: () => 'native:main',
    rtspEntryLookup: (brokerId) => ({ url: `rtsp://127.0.0.1:8554/tok-${brokerId}` }),
    ffmpegConfig: () => ({ binaryPath: 'ffmpeg', hwAccel: 'copy', threadCount: 0 }),
    resolveDecodeHwAccel: async (_deviceId, override) =>
      (
        await resolveWithQuarantine({
          resolve: async () => {
            state.decoderAnswers += 1
            return override ?? 'vaapi'
          },
          dead,
        })
      ).backend,
    onDecodeHwAccelFailed: (backend) => {
      dead.markDead(backend)
    },
    acquireChannel: (brokerId) => ({
      restreamer: { pushPacket: () => {} },
      consumerUrl: `rtsp://127.0.0.1:8554/egress-${brokerId}`,
      release: () => {},
    }),
    releaseGraceMs: 0,
    publishPushStream: async () => sink,
    pushFirstPacketTimeoutMs: 50,
    createPushReader: (input) => {
      const reader: FakeReader = {
        args: input.args,
        callbacks: input.callbacks,
        destroyed: false,
        connect: () => {},
        destroy: () => {
          reader.destroyed = true
        },
      }
      readers.push(reader)
      return reader
    },
  })
  return {
    manager,
    readers,
    get decoderAnswers() {
      return state.decoderAnswers
    },
    advance: (ms) => {
      clock.t += ms
    },
  }
}

/** Drive one cold acquire to a live child, failing hardware if it is offered. */
async function coldAcquire(h: ReturnType<typeof harness>): Promise<readonly string[][]> {
  const before = h.readers.length
  const acquire = h.manager.acquire(request())
  await vi.waitFor(() => expect(h.readers.length).toBeGreaterThan(before))
  const first = h.readers[before]!
  if (first.args.includes('-hwaccel')) {
    first.callbacks.onError?.(
      new Error('egress push exited (code=244): Device creation failed: -12'),
    )
    await vi.waitFor(() => expect(h.readers.length).toBeGreaterThan(before + 1))
  }
  h.readers[h.readers.length - 1]!.callbacks.onEncodedPacket(PACKET)
  const handle = await acquire
  await h.manager.release({ pipelineKey: handle.pipelineKey })
  // The release grace is 0 here but still a timer, so the entry leaves the map
  // one tick later. Without this wait the "second" acquire SHARES the first
  // child and the gate below passes without ever spawning anything.
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  return h.readers.slice(before).map((r) => [...r.args])
}

describe('a decode backend that died in this process stays dead', () => {
  it('does NOT offer hardware to the second cold child — even past the 60s memo', async () => {
    const h = harness()

    const firstSpawns = await coldAcquire(h)
    // The first child pays the death exactly once: hardware, then software.
    expect(firstSpawns).toHaveLength(2)
    expect(firstSpawns[0]).toContain('-hwaccel')
    expect(firstSpawns[1]).not.toContain('-hwaccel')

    // Past the window the read-cadence memo answered for. The decoder still
    // says `vaapi` — it is right about the node and wrong about this process.
    h.advance(90_000)

    const secondSpawns = await coldAcquire(h)
    expect(secondSpawns).toHaveLength(1)
    expect(secondSpawns[0]).not.toContain('-hwaccel')
  })

  it('re-probes once the quarantine elapses, so a recovered accelerator is found', async () => {
    // The failure observed is ENOMEM on device creation — a RESOURCE
    // condition, which can clear. A verdict that never re-probed would leave a
    // healthy accelerator unused for the life of the runner with nothing said.
    const h = harness()
    await coldAcquire(h)
    h.advance(DEAD_BACKEND_QUARANTINE_MS[0]! + 1)

    const spawns = await coldAcquire(h)
    expect(spawns[0]).toContain('-hwaccel')
  })
})

describe('createDeadDecodeBackends', () => {
  it('widens the quarantine on every consecutive failure', () => {
    const clock = { t: 0 }
    const dead = createDeadDecodeBackends({ now: () => clock.t })

    for (const [index, expected] of DEAD_BACKEND_QUARANTINE_MS.entries()) {
      const verdict = dead.markDead('vaapi')
      expect(verdict.failures, `failure ${index + 1}`).toBe(index + 1)
      expect(verdict.quarantineMs, `failure ${index + 1}`).toBe(expected)
    }
    // Past the table it stays at the widest rung rather than growing without
    // bound or wrapping to `undefined`.
    expect(dead.markDead('vaapi').quarantineMs).toBe(DEAD_BACKEND_QUARANTINE_MS.at(-1))
  })

  it('quarantines only the backend that failed', () => {
    const dead = createDeadDecodeBackends()
    dead.markDead('vaapi')
    expect(dead.isQuarantined('vaapi')).toBe(true)
    // An operator switching the decoder to qsv is obeyed at once: the record is
    // keyed by backend, so a different one carries no history.
    expect(dead.isQuarantined('qsv')).toBe(false)
  })

  it('restarts the escalation when the backend runs again', () => {
    const clock = { t: 0 }
    const dead = createDeadDecodeBackends({ now: () => clock.t })
    dead.markDead('vaapi')
    dead.markDead('vaapi')
    dead.markAlive('vaapi')

    expect(dead.isQuarantined('vaapi')).toBe(false)
    expect(dead.markDead('vaapi').quarantineMs).toBe(DEAD_BACKEND_QUARANTINE_MS[0])
  })

  it('reports what it overruled, so the fallback is never silent', async () => {
    const dead = createDeadDecodeBackends()
    dead.markDead('vaapi')

    const overruled = await resolveWithQuarantine({ resolve: async () => 'vaapi', dead })
    expect(overruled.backend).toBeNull()
    expect(overruled.veto).toEqual({
      backend: 'vaapi',
      failures: 1,
      remainingMs: expect.any(Number),
    })

    const clean = await resolveWithQuarantine({ resolve: async () => 'qsv', dead })
    expect(clean).toEqual({ backend: 'qsv', veto: null })
  })
})
