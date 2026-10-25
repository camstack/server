/**
 * R0 — a doorbell press that opens live view on an Echo Show.
 *
 * Amazon (alexa-doorbelleventsource, about-alexa-rtc): an endpoint that has
 * BOTH `Alexa.DoorbellEventSource` and `Alexa.RTCSessionController` gets the
 * automatic Echo Show live view on a `DoorbellPress`, provided the user turned
 * on "Doorbell Press announcements" for that device in the Alexa app. This
 * pins every part of that on our side: the endpoint shape (CAMERA listed
 * FIRST, then DOORBELL; the event source proactively reported) and the press
 * payload (PHYSICAL_INTERACTION, ISO timestamp, the user's token in scope, a
 * unique message id).
 */
import { describe, expect, it } from 'vitest'
import { buildParentCameraEndpoint } from '../endpoints/builder.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import { buildDoorbellPressPayload, buildMotionChangeReportPayload } from '../lwa-event-gateway.js'

describe('doorbell → Echo Show live view', () => {
  const endpoint = buildParentCameraEndpoint({
    deviceId: 101,
    stableId: 's',
    friendlyName: 'Front door',
    isDoorbell: true,
    hasIntercom: true,
    hasMotion: true,
    ptzPresetNames: [],
    hasPtz: false,
  })

  it('declares the doorbell event source next to RTC, CAMERA first', () => {
    expect(endpoint.displayCategories).toEqual(['CAMERA', 'DOORBELL'])
    const interfaces = endpoint.capabilities.map((c) => c.interface)
    expect(interfaces).toContain('Alexa.RTCSessionController')
    expect(
      endpoint.capabilities.find((c) => c.interface === 'Alexa.DoorbellEventSource'),
    ).toMatchObject({
      version: '3',
      proactivelyReported: true,
    })
    expect(validateAlexaEndpoint(endpoint)).toEqual([])
  })

  it('posts a DoorbellPress Amazon accepts', () => {
    const p = buildDoorbellPressPayload({
      userId: 'u',
      endpointId: '101',
      timestamp: Date.UTC(2026, 9, 8, 12, 0, 0),
      accessToken: 'tok',
    })
    expect(p.event.header).toMatchObject({
      namespace: 'Alexa.DoorbellEventSource',
      name: 'DoorbellPress',
      payloadVersion: '3',
    })
    expect(p.event.payload).toEqual({
      cause: { type: 'PHYSICAL_INTERACTION' },
      timestamp: '2026-10-08T12:00:00.000Z',
    })
    expect(p.event.endpoint).toEqual({
      scope: { type: 'BearerToken', token: 'tok' },
      endpointId: '101',
    })
  })

  it('every event carries a unique (UUID) message id — two presses in the same millisecond are two events', () => {
    const a = buildDoorbellPressPayload({
      userId: 'u',
      endpointId: '1',
      timestamp: 1,
      accessToken: 't',
    })
    const b = buildDoorbellPressPayload({
      userId: 'u',
      endpointId: '1',
      timestamp: 1,
      accessToken: 't',
    })
    expect(a.event.header.messageId).not.toBe(b.event.header.messageId)
    expect(a.event.header.messageId).toMatch(/^[0-9a-f-]{36}$/)
    const m = buildMotionChangeReportPayload({
      userId: 'u',
      endpointId: '1',
      detected: true,
      timestamp: 1,
      accessToken: 't',
    })
    expect(m.event.header.messageId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
