/**
 * Answered-but-silent guard — the signaling path deliberately returns the SDP
 * answer WITHOUT awaiting source bring-up (bare trickle answer, background
 * dial). The price of that design is a failure shape where the client
 * connects (ICE + DTLS up) and then stares at a black player because the
 * source never delivered a packet — previously indistinguishable in the logs
 * from a healthy session whose viewer left. The session now arms a watchdog
 * when feeding starts: no source media within the budget → ONE named WARN.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AdaptiveSession } from '../session.js'
import { asLogger } from '../types.js'
import type { FrameSource } from '../types.js'

function emptySource(): FrameSource {
  return (async function* () {})() as FrameSource
}

interface Harness {
  readonly session: AdaptiveSession
  readonly warns: { msg: string; meta: Record<string, unknown> | undefined }[]
}

function makeSession(): Harness {
  const warns: { msg: string; meta: Record<string, unknown> | undefined }[] = []
  const logger = asLogger({
    warn: (msg: string, meta?: { meta?: Record<string, unknown> }) => {
      warns.push({ msg, meta: meta?.meta })
    },
  })
  const session = new AdaptiveSession({
    sessionId: 'test-session',
    deviceId: 101,
    source: emptySource(),
    logger,
  })
  return { session, warns }
}

describe('AdaptiveSession source-silence watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('warns ONCE when no source media arrives within the budget', async () => {
    const { session, warns } = makeSession()
    session.armSourceSilenceWatchdog()
    vi.advanceTimersByTime(AdaptiveSession.SOURCE_SILENT_AFTER_ANSWER_MS + 1)
    const silence = warns.filter((w) => w.msg.includes('NO source media'))
    expect(silence).toHaveLength(1)
    expect(silence[0]?.meta).toMatchObject({ deviceId: 101, sessionId: 'test-session' })
    // No re-fire.
    vi.advanceTimersByTime(AdaptiveSession.SOURCE_SILENT_AFTER_ANSWER_MS * 2)
    expect(warns.filter((w) => w.msg.includes('NO source media'))).toHaveLength(1)
    await session.close()
  })

  it('does NOT warn when source RTP reached the session (even pre-DTLS)', async () => {
    const { session, warns } = makeSession()
    session.armSourceSilenceWatchdog()
    // Any source RTP proves the source is alive — the forward itself may
    // still no-op (no negotiated codec/sender yet), but silence it is not.
    session.forwardSourceRtpVideo(Buffer.from([0x80, 0x60, 0x00, 0x01]))
    vi.advanceTimersByTime(AdaptiveSession.SOURCE_SILENT_AFTER_ANSWER_MS * 2)
    expect(warns.filter((w) => w.msg.includes('NO source media'))).toHaveLength(0)
    await session.close()
  })

  it('does NOT warn after the session closed', async () => {
    const { session, warns } = makeSession()
    session.armSourceSilenceWatchdog()
    await session.close()
    vi.advanceTimersByTime(AdaptiveSession.SOURCE_SILENT_AFTER_ANSWER_MS * 2)
    expect(warns.filter((w) => w.msg.includes('NO source media'))).toHaveLength(0)
  })

  it('arming twice keeps a single watchdog', async () => {
    const { session, warns } = makeSession()
    session.armSourceSilenceWatchdog()
    session.armSourceSilenceWatchdog()
    vi.advanceTimersByTime(AdaptiveSession.SOURCE_SILENT_AFTER_ANSWER_MS + 1)
    expect(warns.filter((w) => w.msg.includes('NO source media'))).toHaveLength(1)
    await session.close()
  })
})
