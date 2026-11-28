/**
 * R0 / D771 — two-way audio. The Echo's microphone reaches the camera speaker
 * only when the camera has `intercom` AND the linked user may control it; the
 * broker is told so with `talkback` on `webrtcSession.handleOffer`.
 */
import type { AddonContext, IScopedLogger } from '@dominevo/types'
import type { AlexaEgressPrewarmPort } from '../egress/alexa-egress-prewarm.js'
import { describe, expect, it, vi } from 'vitest'
import { handleInitiateSessionWithOffer } from '../handlers/rtc-session.js'
import { quietLogger } from './helpers/fake-device-api.js'

const HEADER = {
  namespace: 'Alexa.RTCSessionController',
  name: 'InitiateSessionWithOffer',
  payloadVersion: '3',
  messageId: 'm',
}
const IDENTITY = { userId: 'u', username: 'u', scopes: [] }

async function offerWith(opts: { capNames: string[]; mayTalk: boolean }): Promise<unknown> {
  const handleOffer = vi.fn(async () => ({ sessionId: 's', sdpAnswer: 'v=0' }))
  const ctx = {
    api: {
      deviceManager: {
        getBindings: {
          query: async () => ({ entries: opts.capNames.map((capName) => ({ capName })) }),
        },
      },
      cameraStreams: { pickStream: { query: async () => null } },
      webrtcSession: { handleOffer: { mutate: handleOffer } },
    },
  } as unknown as AddonContext
  await handleInitiateSessionWithOffer(
    HEADER,
    { endpointId: '101' },
    {
      sessionId: 's1',
      offer: { value: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv', format: 'SDP' },
    },
    { ctx, logger: quietLogger, listExposed: () => [] },
    IDENTITY,
    { mayTalk: opts.mayTalk },
  )
  const input = handleOffer.mock.calls[0] as unknown as [{ talkback?: boolean }] | undefined
  return input?.[0]?.talkback
}

describe('Alexa talk-back', () => {
  it('asks the broker for talk-back on an intercom camera the user may control', async () => {
    expect(await offerWith({ capNames: ['intercom'], mayTalk: true })).toBe(true)
  })

  it('never for a user who may only view the camera', async () => {
    expect(await offerWith({ capNames: ['intercom'], mayTalk: false })).toBe(false)
  })

  it('never on a camera without an intercom', async () => {
    expect(await offerWith({ capNames: ['motion'], mayTalk: true })).toBe(false)
  })
})

describe('Alexa rtc-session offer pre-warm and SDP debug log', () => {
  const OFFER = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-pwd:SECRETPWD\r\na=ice-ufrag:abc'
  const ANSWER = 'v=0\r\na=ice-pwd:ANSWERPWD\r\na=fingerprint:sha-256 AA'

  function run(prewarm: AlexaEgressPrewarmPort | undefined, logs: string[]): Promise<unknown> {
    const logger = {
      ...quietLogger,
      withTags: () => logger,
      debug: (_m: string, c?: { meta?: { sdp?: string } }) => {
        if (c?.meta?.sdp) logs.push(c.meta.sdp)
      },
    } as unknown as IScopedLogger
    const ctx = {
      api: {
        deviceManager: { getBindings: { query: async () => ({ entries: [] }) } },
        cameraStreams: { pickStream: { query: async () => null } },
        streamBroker: {
          acquireEgressTranscode: {
            mutate: async () => ({
              camStreamId: 'cs',
              pipelineKey: 'pk',
              encoder: 'x',
              decodeHwAccel: null,
            }),
          },
          releaseEgressTranscode: { mutate: async () => undefined },
        },
        webrtcSession: {
          handleOffer: { mutate: async () => ({ sessionId: 's1', sdpAnswer: ANSWER }) },
        },
      },
    } as unknown as AddonContext
    return handleInitiateSessionWithOffer(
      HEADER,
      { endpointId: '101' },
      { sessionId: 's1', offer: { value: OFFER, format: 'SDP' } },
      { ctx, logger, listExposed: () => [], egressPrewarm: prewarm },
      IDENTITY,
    )
  }

  it('starts the pre-warm on the offer and settles it once the session holds the egress', async () => {
    const onOffer = vi.fn(async () => undefined)
    const onSession = vi.fn(async () => undefined)
    await run({ onOffer, onSession }, [])
    expect(onOffer).toHaveBeenCalledWith(101)
    expect(onSession).toHaveBeenCalledWith(101, 'attached')
  })

  it('logs the offer and the answer SDP with ice-pwd redacted', async () => {
    const logs: string[] = []
    await run(undefined, logs)
    expect(logs).toHaveLength(2)
    expect(logs.join('\n')).not.toContain('SECRETPWD')
    expect(logs.join('\n')).not.toContain('ANSWERPWD')
    expect(logs[0]).toContain('a=ice-pwd:<redacted>')
    expect(logs[0]).toContain('a=ice-ufrag:abc')
    expect(logs[1]).toContain('a=fingerprint:sha-256 AA')
  })
})
