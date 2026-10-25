/**
 * D465 — the decode poll cadence is a property of the FASTEST CONSUMER that
 * exists right now, not a constant.
 *
 * `AudioCodecSession` polled `pullPcm` every 40 ms for the life of every AAC
 * decode session. 40 ms is a WebRTC latency budget: the only thing in
 * `buildAudioCodecEmitCallback` that needs a sub-100 ms chunk is the PCMU /
 * Opus egress, and that branch is already gated on `encodedCallbacks.size > 0`.
 * With no live listener the sole consumer is the audio-chunk plane, whose
 * consumer accumulates to `AUDIO_WINDOW_TARGET_MS` (1 s) before it classifies
 * anything — so on the live hub at night four AAC sessions paid 100 requests
 * per second, ~6 000/min across hub-main's UDS, to shave latency nobody was
 * measuring.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AudioCodecSession,
  type AudioCodecSessionConfig,
  IDLE_POLL_INTERVAL_MS,
  MAX_PCM_PER_POLL,
  REALTIME_POLL_INTERVAL_MS,
} from '../stream-broker/audio-codec-session.js'
import type { AudioCodecCapApi } from '../stream-broker/audio-codec-proxy.js'

function makeApi(): AudioCodecCapApi {
  return {
    createDecodeSession: vi.fn(async () => ({ sessionId: 'sess-1', nodeId: 'n0' })),
    pushEncodedFrame: vi.fn(async () => undefined),
    pullPcm: vi.fn(async () => []),
    closeSession: vi.fn(async () => undefined),
  } as unknown as AudioCodecCapApi
}

const baseCfg: AudioCodecSessionConfig = {
  codec: 'aac',
  sourceSampleRate: 16000,
  sourceChannels: 1,
  targetSampleRate: 16000,
  targetChannels: 1,
}

function pullCount(api: AudioCodecCapApi): number {
  return (api.pullPcm as ReturnType<typeof vi.fn>).mock.calls.length
}

/** Arm a session and let its `createDecodeSession` settle. */
async function armed(
  api: AudioCodecCapApi,
  realtimeDemand?: () => boolean,
): Promise<AudioCodecSession> {
  const session = new AudioCodecSession(api, baseCfg, () => {}, undefined, realtimeDemand)
  session.processPacket(Buffer.alloc(50))
  await vi.advanceTimersByTimeAsync(0)
  return session
}

describe('AudioCodecSession poll cadence follows realtime demand (D465)', () => {
  it('polls at the idle cadence when no realtime consumer is attached', async () => {
    vi.useFakeTimers()
    try {
      const api = makeApi()
      const session = await armed(api, () => false)
      const before = pullCount(api)

      await vi.advanceTimersByTimeAsync(2_000)

      // 2 s at the idle cadence, not 50 polls at 40 ms. One tick of slack for
      // the immediate first poll and scheduling jitter.
      const polls = pullCount(api) - before
      const expected = 2_000 / IDLE_POLL_INTERVAL_MS
      expect(polls).toBeLessThanOrEqual(expected + 1)
      expect(polls).toBeGreaterThanOrEqual(expected - 1)

      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls at the realtime cadence while a live egress consumer is attached', async () => {
    vi.useFakeTimers()
    try {
      const api = makeApi()
      const session = await armed(api, () => true)
      const before = pullCount(api)

      await vi.advanceTimersByTimeAsync(1_000)

      const polls = pullCount(api) - before
      const expected = 1_000 / REALTIME_POLL_INTERVAL_MS
      expect(polls).toBeGreaterThanOrEqual(expected - 1)

      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('speeds up within one idle interval when a listener arrives', async () => {
    vi.useFakeTimers()
    try {
      const api = makeApi()
      let live = false
      const session = await armed(api, () => live)
      await vi.advanceTimersByTimeAsync(1_000)

      live = true
      // One idle interval is the worst case before the loop re-reads demand.
      await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS)
      const atSwitch = pullCount(api)
      await vi.advanceTimersByTimeAsync(400)

      const polls = pullCount(api) - atSwitch
      expect(polls).toBeGreaterThanOrEqual(400 / REALTIME_POLL_INTERVAL_MS - 1)

      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains a batch large enough to cover the idle interval', () => {
    // The idle cadence is only safe if one poll can carry everything the
    // decoder produced meanwhile. An AAC session emits ~25 PCM frames/s
    // (2.7 kB each, ~42 ms), so the batch must cover the interval with margin
    // or the decoder's queue grows monotonically and drops its oldest chunks.
    const framesPerSecond = 1000 / 42
    const producedPerInterval = (framesPerSecond * IDLE_POLL_INTERVAL_MS) / 1000
    expect(MAX_PCM_PER_POLL).toBeGreaterThanOrEqual(producedPerInterval * 2)
  })

  it('keeps the realtime cadence when no demand probe is supplied', async () => {
    // A caller that does not know about the probe must behave exactly as it
    // did before this record — the fast cadence, unchanged.
    vi.useFakeTimers()
    try {
      const api = makeApi()
      const session = await armed(api)
      const before = pullCount(api)

      await vi.advanceTimersByTimeAsync(1_000)

      expect(pullCount(api) - before).toBeGreaterThanOrEqual(1_000 / REALTIME_POLL_INTERVAL_MS - 1)
      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
