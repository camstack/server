/**
 * Revoking a login session ends the sockets and media it holds - and only
 * those. Disarm: make `endSessions` a no-op and every "closes" claim goes red;
 * make it close every socket and the "other sessions" claims go red.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_ENDED_CLOSE_CODE,
  SESSION_ENDED_CLOSE_REASON,
  SessionConnections,
  type SessionConnectionsLogger,
} from '../session-connections.js'

function setup() {
  const connections = new SessionConnections()
  const logger: SessionConnectionsLogger = { info: vi.fn(), warn: vi.fn() }
  connections.setLogger(logger)
  return { connections, logger }
}

const socket = () => ({ close: vi.fn() })
const ended = (
  sessionIds: readonly string[],
  extra: Partial<{ userId: string | null; allOfUser: boolean }> = {},
) => ({
  sessionIds,
  userId: extra.userId ?? null,
  allOfUser: extra.allOfUser ?? false,
  exceptSessionId: null,
  reason: 'revoked-by-user',
})

describe('SessionConnections', () => {
  it('closes the sockets of the revoked session with the session-ended code, and no others', () => {
    const { connections } = setup()
    const mine = socket()
    const sameUserOtherSession = socket()
    const otherUser = socket()
    connections.trackSocket(mine, { userId: 'u-1', sessionId: 's-1' })
    connections.trackSocket(sameUserOtherSession, { userId: 'u-1', sessionId: 's-2' })
    connections.trackSocket(otherUser, { userId: 'u-2', sessionId: 's-3' })

    const result = connections.endSessions(ended(['s-1']))

    expect(result.sockets).toBe(1)
    expect(mine.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, SESSION_ENDED_CLOSE_REASON)
    expect(sameUserOtherSession.close).not.toHaveBeenCalled()
    expect(otherUser.close).not.toHaveBeenCalled()
  })

  it("an everything-of-this-user revoke also closes that user's sessionless sockets, not another user's", () => {
    const { connections } = setup()
    const legacy = socket()
    const strangerLegacy = socket()
    connections.trackSocket(legacy, { userId: 'u-1', sessionId: undefined })
    connections.trackSocket(strangerLegacy, { userId: 'u-2', sessionId: undefined })

    connections.endSessions(ended([], { userId: 'u-1', allOfUser: true }))

    expect(legacy.close).toHaveBeenCalledTimes(1)
    expect(strangerLegacy.close).not.toHaveBeenCalled()
  })

  it('a single-session revoke leaves a sessionless socket of the same user alone', () => {
    const { connections } = setup()
    const legacy = socket()
    connections.trackSocket(legacy, { userId: 'u-1', sessionId: undefined })
    connections.endSessions(ended(['s-1'], { userId: 'u-1' }))
    expect(legacy.close).not.toHaveBeenCalled()
  })

  it('an untracked (already closed) socket is not closed again', () => {
    const { connections } = setup()
    const s = socket()
    const untrack = connections.trackSocket(s, { userId: 'u-1', sessionId: 's-1' })
    untrack()
    expect(connections.endSessions(ended(['s-1'])).sockets).toBe(0)
    expect(s.close).not.toHaveBeenCalled()
  })

  it('closes the media sessions of the revoked session, logs each with its deviceId, and spares others', async () => {
    const { connections, logger } = setup()
    const closeMine = vi.fn().mockResolvedValue(undefined)
    const closeOther = vi.fn().mockResolvedValue(undefined)
    connections.trackMedia('s-1', { deviceId: 102, mediaSessionId: 'm-1', close: closeMine })
    connections.trackMedia('s-2', { deviceId: 101, mediaSessionId: 'm-2', close: closeOther })

    const result = connections.endSessions(ended(['s-1']))
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        'Media session closed by session revocation',
        expect.objectContaining({ tags: { deviceId: 102 } }),
      ),
    )

    expect(result.mediaSessions).toBe(1)
    expect(closeMine).toHaveBeenCalledTimes(1)
    expect(closeOther).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'Revoked sessions ended their connections',
      expect.objectContaining({ meta: expect.objectContaining({ sockets: 0, mediaSessions: 1 }) }),
    )
  })

  it('a media session the client closed itself is not closed again', () => {
    const { connections } = setup()
    const close = vi.fn().mockResolvedValue(undefined)
    connections.trackMedia('s-1', { deviceId: 102, mediaSessionId: 'm-1', close })
    connections.forgetMedia('s-1', 'm-1')
    expect(connections.endSessions(ended(['s-1'])).mediaSessions).toBe(0)
    expect(close).not.toHaveBeenCalled()
  })

  it('a media close that fails is logged with the deviceId and does not stop the rest', async () => {
    const { connections, logger } = setup()
    const ok = vi.fn().mockResolvedValue(undefined)
    connections.trackMedia('s-1', {
      deviceId: 102,
      mediaSessionId: 'm-1',
      close: vi.fn().mockRejectedValue(new Error('gone')),
    })
    connections.trackMedia('s-1', { deviceId: 101, mediaSessionId: 'm-2', close: ok })

    connections.endSessions(ended(['s-1']))

    await vi.waitFor(() => expect(ok).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        'Closing a media session of an ended session failed',
        expect.objectContaining({ tags: { deviceId: 102 } }),
      ),
    )
  })
})
