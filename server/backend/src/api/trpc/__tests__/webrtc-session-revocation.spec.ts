/**
 * A WebRTC session opened under a login session is closed when that login
 * session is revoked (and not before, and not for anyone else's). Disarm:
 * drop the `hold(...)` calls in `wrapWebrtcSessionProviderWithRelay` and the
 * "closes" claim goes red.
 */
import type { InferProvider } from '@camstack/types'
import { webrtcSessionCapability } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSessionConnectionsForTests,
  getSessionConnections,
} from '../../../auth/session-connections.js'
import type { TrpcContext } from '../trpc.context.js'
import { wrapWebrtcSessionProviderWithRelay } from '../trpc.router.js'

type WebrtcSessionProvider = InferProvider<typeof webrtcSessionCapability>

function provider(): WebrtcSessionProvider {
  const mock = vi.fn()
  return {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'media-1', sdpOffer: 'o' }),
    handleOffer: vi.fn().mockResolvedValue({ sessionId: 'media-2', sdpAnswer: 'a' }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    listStreams: mock,
    handleAnswer: mock,
    addIceCandidate: mock,
    getIceCandidates: mock,
    hasAdaptiveBitrate: mock,
    getSessionState: mock,
    getSessionDebug: mock,
    applyDownlinkProbe: mock,
  }
}

const ctxFor = (sessionId: string | undefined): TrpcContext => ({
  user: {
    id: 'u-1',
    username: 'u',
    isAdmin: true,
    permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    ...(sessionId === undefined ? {} : { sessionId }),
  },
})

const revoke = (sessionIds: readonly string[]) =>
  getSessionConnections().endSessions({
    sessionIds,
    userId: 'u-1',
    allOfUser: false,
    exceptSessionId: null,
    reason: 'logout-everywhere',
  })

afterEach(() => __resetSessionConnectionsForTests())

describe('webrtc-session media is tied to the login session', () => {
  it('revoking the session closes the sessions it created and offered, by deviceId', async () => {
    const p = provider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(p, ctxFor('s-1'))
    await wrapped.createSession({ deviceId: 102, target: { kind: 'adaptive' } })
    await wrapped.handleOffer({ deviceId: 101, sdpOffer: 'x' })

    expect(revoke(['s-1']).mediaSessions).toBe(2)
    await vi.waitFor(() => expect(p.closeSession).toHaveBeenCalledTimes(2))
    expect(p.closeSession).toHaveBeenCalledWith({ deviceId: 102, sessionId: 'media-1' })
    expect(p.closeSession).toHaveBeenCalledWith({ deviceId: 101, sessionId: 'media-2' })
  })

  it('another login session revoked leaves this one playing', async () => {
    const p = provider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(p, ctxFor('s-1'))
    await wrapped.createSession({ deviceId: 102, target: { kind: 'adaptive' } })

    expect(revoke(['s-2']).mediaSessions).toBe(0)
    expect(p.closeSession).not.toHaveBeenCalled()
  })

  it('a session the client closed itself is not closed again by the revoke', async () => {
    const p = provider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(p, ctxFor('s-1'))
    await wrapped.createSession({ deviceId: 102, target: { kind: 'adaptive' } })
    await wrapped.closeSession({ deviceId: 102, sessionId: 'media-1' })

    expect(revoke(['s-1']).mediaSessions).toBe(0)
    expect(p.closeSession).toHaveBeenCalledTimes(1)
  })

  it('a principal with no login session ties nothing', async () => {
    const p = provider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(p, ctxFor(undefined))
    await wrapped.createSession({ deviceId: 102, target: { kind: 'adaptive' } })
    expect(revoke(['s-1']).mediaSessions).toBe(0)
  })
})
