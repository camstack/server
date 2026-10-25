/**
 * TranscodeEgress — ffmpeg stdout (Annex-B) → restreamer.pushPacket.
 *
 * ffmpeg writes the transcoded elementary stream to stdout; the egress pushes
 * each chunk into a restreamer registered under a consumer token. `start()`
 * resolves on the first output byte and returns the shareable broker token URL;
 * `stop()` kills ffmpeg and releases the channel. Decode hw-accel is tried
 * first and falls back to software if ffmpeg dies before producing output.
 *
 * All collaborators are injected, so this exercises the wiring without real
 * ffmpeg or sockets.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  FakeFfmpegChild,
  makeSpawnFn,
  type SpawnTrace,
} from '../../../__tests__/support/spawn-fake-child.js'
import type { IScopedLogger, EncodedPacket } from '@camstack/types'
import { brokerTranscodeInvocation } from '../ffmpeg-invocation.js'
import { TranscodeEgress } from '../transcode-egress.js'
import type { TranscodeEgressDeps, RtspRestreamerLike } from '../transcode-egress.js'

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
  packets: EncodedPacket[] = []
  audioRtp: Buffer[] = []
  audioBlock: string | null = null
  pushPacket(p: EncodedPacket): void {
    this.packets.push(p)
  }
  pushAudioRtpPassthrough(rtp: Buffer): void {
    this.audioRtp.push(rtp)
  }
  setEgressAudioBlock(block: string | null): void {
    this.audioBlock = block
  }
}

const FFMPEG_AUDIO_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=No Name',
  'c=IN IP4 127.0.0.1',
  't=0 0',
  'm=audio 41000 RTP/AVP 96',
  'a=rtpmap:96 MPEG4-GENERIC/48000/2',
  'a=fmtp:96 mode=AAC-hbr;config=1190',
  '',
].join('\n')

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('TranscodeEgress (stdout → pushPacket)', () => {
  const spawnTrace: SpawnTrace = { spawnArgs: [] }
  let children: FakeFfmpegChild[] = []
  let restreamers: FakeRestreamer[] = []
  let acquired: string[] = []
  let released = 0

  const spawnFn = makeSpawnFn(spawnTrace, () => {
    const c = new FakeFfmpegChild()
    children.push(c)
    return c
  })

  function makeDeps(over: Partial<TranscodeEgressDeps> = {}): TranscodeEgressDeps {
    return {
      logger: makeLogger(),
      ffmpegBinaryPath: '/usr/bin/ffmpeg',
      spawnFn,
      acquireChannel: (brokerId) => {
        acquired.push(brokerId)
        const restreamer = new FakeRestreamer()
        restreamers.push(restreamer)
        return {
          restreamer,
          consumerUrl: `rtsp://127.0.0.1:8554/tok-${brokerId}`,
          release: () => {
            released++
          },
        }
      },
      firstDataTimeoutMs: 50,
      ...over,
    }
  }

  beforeEach(() => {
    spawnTrace.spawnArgs.length = 0
    children = []
    restreamers = []
    acquired = []
    released = 0
  })

  function baseArgs() {
    return {
      brokerId: 'transcode:1:abcd',
      // `targetCodec` is now an egress-level field (it picks the elementary
      // container and the packet codec), while `invocation` is the shared
      // `FfmpegInvocation` the ONE builder consumes.
      targetCodec: 'H264' as const,
      invocation: brokerTranscodeInvocation({
        sourceUrl: 'rtsp://127.0.0.1:8554/main',
        targetCodec: 'H264',
        encoder: 'h264_videotoolbox',
        decodeHwAccel: 'videotoolbox',
        scale: null,
        audio: 'aac',
        threadCount: 0,
        outputArgs: [],
      }),
    }
  }

  it('spawns ffmpeg with a stdout sink and the configured binary', async () => {
    const eg = new TranscodeEgress(makeDeps(), baseArgs())
    const p = eg.start()
    children[0]!.stdout.emit('data', Buffer.from([1, 2, 3]))
    await p
    const joined = spawnTrace.spawnArgs[0]!.join(' ')
    expect(joined).toContain('-f h264')
    expect(spawnTrace.spawnArgs[0]![spawnTrace.spawnArgs[0]!.length - 1]).toBe('pipe:1')
    expect(joined).toContain('-hwaccel videotoolbox')
  })

  it('start() returns the consumer token URL and acquires a channel', async () => {
    const eg = new TranscodeEgress(makeDeps(), baseArgs())
    const p = eg.start()
    children[0]!.stdout.emit('data', Buffer.from([1]))
    const url = await p
    expect(url).toBe('rtsp://127.0.0.1:8554/tok-transcode:1:abcd')
    expect(acquired).toEqual(['transcode:1:abcd'])
  })

  it('pipes stdout chunks into restreamer.pushPacket as video packets', async () => {
    const eg = new TranscodeEgress(makeDeps(), baseArgs())
    const p = eg.start()
    children[0]!.stdout.emit('data', Buffer.from([1, 2]))
    await p
    children[0]!.stdout.emit('data', Buffer.from([3, 4, 5]))
    const r = restreamers[0]!
    expect(r.packets.length).toBe(2)
    expect(r.packets[0]!.type).toBe('video')
    expect(r.packets[0]!.codec).toBe('h264')
    expect(r.packets[1]!.data.length).toBe(3)
  })

  it('H265 target → -f hevc sink and h265 packet codec', async () => {
    const args = baseArgs()
    const eg = new TranscodeEgress(makeDeps(), {
      ...args,
      targetCodec: 'H265' as const,
      invocation: {
        ...args.invocation,
        video: { kind: 'encode' as const, encoder: 'hevc_videotoolbox' as const, scale: null },
      },
    })
    const p = eg.start()
    children[0]!.stdout.emit('data', Buffer.from([1]))
    await p
    expect(spawnTrace.spawnArgs[0]!.join(' ')).toContain('-f hevc')
    expect(restreamers[0]!.packets[0]!.codec).toBe('h265')
  })

  it('falls back to software decode when hw decode produces no output', async () => {
    const eg = new TranscodeEgress(makeDeps(), baseArgs())
    const p = eg.start()
    // First attempt (hwaccel) dies before any stdout data.
    children[0]!.emit('exit', 1, null)
    await tick()
    // Second attempt (software) produces output.
    children[1]!.stdout.emit('data', Buffer.from([1]))
    await p
    expect(spawnTrace.spawnArgs.length).toBe(2)
    expect(spawnTrace.spawnArgs[0]!.join(' ')).toContain('-hwaccel videotoolbox')
    expect(spawnTrace.spawnArgs[1]!.join(' ')).not.toContain('-hwaccel')
  })

  it('stop() kills ffmpeg and releases the channel', async () => {
    const eg = new TranscodeEgress(makeDeps(), baseArgs())
    const p = eg.start()
    children[0]!.stdout.emit('data', Buffer.from([1]))
    await p
    await eg.stop()
    expect(children[0]!.killed).toBe(true)
    expect(released).toBe(1)
  })

  it('rejects + releases when ffmpeg never outputs (no hw fallback path)', async () => {
    const args = baseArgs()
    const eg = new TranscodeEgress(makeDeps(), {
      ...args,
      invocation: { ...args.invocation, decodeHwAccel: null },
    })
    const p = eg.start()
    children[0]!.emit('exit', 1, null)
    await expect(p).rejects.toThrow(/exited before output/)
    expect(spawnTrace.spawnArgs.length).toBe(1) // no fallback (decode was already software)
    expect(released).toBe(1)
  })

  it('audio sidecar: maps audio to RTP, forwards datagrams, and grafts the SDP', async () => {
    let captured: ((rtp: Buffer) => void) | null = null
    let receiverStopped = false
    const deps = makeDeps({
      audioReceiverFactory: () => ({
        start: async (onPacket: (rtp: Buffer) => void) => {
          captured = onPacket
          return { rtpUrl: 'rtp://127.0.0.1:41000' }
        },
        stop: () => {
          receiverStopped = true
        },
      }),
      makeSdpFilePath: () => '/tmp/egress-test.sdp',
      readSdpFile: async () => FFMPEG_AUDIO_SDP,
    })
    const eg = new TranscodeEgress(deps, { ...baseArgs(), audio: { codec: 'aac' } })
    const p = eg.start()
    while (children.length === 0) await tick() // async audio bind defers the spawn
    children[0]!.stdout.emit('data', Buffer.from([1]))
    await p
    await tick()

    const joined = spawnTrace.spawnArgs[0]!.join(' ')
    expect(joined).toContain('-map 0:a:0?')
    // `-sdp_file` now precedes `-f rtp` (it is a global option; the format
    // flag belongs immediately before the output url). Same ffmpeg semantics.
    expect(joined).toContain('-sdp_file /tmp/egress-test.sdp -f rtp rtp://127.0.0.1:41000')
    // The sidecar takes the shared audio PRESET, not a bare `-c:a`.
    expect(joined).toContain('-c:a aac -ar 48000 -b:a 128k -ac 1')

    // forwarded audio RTP datagram
    expect(captured).not.toBeNull()
    captured!(Buffer.from([9, 9, 9]))
    expect(restreamers[0]!.audioRtp.length).toBe(1)

    // grafted audio SDP (PT remapped 96→97, trackID=1)
    expect(restreamers[0]!.audioBlock).not.toBeNull()
    expect(restreamers[0]!.audioBlock).toContain('m=audio 0 RTP/AVP 97')
    expect(restreamers[0]!.audioBlock).toContain('a=control:trackID=1')

    await eg.stop()
    expect(receiverStopped).toBe(true)
  })

  it('no audio sidecar by default (video-only egress args unchanged)', async () => {
    const eg = new TranscodeEgress(makeDeps(), baseArgs())
    const p = eg.start()
    children[0]!.stdout.emit('data', Buffer.from([1]))
    await p
    expect(spawnTrace.spawnArgs[0]!.join(' ')).not.toContain('-f rtp')
    expect(restreamers[0]!.audioBlock).toBeNull()
  })

  it('uses the configured ffmpeg binary path', async () => {
    const cmds: string[] = []
    const eg = new TranscodeEgress(
      makeDeps({
        ffmpegBinaryPath: '/opt/custom/ffmpeg',
        spawnFn: makeSpawnFn({ spawnArgs: [], spawnCommands: cmds }, () => {
          const c = new FakeFfmpegChild(false)
          children.push(c)
          return c
        }),
      }),
      baseArgs(),
    )
    const p = eg.start()
    children[0]!.stdout.emit('data', Buffer.from([1]))
    await p
    expect(cmds[0]).toBe('/opt/custom/ffmpeg')
  })
})
