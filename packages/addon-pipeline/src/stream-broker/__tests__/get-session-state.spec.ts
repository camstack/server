/**
 * `WebrtcSessionProvider.getSessionState` is a thin facade over the
 * broker server's `getSessionRenegotiationState`. The provider must
 * forward the sessionId verbatim and relay the broker's pending state
 * (or null) unchanged — the client polls this after an adaptive tier
 * switch to learn it must re-offer.
 */
import { describe, it, expect, vi } from 'vitest'
import { WebrtcSessionProvider } from '../device-scoped-providers.js'

const mockManager = {
  getProfileSlotsForDevice: vi.fn().mockReturnValue([]),
  getCameraStreamsForDevice: vi.fn().mockReturnValue([]),
  getBroker: vi.fn().mockResolvedValue(null),
  getStreamWebrtcParams: vi.fn().mockReturnValue(undefined),
  getCameraStreamProbedParams: vi.fn().mockReturnValue(undefined),
} as unknown as import('../stream-broker/stream-broker-manager.js').StreamBrokerManager

function makeServer(getSessionRenegotiationState: ReturnType<typeof vi.fn>) {
  return {
    getSessionRenegotiationState,
  } as unknown as import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
}

describe('WebrtcSessionProvider.getSessionState', () => {
  it("returns the broker's pending renegotiation for a session mid tier-switch", async () => {
    const pending = {
      pendingRenegotiation: {
        target: { kind: 'cam-stream' as const, camStreamId: 'native:sub' },
        epoch: 3,
      },
    }
    const getSessionRenegotiationState = vi.fn().mockReturnValue(pending)
    const facade = new WebrtcSessionProvider(makeServer(getSessionRenegotiationState), mockManager)

    const result = await facade.getSessionState({ deviceId: 42, sessionId: 's-1' })

    expect(getSessionRenegotiationState).toHaveBeenCalledWith('s-1')
    expect(result).toEqual(pending)
  })

  it('returns a null pending when the broker reports no renegotiation', async () => {
    const getSessionRenegotiationState = vi.fn().mockReturnValue({ pendingRenegotiation: null })
    const facade = new WebrtcSessionProvider(makeServer(getSessionRenegotiationState), mockManager)

    const result = await facade.getSessionState({ deviceId: 7, sessionId: 'unknown' })

    expect(getSessionRenegotiationState).toHaveBeenCalledWith('unknown')
    expect(result).toEqual({ pendingRenegotiation: null })
  })
})
