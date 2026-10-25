/**
 * R0 / D771 — two-way audio. The Echo's microphone reaches the camera speaker
 * only when the camera has `intercom` AND the linked user may control it; the
 * broker is told so with `talkback` on `webrtcSession.handleOffer`.
 */
import type { AddonContext } from '@camstack/types'
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
