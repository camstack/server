/**
 * While recorded playback owns the track, nothing LIVE reaches the wire.
 *
 * Measured on the hub, 2026-10-07 (camera 103, the hosted PWA): during
 * recorded playback the session logged `PLI received — replayed source-RTP
 * pre-buffer` every few seconds — 369 times in 24 h, every one of them while
 * `recorded: live RTP GATED` was in force. The pre-buffer is the LIVE broker's
 * current GOP, and the PLI path replays it straight through the repacketizer,
 * past the forwarder's gate: the recorded `low` picture (640 wide) was
 * replaced by a GOP of live `main` (3840 wide) mid-recording, which is the
 * `videoWidth 640 → 3840` the viewer measured. The same afternoon, an
 * instant-start replay that began just before the gate finished draining
 * 127 ms after it.
 *
 * Built like `session-source-restart.spec.ts`: the object without its werift
 * constructor, driving the two methods under test.
 */
import { describe, expect, it, vi } from 'vitest'
import { AdaptiveSession } from '../session.js'

interface PliState {
  liveFeedGated: boolean
  lastPliResendAt: number
  activeRtpReplay: { active: boolean; abort: () => void } | null
}

interface Harness {
  /** The session, through its public surface. */
  readonly session: AdaptiveSession
  /** The SAME object, through the private fields the test seeds and reads.
   *  Two views rather than `AdaptiveSession & PliState`: that intersection is
   *  `never`, because the class declares these fields private. */
  readonly state: PliState
  readonly bootstrapReads: { count: number }
  readonly replays: string[]
  readonly logger: { info: ReturnType<typeof vi.fn> }
}

function pliSession(): Harness {
  const instance = Object.create(AdaptiveSession.prototype)
  const session: AdaptiveSession = instance
  const state: PliState = instance
  const bootstrapReads = { count: 0 }
  const replays: string[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
  Object.assign(session, {
    sessionId: 'sess-103',
    deviceId: 103,
    closed: false,
    logger,
    negotiatedCodec: 'H264',
    liveFeedGated: false,
    lastPliResendAt: 0,
    lastRecordedPliLogAt: 0,
    recordedPliRefusedSinceLog: 0,
    activeRtpReplay: null,
    lastKeyframeNals: [Buffer.from('live-idr')],
    rtpRebasePending: false,
    recordedAudioRebasePending: false,
    rtpBootstrap: () => {
      bootstrapReads.count += 1
      return [Buffer.from('live-main-gop')]
    },
    // The one sink every PLI recovery funnels into on the source-RTP path.
    startPacedRtpReplay: (_b: readonly Buffer[], _c: string, message: string) => {
      replays.push(message)
    },
    writeVideoNals: () => {
      replays.push('cached-keyframe')
    },
    sendRtpTimestamp: () => 0,
  })
  return { session, state, bootstrapReads, replays, logger }
}

const firePli = (session: AdaptiveSession): void => {
  ;(session as unknown as { handlePli: () => void }).handlePli()
}

describe('AdaptiveSession PLI while recorded owns the track', () => {
  it('live: a PLI replays the broker pre-buffer (the harness reaches the sink)', () => {
    const { session, replays } = pliSession()
    firePli(session)
    expect(replays).toEqual(['PLI received — replayed source-RTP pre-buffer'])
  })

  it('recorded: a PLI replays nothing live — neither the pre-buffer nor the cached keyframe', () => {
    const { session, replays, bootstrapReads } = pliSession()
    session.setLiveFeedGate(true)
    firePli(session)
    expect(replays).toEqual([])
    expect(bootstrapReads.count).toBe(0)
  })

  it('recorded: the refusal is logged, with the count of refusals it stands for', () => {
    const { session, logger } = pliSession()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      session.setLiveFeedGate(true)
      firePli(session)
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(600)
        firePli(session)
      }
      vi.advanceTimersByTime(10_000)
      firePli(session)
      const lines = logger.info.mock.calls.filter(([m]) =>
        String(m).startsWith('PLI during recorded playback'),
      )
      expect(lines.map(([, o]) => (o as { meta: { refused: number } }).meta.refused)).toEqual([
        1, 6,
      ])
      const first = lines[0]
      if (first === undefined) throw new Error('no refusal line')
      expect((first[1] as { tags: { deviceId: number } }).tags.deviceId).toBe(103)
    } finally {
      vi.useRealTimers()
    }
  })

  it('back to live: a PLI replays the pre-buffer again', () => {
    const { session, replays } = pliSession()
    session.setLiveFeedGate(true)
    session.setLiveFeedGate(false)
    firePli(session)
    expect(replays).toEqual(['PLI received — replayed source-RTP pre-buffer'])
  })
})

describe('AdaptiveSession.setLiveFeedGate', () => {
  it('gating aborts a live replay still draining', () => {
    const { session, state } = pliSession()
    const abort = vi.fn()
    state.activeRtpReplay = { active: true, abort }
    session.setLiveFeedGate(true)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(state.activeRtpReplay).toBeNull()
  })

  it('ungating leaves a replay alone — it is the live bootstrap going live needs', () => {
    const { session, state } = pliSession()
    const abort = vi.fn()
    const replay = { active: true, abort }
    state.activeRtpReplay = replay
    session.setLiveFeedGate(false)
    expect(abort).not.toHaveBeenCalled()
    expect(state.activeRtpReplay).toBe(replay)
  })
})
