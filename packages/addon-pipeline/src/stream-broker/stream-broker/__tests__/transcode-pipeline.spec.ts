/**
 * `getStreamWithCodec` acquire — profile-driven source + copy-passthrough +
 * transcode egress refcounting.
 *
 * The transcode pipeline must:
 *   1. Resolve the source profile-driven only (no resolution heuristic):
 *      with `profile` → the profile's assigned camStreamId; without
 *      `profile` → the first published stream.
 *   2. Passthrough (no ffmpeg, `-c copy`) when `video:'copy'`, OR when the
 *      source codec already matches the requested codec AND `audio:'copy'`
 *      AND no `outputArgs`. Passthrough returns the broker restream URL with
 *      `transcoded:false, encoder:'copy', audioCodec:'passthrough'`.
 *   3. Otherwise transcode via a refcounted `TranscodeEgress`; `outputArgs`
 *      and `targetResolution` fold into the pipeline key.
 *   4. Always resolve the source URL to the broker restream URL — no raw
 *      camera-URL fallback (throw when the restream entry is absent).
 *
 * ffmpeg argument construction is covered by `ffmpeg-invocation.spec.ts`; the
 * egress wiring by `transcode-egress.spec.ts`. Here we inject egress fakes and
 * assert the manager's source-selection / refcount / teardown behaviour.
 */
import type { CameraStream, CamProfile, IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSpawnFn } from '../../../__tests__/support/spawn-fake-child.js'
import { restreamEntry } from '../../../__tests__/support/rtsp-restream-entry.js'
import type { FfmpegHwAccelSetting, FfmpegSystemConfig } from '../ffmpeg-invocation.js'
import type { EgressChannel, RtspRestreamerLike } from '../transcode-egress.js'
import { TranscodePipelineManager } from '../transcode-pipeline.js'
import { FfmpegReresolver } from '../ffmpeg-reresolve.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class FakeRestreamer implements RtspRestreamerLike {
  pushPacket(): void {}
}

interface MakeManagerOptions {
  readonly streams: readonly CameraStream[]
  readonly profileSource?: (deviceId: number, profile: CamProfile) => string | null
  readonly restream?: (brokerId: string) => { url: string; mutedUrl: string } | null
  readonly ffmpegConfig?: FfmpegSystemConfig
  /** Leave the manager on its OWN default config — no pinned binary at all. */
  readonly noBinary?: boolean
  /** A LIVE config accessor, for a spec whose binary changes mid-run. */
  readonly ffmpegConfigFn?: () => FfmpegSystemConfig
  readonly onFfmpegMissing?: () => void
  readonly logger?: IScopedLogger
  readonly streamHwAccel?: (deviceId: number, camStreamId: string) => FfmpegHwAccelSetting | null
}

const RESTREAM_PORT = 8554

/** What the addon hands over once `ensureFfmpeg` resolved: the pinned binary,
 *  software (`copy`) decode, auto threads. */
const PINNED_COPY_CONFIG: FfmpegSystemConfig = {
  binaryPath: '/deps/ffmpeg-pinned',
  hwAccel: 'copy',
  threadCount: 0,
}

interface EgressTrace {
  spawnArgs: string[][]
  /** The binary each child was spawned with, when a spec records it. */
  spawnCommands?: string[]
  registered: string[]
  unregistered: string[]
}

let trace: EgressTrace

function makeManager(opts: MakeManagerOptions): TranscodePipelineManager {
  const spawnFn = makeSpawnFn(trace)

  return new TranscodePipelineManager({
    logger: opts.logger ?? makeLogger(),
    cameraStreamLookup: () => opts.streams,
    rtspEntryLookup: opts.restream ?? (() => null),
    resolveProfileSource: opts.profileSource ?? (() => null),
    // The addon always hands over a resolved pinned binary; `noBinary` leaves
    // the manager on its own default, which has none.
    ...(opts.noBinary === true
      ? {}
      : { ffmpegConfig: opts.ffmpegConfigFn ?? (() => opts.ffmpegConfig ?? PINNED_COPY_CONFIG) }),
    ...(opts.onFfmpegMissing ? { onFfmpegMissing: opts.onFfmpegMissing } : {}),
    ...(opts.streamHwAccel ? { resolveStreamHwAccel: opts.streamHwAccel } : {}),
    spawnFn,
    releaseGraceMs: 0,
    acquireChannel: (brokerId): EgressChannel => {
      trace.registered.push(brokerId)
      const token = `tok-${trace.registered.length}`
      return {
        restreamer: new FakeRestreamer(),
        consumerUrl: `rtsp://127.0.0.1:${RESTREAM_PORT}/${token}`,
        release: () => {
          trace.unregistered.push(brokerId)
        },
      }
    },
  })
}

function streamFixture(over: Partial<CameraStream> & { camStreamId: string }): CameraStream {
  return {
    deviceId: 1,
    kind: 'pull-rtsp',
    url: `rtsp://camera.local/${over.camStreamId}`,
    codec: 'h264',
    resolution: { width: 1920, height: 1080 },
    ...over,
  }
}

describe('TranscodePipelineManager — profile-driven acquire + copy-passthrough', () => {
  beforeEach(() => {
    trace = { spawnArgs: [], registered: [], unregistered: [] }
  })

  it('video:copy → passthrough via broker restream, no ffmpeg', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H265' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'copy', audio: 'copy', profile: 'high' })
    expect(src.transcoded).toBe(false)
    expect(src.encoder).toBe('copy')
    expect(src.url).toBe('rtsp://127.0.0.1:8554/main')
    expect(trace.spawnArgs.length).toBe(0)
  })

  it('video:h264 with H.264 source → passthrough (codec already matches)', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H264' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'copy', profile: 'high' })
    expect(src.transcoded).toBe(false)
    expect(trace.spawnArgs.length).toBe(0)
  })

  it('video:h264 with H.265 source → transcode (one ffmpeg child, stdout sink, token URL)', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H265' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    expect(src.transcoded).toBe(true)
    expect(src.videoCodec).toBe('H264')
    expect(trace.spawnArgs.length).toBe(1)
    expect(src.url).toBe('rtsp://127.0.0.1:8554/tok-1')
    expect(trace.registered.length).toBe(1)
    const tArgs = trace.spawnArgs[0]!
    const inputIdx = tArgs.indexOf('-i')
    expect(tArgs[inputIdx + 1]).toBe('rtsp://127.0.0.1:8554/main')
    // egress writes to stdout (not an RTSP listen URL).
    expect(tArgs.join(' ')).toContain('-f h264')
    expect(tArgs[tArgs.length - 1]).toBe('pipe:1')
  })

  it('outputArgs change the pipeline key → distinct ffmpeg children', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H265' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    await mgr.acquire({
      deviceId: 1,
      video: 'h264',
      audio: 'aac',
      profile: 'high',
      outputArgs: ['-x264-params', 'keyint=30'],
    })
    expect(trace.spawnArgs.length).toBe(2)
  })

  it('same key shares one egress (refcount), no second ffmpeg', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H265' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const a = await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    const b = await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    expect(trace.spawnArgs.length).toBe(1)
    expect(a.pipelineKey).toBe(b.pipelineKey)
    const r = mgr.release(a.pipelineKey)
    expect(r.refcount).toBe(1)
  })

  it('concurrent acquire for the same key single-flights one egress', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H265' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const [a, b] = await Promise.all([
      mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' }),
      mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' }),
    ])
    expect(trace.spawnArgs.length).toBe(1)
    expect(trace.registered.length).toBe(1)
    expect(a.url).toBe(b.url)
  })

  it('release after last consumer stops the egress (releases channel)', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H265' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    mgr.release(src.pipelineKey)
    await new Promise((r) => setTimeout(r, 5))
    expect(trace.unregistered.length).toBe(1)
  })

  it('missing profile assignment throws', async () => {
    const mgr = makeManager({ streams: [], profileSource: () => null })
    await expect(mgr.acquire({ deviceId: 1, video: 'h264', profile: 'high' })).rejects.toThrow(
      /no assigned source/,
    )
  })

  it('profile assigned to a derived stream (no camera url) uses the broker restream', async () => {
    // Live 618: `derived:*` is published as broker-owned metadata with no pull
    // `url`. Recording/WebRTC ask for the PROFILE (`low`); the pipeline must
    // return the derived broker restream, not throw "not published".
    const mgr = makeManager({
      streams: [
        {
          deviceId: 1,
          camStreamId: 'derived:Mid to low',
          kind: 'derived',
          codec: 'h264',
          resolution: { width: 640, height: 360 },
        },
      ],
      profileSource: () => 'derived:Mid to low',
      restream: (brokerId) =>
        brokerId === '1/derived:Mid to low'
          ? {
              url: 'rtsp://127.0.0.1:8554/derived',
              mutedUrl: 'rtsp://127.0.0.1:8554/derived/muted',
            }
          : null,
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'copy', audio: 'aac', profile: 'low' })
    expect(src.transcoded).toBe(false)
    expect(src.encoder).toBe('copy')
    expect(src.url).toBe('rtsp://127.0.0.1:8554/derived')
    expect(trace.spawnArgs.length).toBe(0)
  })

  it('assigned derived without a broker restream throws "not dialed", not "not published"', async () => {
    const mgr = makeManager({
      streams: [
        {
          deviceId: 1,
          camStreamId: 'derived:Mid to low',
          kind: 'derived',
          codec: 'h264',
        },
      ],
      profileSource: () => 'derived:Mid to low',
      restream: () => null,
    })
    await expect(
      mgr.acquire({ deviceId: 1, video: 'copy', audio: 'aac', profile: 'low' }),
    ).rejects.toThrow(/no broker restream/)
  })

  it('transcode with no broker restream throws (no raw-url fallback)', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H265' })],
      profileSource: () => 'native:main',
      restream: () => null,
    })
    await expect(
      mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' }),
    ).rejects.toThrow(/no broker restream/)
  })

  it('no profile → uses first published stream (passthrough)', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H264' })],
      profileSource: () => null,
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'copy', audio: 'copy' })
    expect(src.url).toBe('rtsp://127.0.0.1:8554/main')
    expect(trace.spawnArgs.length).toBe(0)
  })

  it('no profile + no published streams → throws no published stream', async () => {
    const mgr = makeManager({ streams: [], profileSource: () => null })
    await expect(mgr.acquire({ deviceId: 1, video: 'h264' })).rejects.toThrow(/no published stream/)
  })

  it('targetResolution drives the output scale filter', async () => {
    const mgr = makeManager({
      streams: [
        streamFixture({
          camStreamId: 'native:main',
          codec: 'H265',
          resolution: { width: 3840, height: 2160 },
        }),
      ],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({
      deviceId: 1,
      video: 'h264',
      audio: 'aac',
      profile: 'high',
      targetResolution: { width: 1280, height: 720 },
    })
    expect(src.transcoded).toBe(true)
    expect(src.resolution).toEqual({ width: 1280, height: 720 })
    expect(trace.spawnArgs[0]!.join(' ')).toContain('-vf scale=1280:720')
  })

  it('consumer -vf in outputArgs wins over the scale (no duplicate -vf)', async () => {
    const mgr = makeManager({
      streams: [
        streamFixture({
          camStreamId: 'native:main',
          codec: 'H265',
          resolution: { width: 3840, height: 2160 },
        }),
      ],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    await mgr.acquire({
      deviceId: 1,
      video: 'h264',
      audio: 'aac',
      profile: 'high',
      targetResolution: { width: 1280, height: 720 },
      outputArgs: ['-vf', 'crop=100:100:0:0'],
    })
    const vfCount = trace.spawnArgs[0]!.filter((a) => a === '-vf').length
    expect(vfCount).toBe(1)
    expect(trace.spawnArgs[0]!.join(' ')).toContain('-vf crop=100:100:0:0')
    expect(trace.spawnArgs[0]!.join(' ')).not.toContain('scale=1280:720')
  })

  it('no targetResolution + transcode → no -vf scale (native resolution)', async () => {
    const mgr = makeManager({
      streams: [
        streamFixture({
          camStreamId: 'native:main',
          codec: 'H265',
          resolution: { width: 1920, height: 1080 },
        }),
      ],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    expect(trace.spawnArgs[0]!.includes('-vf')).toBe(false)
    expect(src.resolution).toEqual({ width: 1920, height: 1080 })
  })

  it('no profile + targetResolution → picks the closest source by area', async () => {
    const mgr = makeManager({
      streams: [
        streamFixture({
          camStreamId: 'native:main',
          codec: 'H264',
          resolution: { width: 3840, height: 2160 },
        }),
        streamFixture({
          camStreamId: 'native:sub',
          codec: 'H264',
          resolution: { width: 1280, height: 720 },
        }),
      ],
      profileSource: () => null,
      restream: () => restreamEntry('rtsp://127.0.0.1:8554/x'),
    })
    const src = await mgr.acquire({
      deviceId: 1,
      video: 'h264',
      audio: 'copy',
      targetResolution: { width: 1280, height: 720 },
    })
    expect(src.transcoded).toBe(false)
    expect(src.pipelineKey).toContain('src=native:sub')
  })

  it('targetResolution differs from source → forces transcode even when codec matches', async () => {
    const mgr = makeManager({
      streams: [
        streamFixture({
          camStreamId: 'native:main',
          codec: 'H264',
          resolution: { width: 1920, height: 1080 },
        }),
      ],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({
      deviceId: 1,
      video: 'h264',
      audio: 'copy',
      profile: 'high',
      targetResolution: { width: 640, height: 360 },
    })
    expect(src.transcoded).toBe(true)
    expect(trace.spawnArgs[0]!.join(' ')).toContain('-vf scale=640:360')
  })

  it('targetResolution changes the pipeline key → distinct children', async () => {
    const mgr = makeManager({
      streams: [
        streamFixture({
          camStreamId: 'native:main',
          codec: 'H265',
          resolution: { width: 3840, height: 2160 },
        }),
      ],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    await mgr.acquire({
      deviceId: 1,
      video: 'h264',
      audio: 'aac',
      profile: 'high',
      targetResolution: { width: 1280, height: 720 },
    })
    await mgr.acquire({
      deviceId: 1,
      video: 'h264',
      audio: 'aac',
      profile: 'high',
      targetResolution: { width: 640, height: 360 },
    })
    expect(trace.spawnArgs.length).toBe(2)
  })
})

describe('TranscodePipelineManager — decode hwaccel resolution', () => {
  beforeEach(() => {
    trace = { spawnArgs: [], registered: [], unregistered: [] }
  })

  function transcodeStreams() {
    return [streamFixture({ camStreamId: 'native:main', codec: 'H265' })]
  }
  const profileSource = () => 'native:main'
  const restream = () => restreamEntry('rtsp://127.0.0.1:8554/main')

  it('REFUSES a transcode, per camera, when no pinned ffmpeg was handed over — never PATH (D540)', async () => {
    const errors: Array<{ message: string; deviceId: unknown }> = []
    const logger: IScopedLogger = {
      ...makeLogger(),
      error: (message, extras) => {
        errors.push({ message, deviceId: extras?.tags?.['deviceId'] })
      },
    }
    const mgr = makeManager({
      streams: transcodeStreams(),
      profileSource,
      restream,
      noBinary: true,
      logger,
    })
    await expect(
      mgr.acquire({ deviceId: 7, video: 'h264', audio: 'aac', profile: 'high' }),
    ).rejects.toThrow('no pinned ffmpeg')
    expect(trace.spawnArgs).toHaveLength(0)
    expect(errors).toEqual([
      { message: 'transcode egress refused — no pinned ffmpeg on this node (D540)', deviceId: 7 },
    ])
  })

  it('RECOVERS without a restart: a failed resolution is asked again, and the next acquire spawns the pinned binary', async () => {
    trace.spawnCommands = []
    // The addon's shape: a live config, a re-resolver that sets it, and the
    // manager told about each refusal. The first resolution FAILS (a download
    // that was down at boot); the retry succeeds.
    let config: FfmpegSystemConfig = { binaryPath: null, hwAccel: 'copy', threadCount: 0 }
    let resolveCalls = 0
    const reresolver = new FfmpegReresolver({
      resolve: async () => {
        resolveCalls += 1
        if (resolveCalls === 1) throw new Error('download failed')
        return '/deps/ffmpeg-pinned'
      },
      apply: (binaryPath) => {
        config = { ...config, binaryPath }
      },
      logger: makeLogger(),
      minIntervalMs: 0,
    })
    const mgr = makeManager({
      streams: transcodeStreams(),
      profileSource,
      restream,
      ffmpegConfigFn: () => config,
      onFfmpegMissing: () => {
        reresolver.request('refused')
      },
    })
    const ask = { deviceId: 7, video: 'h264', audio: 'aac', profile: 'high' } as const
    // 1st refusal → re-resolve #1 fails; 2nd refusal → re-resolve #2 succeeds.
    await expect(mgr.acquire(ask)).rejects.toThrow('no pinned ffmpeg')
    await reresolver.settled()
    await expect(mgr.acquire(ask)).rejects.toThrow('no pinned ffmpeg')
    await reresolver.settled()
    expect(config.binaryPath).toBe('/deps/ffmpeg-pinned')
    // Same manager, no restart: the next acquire spawns the PINNED path.
    await mgr.acquire(ask)
    expect(trace.spawnCommands).toEqual(['/deps/ffmpeg-pinned'])
  })

  it('default (no per-stream, pinned config with copy) → software decode, no -hwaccel', async () => {
    const mgr = makeManager({ streams: transcodeStreams(), profileSource, restream })
    await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    expect(trace.spawnArgs[0]!.includes('-hwaccel')).toBe(false)
    // software default also forces the software encoder
    expect(trace.spawnArgs[0]!.join(' ')).toContain('-c:v libx264')
  })

  it("global ffmpeg.hwAccel 'auto' → literal -hwaccel auto (no forced-backend collapse)", async () => {
    const mgr = makeManager({
      streams: transcodeStreams(),
      profileSource,
      restream,
      ffmpegConfig: { binaryPath: 'ffmpeg', hwAccel: 'auto', threadCount: 0 },
    })
    await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    const args = trace.spawnArgs[0]!
    const hwIdx = args.indexOf('-hwaccel')
    expect(hwIdx).toBeGreaterThan(-1)
    expect(args[hwIdx + 1]).toBe('auto')
  })

  it('per-stream override wins over the global config (copy override beats auto global → software)', async () => {
    const mgr = makeManager({
      streams: transcodeStreams(),
      profileSource,
      restream,
      ffmpegConfig: { binaryPath: 'ffmpeg', hwAccel: 'auto', threadCount: 0 },
      streamHwAccel: (_d, camStreamId) => (camStreamId === 'native:main' ? 'copy' : null),
    })
    await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    expect(trace.spawnArgs[0]!.includes('-hwaccel')).toBe(false)
    expect(trace.spawnArgs[0]!.join(' ')).toContain('-c:v libx264')
  })

  it('per-stream auto override beats a software global → literal -hwaccel auto', async () => {
    const mgr = makeManager({
      streams: transcodeStreams(),
      profileSource,
      restream,
      ffmpegConfig: { binaryPath: 'ffmpeg', hwAccel: 'copy', threadCount: 0 },
      streamHwAccel: () => 'auto',
    })
    await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    const args = trace.spawnArgs[0]!
    const hwIdx = args.indexOf('-hwaccel')
    expect(hwIdx).toBeGreaterThan(-1)
    expect(args[hwIdx + 1]).toBe('auto')
  })

  it('no per-stream override → falls back to the global config', async () => {
    const mgr = makeManager({
      streams: transcodeStreams(),
      profileSource,
      restream,
      ffmpegConfig: { binaryPath: 'ffmpeg', hwAccel: 'auto', threadCount: 0 },
      streamHwAccel: () => null,
    })
    await mgr.acquire({ deviceId: 1, video: 'h264', audio: 'aac', profile: 'high' })
    const args = trace.spawnArgs[0]!
    expect(args[args.indexOf('-hwaccel') + 1]).toBe('auto')
  })
})

/**
 * `audio: 'none'` is not decoration — the ONE consumer that asks for it is the
 * per-session decode worker, and the restreamer keys its whole live-edge
 * protection off `RtspSession.isMuted()`, which is derived from the `/muted`
 * path suffix and nothing else.
 *
 * Handing that consumer the NON-muted URL therefore did two things silently:
 * it declared an audio track the video-only decoder never asked for, and — the
 * expensive one — it made `servePendingSessionsRtp` treat the decode session as
 * a viewer, so it was served the catch-up GOP burst that
 * `LIVE_EDGE_MAX_SPAN_MS` (500 ms) exists to withhold from a local decoder,
 * "which makes libav base its pts in the past and never drain that backlog".
 * The protection written FOR this population had never once applied to it.
 *
 * Observed on device 107 (hub log, 2026-08-08T22:40:52.928Z): the decode worker
 * connects, `restream prime (lat-probe) clients:1 packets:768 spanMs:840
 * withheld:0` serves it an 840 ms-old burst as a non-muted client, and the
 * coordinator reports no frame within 20 000 ms.
 */
describe('TranscodePipelineManager — audio:none gets the video-only (muted) restream', () => {
  beforeEach(() => {
    trace = { spawnArgs: [], registered: [], unregistered: [] }
  })

  it('video:copy + audio:none → the muted restream URL', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H264' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const src = await mgr.acquire({ deviceId: 1, video: 'copy', audio: 'none', profile: 'high' })
    expect(src.transcoded).toBe(false)
    expect(src.url).toBe('rtsp://127.0.0.1:8554/main/muted')
    expect(trace.spawnArgs.length).toBe(0)
  })

  it('video:copy + audio:copy still gets the full restream — the two never share an entry', async () => {
    const mgr = makeManager({
      streams: [streamFixture({ camStreamId: 'native:main', codec: 'H264' })],
      profileSource: () => 'native:main',
      restream: () => ({
        url: 'rtsp://127.0.0.1:8554/main',
        mutedUrl: 'rtsp://127.0.0.1:8554/main/muted',
      }),
    })
    const muted = await mgr.acquire({ deviceId: 1, video: 'copy', audio: 'none', profile: 'high' })
    const full = await mgr.acquire({ deviceId: 1, video: 'copy', audio: 'copy', profile: 'high' })
    expect(muted.url).toBe('rtsp://127.0.0.1:8554/main/muted')
    expect(full.url).toBe('rtsp://127.0.0.1:8554/main')
    // Distinct refcounted entries — `pipelineKeyFor` already keys on audio.
    expect(muted.pipelineKey).not.toBe(full.pipelineKey)
  })
})
