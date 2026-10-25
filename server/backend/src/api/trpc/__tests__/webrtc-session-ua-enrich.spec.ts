/**
 * Unit tests for the User-Agent enrichment the hub applies to the
 * `webrtc-session` mount. The hub reads the UA from the tRPC request
 * context and merges it into the subscriber attribution so the
 * stream-broker SUBSCRIBERS panel can identify a browser viewer. Any
 * client-supplied `userAgent` is OVERWRITTEN — the server trusts only the
 * request context, never the client.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { InferProvider, BrokerConsumerAttribution } from '@camstack/types'
import { webrtcSessionCapability } from '@camstack/types'
import {
  enrichHintsWithClientClass,
  enrichInputWithUserAgent,
  stripTalkbackFromRequest,
  wrapWebrtcSessionProviderWithRelay,
} from '../trpc.router.js'
import type { TrpcContext } from '../trpc.context.js'

type WebrtcSessionProvider = InferProvider<typeof webrtcSessionCapability>
/** The fields the enrichers read, as the cap declares them; everything else left unset. */
type CreateSessionInput = Parameters<WebrtcSessionProvider['createSession']>[0]
type EnrichableInput = Pick<CreateSessionInput, 'deviceId'> &
  Partial<Pick<CreateSessionInput, 'relayOnly' | 'consumerAttribution' | 'target' | 'hints'>>
type HandleOfferInput = Parameters<WebrtcSessionProvider['handleOffer']>[0]
const session = (): EnrichableInput => ({ deviceId: 1 })

function reqWithUa(userAgent?: string): IncomingMessage {
  const headers: Record<string, string | string[]> = {}
  if (userAgent !== undefined) headers['user-agent'] = userAgent
  return { headers, socket: {} } as unknown as IncomingMessage
}

describe('enrichInputWithUserAgent', () => {
  it('passes input through unchanged when userAgent is null', () => {
    const input = { deviceId: 1, consumerAttribution: { kind: 'webrtc-browser' } as const }
    expect(enrichInputWithUserAgent(input, null)).toBe(input)
  })

  it('merges userAgent into an existing attribution (new object)', () => {
    const attribution: BrokerConsumerAttribution = { kind: 'webrtc-browser', label: 'alice' }
    const input = { deviceId: 1, consumerAttribution: attribution }
    const out = enrichInputWithUserAgent(input, 'Chrome/120')
    expect(out.consumerAttribution).toEqual({
      kind: 'webrtc-browser',
      label: 'alice',
      userAgent: 'Chrome/120',
    })
    // Immutability: the original attribution is untouched.
    expect(attribution.userAgent).toBeUndefined()
  })

  it('defaults to webrtc-browser when no attribution was supplied', () => {
    const out = enrichInputWithUserAgent(session(), 'Firefox/121')
    expect(out.consumerAttribution).toEqual({ kind: 'webrtc-browser', userAgent: 'Firefox/121' })
  })

  it('OVERWRITES a client-supplied userAgent (never trust the client)', () => {
    const input = {
      deviceId: 1,
      consumerAttribution: { kind: 'webrtc-browser', userAgent: 'spoofed' } as const,
    }
    const out = enrichInputWithUserAgent(input, 'Safari/17')
    expect(out.consumerAttribution?.userAgent).toBe('Safari/17')
  })
})

describe('wrapWebrtcSessionProviderWithRelay — UA enrichment', () => {
  function mockProvider(): WebrtcSessionProvider {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's', sdpOffer: 'o' })
    const handleOffer = vi.fn().mockResolvedValue({ sessionId: 's', sdpAnswer: 'a' })
    const passthrough = vi.fn().mockResolvedValue(undefined)
    return {
      createSession,
      handleOffer,
      listStreams: vi.fn().mockResolvedValue([]),
      handleAnswer: passthrough,
      addIceCandidate: passthrough,
      getIceCandidates: vi.fn().mockResolvedValue({ candidates: [], done: true }),
      closeSession: passthrough,
      hasAdaptiveBitrate: vi.fn().mockResolvedValue(false),
      getSessionState: vi.fn().mockResolvedValue({ pendingRenegotiation: null }),
      getSessionDebug: vi.fn().mockResolvedValue(null),
      applyDownlinkProbe: vi
        .fn()
        .mockResolvedValue({ outcome: 'switching', tier: 'high', reason: 'downlink' }),
    }
  }

  function ctxWith(userAgent?: string): TrpcContext {
    return { user: null, req: reqWithUa(userAgent) }
  }

  it('injects the request UA into createSession attribution', async () => {
    const provider = mockProvider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(provider, ctxWith('Edg/120'))

    await wrapped.createSession({ deviceId: 1, target: { kind: 'adaptive' } })

    expect(provider.createSession).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(provider.createSession).mock.calls[0]![0]
    expect(arg.consumerAttribution).toEqual({ kind: 'webrtc-browser', userAgent: 'Edg/120' })
  })

  it('injects the request UA into handleOffer attribution', async () => {
    const provider = mockProvider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(provider, ctxWith('CriOS/120'))

    await wrapped.handleOffer({ deviceId: 1, sdpOffer: 'x' })

    const arg = vi.mocked(provider.handleOffer).mock.calls[0]![0]
    expect(arg.consumerAttribution).toEqual({ kind: 'webrtc-browser', userAgent: 'CriOS/120' })
  })

  it('strips talkback from a request-bound handleOffer — a browser cannot reach the speaker this way (D771)', async () => {
    const provider = mockProvider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(provider, ctxWith('Chrome/120'))

    await wrapped.handleOffer({ deviceId: 1, sdpOffer: 'x', talkback: true })

    const arg = vi.mocked(provider.handleOffer).mock.calls[0]![0]
    expect(arg.talkback).toBeUndefined()
  })

  it('keeps talkback on a mesh-originated handleOffer (the Alexa export)', () => {
    const input = { deviceId: 1, sdpOffer: 'x', talkback: true }
    expect(stripTalkbackFromRequest(input, null)).toBe(input)
  })

  it('overwrites a client-supplied UA on createSession', async () => {
    const provider = mockProvider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(provider, ctxWith('TrustedUA/1'))

    await wrapped.createSession({
      deviceId: 1,
      target: { kind: 'adaptive' },
      consumerAttribution: { kind: 'webrtc-browser', userAgent: 'spoofed', label: 'bob' },
    })

    const arg = vi.mocked(provider.createSession).mock.calls[0]![0]
    expect(arg.consumerAttribution).toEqual({
      kind: 'webrtc-browser',
      label: 'bob',
      userAgent: 'TrustedUA/1',
    })
  })

  it('does not alter the call when no UA header is present', async () => {
    const provider = mockProvider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(provider, ctxWith(undefined))

    await wrapped.createSession({ deviceId: 1, target: { kind: 'adaptive' } })

    const arg = vi.mocked(provider.createSession).mock.calls[0]![0]
    expect(arg.consumerAttribution).toBeUndefined()
  })

  it('delegates other methods straight through', async () => {
    const provider = mockProvider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(provider, ctxWith('Chrome/120'))

    await wrapped.closeSession({ deviceId: 1, sessionId: 's' })
    expect(provider.closeSession).toHaveBeenCalledWith({ deviceId: 1, sessionId: 's' })
  })

  it('delegates applyDownlinkProbe (D733) untouched — a measurement, nothing to enrich', async () => {
    const provider = mockProvider()
    const wrapped = wrapWebrtcSessionProviderWithRelay(provider, ctxWith('Chrome/120'))

    const answer = await wrapped.applyDownlinkProbe({
      deviceId: 1,
      sessionId: 's',
      downlinkMbps: 11,
    })
    expect(provider.applyDownlinkProbe).toHaveBeenCalledWith({
      deviceId: 1,
      sessionId: 's',
      downlinkMbps: 11,
    })
    expect(answer).toEqual({ outcome: 'switching', tier: 'high', reason: 'downlink' })
  })
})

/**
 * `enrichInputWithRelayClass` gates the remote→relay injection behind the
 * `CAMSTACK_FORCE_RELAY_REMOTE` env flag (DEFAULT OFF). The forced-relay MEDIA
 * path was never validated to deliver media (connected-but-black, disabled
 * 2026-05-26; the werift candidate-leak patch fixed a DIFFERENT bug), so with
 * the flag OFF every class gets `relayOnly:false` while the class is STILL
 * computed for broker pairClass logging. With the flag ON, `remote → true`.
 *
 * The flag is read into a MODULE-LEVEL const at import time, so each case
 * stubs the env then `vi.resetModules()` + dynamic-imports a fresh copy of the
 * router module.
 */
describe('enrichInputWithRelayClass — remote relay gate (CAMSTACK_FORCE_RELAY_REMOTE)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function loadEnrich(flag: string | undefined) {
    vi.resetModules()
    // '' models an unset / falsy flag (default OFF); a concrete string models
    // the operator having exported it.
    vi.stubEnv('CAMSTACK_FORCE_RELAY_REMOTE', flag ?? '')
    const mod = await import('../trpc.router.js')
    return mod.enrichInputWithRelayClass
  }

  it('flag OFF (default): remote class → relayOnly:false (class computed, NOT forced)', async () => {
    const enrich = await loadEnrich(undefined)
    expect(enrich(session(), 'remote')).toEqual({ deviceId: 1, relayOnly: false })
  })

  it('flag OFF: vpn and lan → relayOnly:false', async () => {
    const enrich = await loadEnrich(undefined)
    expect(enrich(session(), 'vpn').relayOnly).toBe(false)
    expect(enrich(session(), 'lan').relayOnly).toBe(false)
  })

  it('flag OFF: mesh-originated (null class) passes input through untouched', async () => {
    const enrich = await loadEnrich(undefined)
    const input = { deviceId: 1, relayOnly: true }
    // Trusted addon-set relayOnly (e.g. Alexa) must not be clobbered.
    expect(enrich(input, null)).toBe(input)
  })

  it('flag ON (=1): remote class → relayOnly:true', async () => {
    const enrich = await loadEnrich('1')
    expect(enrich(session(), 'remote').relayOnly).toBe(true)
  })

  it('flag ON (=true): remote → true; vpn and lan stay false', async () => {
    const enrich = await loadEnrich('true')
    expect(enrich(session(), 'remote').relayOnly).toBe(true)
    expect(enrich(session(), 'vpn').relayOnly).toBe(false)
    expect(enrich(session(), 'lan').relayOnly).toBe(false)
  })

  it('flag with an unrelated value (=yes) → treated as OFF (only 1/true enable)', async () => {
    const enrich = await loadEnrich('yes')
    expect(enrich(session(), 'remote').relayOnly).toBe(false)
  })
})

/**
 * `enrichHintsWithClientClass` biases the INITIAL adaptive tier for a
 * genuinely-remote viewer by injecting `hints.prefersTier='low'` — the hub is
 * the only layer that knows the client's network class, and it threads it down
 * through the EXISTING `hints` cap field (no cap change). Only `remote` +
 * adaptive is biased; `lan`/`vpn`, pinned targets, and a caller-set prefersTier
 * pass through untouched. Immutable.
 */
describe('enrichHintsWithClientClass — remote adaptive tier bias', () => {
  it('remote + adaptive target does not inject prefersTier (bandwidth / default-low decide)', () => {
    const input = { deviceId: 1, target: { kind: 'adaptive' } as const }
    expect(enrichHintsWithClientClass(input, 'remote')).toBe(input)
  })

  it('remote + absent target does not inject prefersTier', () => {
    const input: HandleOfferInput = { deviceId: 1, sdpOffer: 'x' }
    expect(enrichHintsWithClientClass(input, 'remote')).toBe(input)
  })

  it('remote + existing viewport hints are untouched', () => {
    const input = {
      deviceId: 1,
      target: { kind: 'adaptive' } as const,
      hints: { viewportWidth: 320 },
    }
    expect(enrichHintsWithClientClass(input, 'remote')).toBe(input)
  })

  it('lan → passes through untouched (full-quality default)', () => {
    const input = { deviceId: 1, target: { kind: 'adaptive' } as const }
    expect(enrichHintsWithClientClass(input, 'lan')).toBe(input)
  })

  it('vpn (Tailscale) → passes through untouched', () => {
    const input = { deviceId: 1, target: { kind: 'adaptive' } as const }
    expect(enrichHintsWithClientClass(input, 'vpn')).toBe(input)
  })

  it('null class (mesh-originated) → passes through untouched', () => {
    const input = { deviceId: 1, target: { kind: 'adaptive' } as const }
    expect(enrichHintsWithClientClass(input, null)).toBe(input)
  })

  it('remote + PINNED profile target → not biased (operator choice honoured)', () => {
    const input = { deviceId: 1, target: { kind: 'profile', profile: 'high' } as const }
    expect(enrichHintsWithClientClass(input, 'remote')).toBe(input)
  })

  it('remote + cam-stream target → not biased', () => {
    const input = {
      deviceId: 1,
      target: { kind: 'cam-stream', camStreamId: 'native:main' } as const,
    }
    expect(enrichHintsWithClientClass(input, 'remote')).toBe(input)
  })

  it('remote but caller already set prefersTier → not clobbered', () => {
    const input = {
      deviceId: 1,
      target: { kind: 'adaptive' } as const,
      hints: { prefersTier: 'mid' },
    }
    expect(enrichHintsWithClientClass(input, 'remote')).toBe(input)
  })

  it('immutability: original input + hints are untouched', () => {
    const hints = { viewportWidth: 640 }
    const input = { deviceId: 1, target: { kind: 'adaptive' } as const, hints }
    const out = enrichHintsWithClientClass(input, 'remote')
    expect(out).toBe(input)
    expect(hints).toEqual({ viewportWidth: 640 })
  })
})
