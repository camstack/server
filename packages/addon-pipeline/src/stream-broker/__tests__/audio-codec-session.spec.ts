import type { DecodedAudioChunk } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AudioCodecSession,
  type AudioCodecSessionConfig,
} from '../stream-broker/audio-codec-session.js'
import type { AudioCodecCapApi } from '../stream-broker/audio-codec-proxy.js'

/**
 * Unit tests for AudioCodecSession's PCM accumulator. The session
 * buffers fragmented codec PCM frames into ~0.5s windows so the
 * downstream classifiers (YAMNet, Apple SoundAnalysis) see a stable
 * input length regardless of source codec frame size.
 */

interface PcmFrame {
  data: Uint8Array
  sampleRate: number
  channels: number
  pts: number
}

function makeFakeApi(opts: { pcms: PcmFrame[] }): {
  api: AudioCodecCapApi
  pullCalls: number
} {
  let _pullCalls = 0
  const queue = [...opts.pcms]
  const api: AudioCodecCapApi = {
    createDecodeSession: vi.fn(async () => ({ sessionId: 'sess-1', nodeId: 'n0' })),
    pushEncodedFrame: vi.fn(async () => undefined),
    pullPcm: vi.fn(async ({ maxCount }: { maxCount: number }) => {
      _pullCalls++
      const out = queue.splice(0, maxCount)
      return out
    }),
    closeSession: vi.fn(async () => undefined),
  } as unknown as AudioCodecCapApi
  return { api, pullCalls: 0 }
}

function pcmFrame(samples: number, channels = 1, sampleRate = 16000, pts = 0): PcmFrame {
  // f32le, channels interlaced. We don't care about content — only byte length.
  const data = new Uint8Array(samples * channels * 4)
  return { data, sampleRate, channels, pts }
}

const baseCfg: AudioCodecSessionConfig = {
  codec: 'aac',
  sourceSampleRate: 44100,
  sourceChannels: 1,
  targetSampleRate: 16000,
  targetChannels: 1,
}

describe('AudioCodecSession low-latency emit', () => {
  it('emits one chunk per pulled PCM frame (no accumulator window)', async () => {
    // 10 frames × 1024 samples each → 10 emits, one per frame.
    // Previously the session coalesced into a 500ms window before
    // emitting; we removed that to give WebRTC consumers sub-100 ms
    // decode latency. ML analyzers accumulate at their own pipeline
    // side (the AudioChunkPlane is pull-based).
    const frames = Array.from({ length: 10 }, (_, i) => pcmFrame(1024, 1, 16000, i * 1024))
    const { api } = makeFakeApi({ pcms: frames })
    const emitted: DecodedAudioChunk[] = []
    const session = new AudioCodecSession(api, baseCfg, (chunk) => {
      emitted.push(chunk)
    })

    session.processPacket(Buffer.alloc(50))
    await vi.waitFor(() => expect(emitted.length).toBe(10), { timeout: 500 })

    // Each emit carries exactly one frame: 1024 samples × 4 bytes f32le.
    expect(emitted[0]!.data.byteLength).toBe(1024 * 4)
    expect(emitted[0]!.sampleRate).toBe(16000)
    expect(emitted[0]!.channels).toBe(1)
    // Wall-clock timestamp (ms-since-epoch), not the codec-relative
    // pcm.pts (often starts at 0).
    expect(emitted[0]!.timestamp).toBeGreaterThan(1_700_000_000_000)

    await session.close()
  })

  it('does not buffer partial frames on close (nothing to flush)', async () => {
    // 4 small frames → 4 emits during polling (no accumulator). close()
    // has nothing extra to drain.
    const frames = Array.from({ length: 4 }, (_, i) => pcmFrame(1024, 1, 16000, i * 1024))
    const { api } = makeFakeApi({ pcms: frames })
    const emitted: DecodedAudioChunk[] = []
    const session = new AudioCodecSession(api, baseCfg, (chunk) => {
      emitted.push(chunk)
    })

    session.processPacket(Buffer.alloc(50))
    await vi.waitFor(() => expect(emitted.length).toBe(4), { timeout: 500 })

    await session.close()
    expect(emitted).toHaveLength(4)
  })

  it('does not emit on close when no frames were pulled', async () => {
    const { api } = makeFakeApi({ pcms: [] })
    const emitted: DecodedAudioChunk[] = []
    const session = new AudioCodecSession(api, baseCfg, (chunk) => {
      emitted.push(chunk)
    })

    session.processPacket(Buffer.alloc(50))
    await vi.waitFor(
      () => expect((api.createDecodeSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
      { timeout: 500 },
    )

    await session.close()
    expect(emitted).toHaveLength(0)
  })

  it('emits each format-changing frame as its own chunk (no merge)', async () => {
    // 4 frames @16k then 1 frame @48k → 5 separate emits, each
    // carrying its native sample rate. No accumulator window means no
    // explicit format-change flush is needed.
    const frames: PcmFrame[] = [
      ...Array.from({ length: 4 }, (_, i) => pcmFrame(1024, 1, 16000, i * 1024)),
      pcmFrame(1024, 1, 48000, 9999),
    ]
    const { api } = makeFakeApi({ pcms: frames })
    const emitted: DecodedAudioChunk[] = []
    const session = new AudioCodecSession(api, baseCfg, (chunk) => {
      emitted.push(chunk)
    })

    session.processPacket(Buffer.alloc(50))
    await vi.waitFor(() => expect(emitted.length).toBe(5), { timeout: 500 })
    expect(emitted.slice(0, 4).every((c) => c.sampleRate === 16000)).toBe(true)
    expect(emitted[4]!.sampleRate).toBe(48000)
    for (const c of emitted) expect(c.data.byteLength).toBe(1024 * 4)

    await session.close()
  })

  it('disposes a session created during a close() race — no orphan (leak regression)', async () => {
    // The native-memory leak: createDecodeSession was in flight when the broker
    // close()d the handle (sessionId still null → close() no-op'd). The create
    // then resolved and adopted a session nobody owned → its poll loop ticked
    // without ever pulling → the 30s idle-reaper reaped it, leaking a live
    // ffmpeg child + unbounded pcmQueue per race. The fix must close the
    // just-created session instead of orphaning it.
    let resolveCreate: ((v: { sessionId: string; nodeId: string }) => void) | null = null
    const createGate = new Promise<{ sessionId: string; nodeId: string }>((res) => {
      resolveCreate = res
    })
    const closeCalls: { sessionId: string }[] = []
    const api: AudioCodecCapApi = {
      createDecodeSession: vi.fn(() => createGate),
      pushEncodedFrame: vi.fn(async () => undefined),
      pullPcm: vi.fn(async () => []),
      closeSession: vi.fn(async (input: { sessionId: string }) => {
        closeCalls.push({ sessionId: input.sessionId })
      }),
    } as unknown as AudioCodecCapApi

    const session = new AudioCodecSession(api, baseCfg, () => {})

    // First packet kicks off ensureSession → createDecodeSession (hangs on gate).
    session.processPacket(Buffer.alloc(50))
    await vi.waitFor(() =>
      expect((api.createDecodeSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
    )

    // Broker tears the handle down WHILE the create is still in flight.
    await session.close()

    // Create resolves now — the guard must close the orphan, not adopt it.
    resolveCreate!({ sessionId: 'sess-race', nodeId: 'n0' })
    await vi.waitFor(() => expect(closeCalls.length).toBe(1))

    expect(closeCalls[0]!.sessionId).toBe('sess-race')
    // No poll loop ever pulled (the orphaned inert loop is what leaked).
    expect((api.pullPcm as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
