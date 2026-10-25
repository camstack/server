/**
 * Unit test for the broker-side Opus encode client against a fake audio-codec
 * cap API (no node-av, no real encoder) — proves the lazy-create / push / poll /
 * emit / idle / close / session-reaped-recovery behavior that mirrors the decode
 * client, without needing the cap mounted.
 */
import { describe, it, expect } from 'vitest'
import type { AudioEncodedChunk, DecodedAudioChunk } from '@camstack/types'
import type { AudioCodecCapApi } from '../audio-codec-proxy'
import {
  OpusEncodeSession,
  encodeOpusSilenceFrame,
  type EncodedOpusFrame,
} from '../opus-encode-session'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface FakeState {
  created: number
  closed: number
  flushed: number
  pcmPushed: number
  pending: { data: Uint8Array; pts: number }[]
  failNextPullOnce: boolean
}

/** Fake cap: each pushPcm queues one 3-byte "opus" packet for pullEncoded. */
function makeFakeApi(state: FakeState): AudioCodecCapApi {
  return {
    listSupportedCodecs: async () => [],
    canHandle: async () => true,
    createDecodeSession: async () => ({ sessionId: 'dec', nodeId: 'n1' }),
    createEncodeSession: async () => {
      state.created++
      return { sessionId: `enc-${state.created}`, nodeId: 'n1' }
    },
    closeSession: async () => {
      state.closed++
    },
    pushEncodedFrame: async () => {},
    pullPcm: async () => [],
    pushPcm: async ({ pts }) => {
      state.pcmPushed++
      state.pending.push({ data: new Uint8Array([1, 2, 3]), pts: pts ?? 0 })
    },
    pullEncoded: async ({ maxCount }) => {
      if (state.failNextPullOnce) {
        state.failNextPullOnce = false
        throw new Error("encode session 'enc-1' not found")
      }
      return state.pending.splice(0, maxCount).map(
        (p): AudioEncodedChunk => ({
          data: new Uint8Array(p.data),
          codec: 'opus',
          pts: p.pts,
          frameComplete: true,
        }),
      )
    },
    flushEncode: async () => {
      state.flushed++
      return []
    },
  }
}

function freshState(): FakeState {
  return {
    created: 0,
    closed: 0,
    flushed: 0,
    pcmPushed: 0,
    pending: [],
    failNextPullOnce: false,
  }
}

function pcm(ms: number): DecodedAudioChunk {
  return { data: Buffer.alloc(1920), sampleRate: 48000, channels: 2, timestamp: ms }
}

describe('OpusEncodeSession', () => {
  it('lazily creates the encode session on first push and emits encoded frames', async () => {
    const state = freshState()
    const emitted: EncodedOpusFrame[] = []
    const s = new OpusEncodeSession(
      makeFakeApi(state),
      { sourceSampleRate: 48000, sourceChannels: 2, targetSampleRate: 48000, targetChannels: 2 },
      (f) => emitted.push(f),
    )
    expect(state.created).toBe(0)
    s.pushPcm(pcm(100))
    await wait(80) // let ensureSession + one poll tick (40ms) run
    expect(state.created).toBe(1)
    expect(state.pcmPushed).toBe(1)
    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0]!.data).toBeInstanceOf(Buffer)
    expect(Array.from(emitted[0]!.data)).toEqual([1, 2, 3])
    expect(emitted[0]!.ptsMs).toBe(100)
    await s.close()
  })

  it('ignores empty chunks', async () => {
    const state = freshState()
    const s = new OpusEncodeSession(
      makeFakeApi(state),
      { sourceSampleRate: 48000, sourceChannels: 2, targetSampleRate: 48000, targetChannels: 2 },
      () => {},
    )
    s.pushPcm({ data: Buffer.alloc(0), sampleRate: 48000, channels: 2, timestamp: 0 })
    await wait(60)
    expect(state.created).toBe(0)
    await s.close()
  })

  it('close() flushes the encoder tail and closes the session', async () => {
    const state = freshState()
    const s = new OpusEncodeSession(
      makeFakeApi(state),
      { sourceSampleRate: 48000, sourceChannels: 2, targetSampleRate: 48000, targetChannels: 2 },
      () => {},
    )
    s.pushPcm(pcm(0))
    await wait(80)
    await s.close()
    expect(state.flushed).toBe(1)
    expect(state.closed).toBe(1)
  })

  it('idle() releases the session but the handle re-creates on next push', async () => {
    const state = freshState()
    const s = new OpusEncodeSession(
      makeFakeApi(state),
      { sourceSampleRate: 48000, sourceChannels: 2, targetSampleRate: 48000, targetChannels: 2 },
      () => {},
    )
    s.pushPcm(pcm(0))
    await wait(80)
    expect(state.created).toBe(1)
    await s.idle()
    expect(state.closed).toBe(1)
    s.pushPcm(pcm(20))
    await wait(80)
    expect(state.created).toBe(2) // re-created lazily
    await s.close()
  })

  it('recovers when the upstream session is reaped (pullEncoded throws not-found)', async () => {
    const state = freshState()
    const emitted: EncodedOpusFrame[] = []
    const s = new OpusEncodeSession(
      makeFakeApi(state),
      { sourceSampleRate: 48000, sourceChannels: 2, targetSampleRate: 48000, targetChannels: 2 },
      (f) => emitted.push(f),
    )
    s.pushPcm(pcm(0))
    await wait(60)
    state.failNextPullOnce = true // next poll sees "not found" → drops session id
    await wait(60)
    s.pushPcm(pcm(20)) // should re-create lazily
    await wait(80)
    expect(state.created).toBe(2)
    expect(emitted.length).toBeGreaterThanOrEqual(1)
    await s.close()
  })
})

describe('encodeOpusSilenceFrame', () => {
  it('returns the last steady-state encoded silence packet and closes the session', async () => {
    const state = freshState()
    const api = makeFakeApi(state)
    const frame = await encodeOpusSilenceFrame(api, { channels: 2 })
    expect(frame).toBeInstanceOf(Buffer)
    expect(frame!.length).toBeGreaterThan(0)
    expect(state.created).toBe(1)
    expect(state.closed).toBe(1) // short-lived session torn down
  })

  it('returns null when the cap yields nothing', async () => {
    const state = freshState()
    const api: AudioCodecCapApi = {
      ...makeFakeApi(state),
      pullEncoded: async () => [],
      flushEncode: async () => [],
    }
    const frame = await encodeOpusSilenceFrame(api, { channels: 1 })
    expect(frame).toBeNull()
  })

  it('returns null (never throws) when createEncodeSession fails', async () => {
    const state = freshState()
    const api: AudioCodecCapApi = {
      ...makeFakeApi(state),
      createEncodeSession: async () => {
        throw new Error('no encoder')
      },
    }
    expect(await encodeOpusSilenceFrame(api, { channels: 2 })).toBeNull()
  })
})
