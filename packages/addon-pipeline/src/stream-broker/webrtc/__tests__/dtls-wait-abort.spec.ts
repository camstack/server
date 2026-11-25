import { describe, it, expect, vi } from 'vitest'
import { AdaptiveSession, dtlsWaitAbortReason } from '../session'

describe('dtlsWaitAbortReason (planning#730)', () => {
  it('stops the pre-DTLS wait when the peer is closed or failed', () => {
    expect(dtlsWaitAbortReason('closed', 'checking')).toBe('peer-closed')
    expect(dtlsWaitAbortReason('connecting', 'closed')).toBe('peer-closed')
    expect(dtlsWaitAbortReason('failed', 'checking')).toBe('peer-failed')
  })
  it('keeps waiting while the peer is still negotiating', () => {
    expect(dtlsWaitAbortReason('connecting', 'checking')).toBeNull()
    expect(dtlsWaitAbortReason(undefined, undefined)).toBeNull()
  })
})

/** Drives the REAL `startFeedingWhenDtlsReady` on a prototype-only session. */
async function runWait(peer: { connectionState: string; iceConnectionState: string }) {
  const warn = vi.fn()
  const close = vi.fn(async () => {})
  const startFeedingFrames = vi.fn()
  const session = Object.create(AdaptiveSession.prototype)
  Object.assign(session, {
    closed: false,
    debug: false,
    deviceId: 42,
    sessionId: 'sess-1',
    forceRelayOnly: false,
    logger: { warn, info: vi.fn(), debug: vi.fn() },
    videoSender: { dtlsTransport: { state: 'connecting' } },
    pc: peer,
    close,
    startFeedingFrames,
  })
  const started = Date.now()
  await AdaptiveSession.prototype['startFeedingWhenDtlsReady'].call(session)
  return { warn, close, startFeedingFrames, elapsedMs: Date.now() - started }
}

describe('client-offer DTLS wait (planning#730)', () => {
  it('a closed peer ends the wait at once, logs the reason with the deviceId tag, closes the session', async () => {
    const r = await runWait({ connectionState: 'closed', iceConnectionState: 'closed' })
    expect(r.elapsedMs).toBeLessThan(2_000)
    expect(r.close).toHaveBeenCalledTimes(1)
    expect(r.startFeedingFrames).not.toHaveBeenCalled()
    expect(r.warn).toHaveBeenCalledTimes(1)
    const [, ctx] = r.warn.mock.calls[0] ?? []
    expect(ctx.tags).toEqual({ deviceId: 42 })
    expect(ctx.meta.reason).toBe('peer-closed')
  })

  it('a failed peer reports peer-failed', async () => {
    const r = await runWait({ connectionState: 'failed', iceConnectionState: 'failed' })
    expect(r.elapsedMs).toBeLessThan(2_000)
    expect(r.warn.mock.calls[0]?.[1].meta.reason).toBe('peer-failed')
  })
})
