/**
 * Every proactive event body carries the user's LWA access token in
 * `endpoint.scope.token` (discovery reports: `payload.scope.token`).
 *
 * It used to carry the literal string `replaced-by-authorization-header`, on
 * the assumption — never verified — that Amazon reads only the `Authorization`
 * header. The Event Gateway answers 202 either way, so an assumption that is
 * wrong here is indistinguishable from one that is right: the press posts
 * "successfully" and no Echo announces it. The Smart Home spec puts the bearer
 * token in BOTH places, so we do too, and the ambiguity is gone.
 *
 * The token must also survive the 401 refresh: a body built with the EXPIRED
 * token and retried with a fresh Authorization header would carry a scope
 * token Amazon has already rejected.
 */
import { describe, it, expect } from 'vitest'
import {
  buildAddOrUpdateReportPayload,
  buildDeleteReportPayload,
  buildDoorbellPressPayload,
  buildMotionChangeReportPayload,
  buildSmartVisionObjectDetectionEvent,
} from '../lwa-event-gateway.js'

const ACCESS_TOKEN = 'Atza|real-access-token'
const ts = 1_700_000_000_000

describe('proactive event payloads carry the real access token', () => {
  it('DoorbellPress', () => {
    const p = buildDoorbellPressPayload({
      userId: 'u1',
      endpointId: '101',
      timestamp: ts,
      accessToken: ACCESS_TOKEN,
    })
    expect(p.event.header.namespace).toBe('Alexa.DoorbellEventSource')
    expect(p.event.header.name).toBe('DoorbellPress')
    expect(p.event.endpoint.scope.token).toBe(ACCESS_TOKEN)
    expect(p.event.endpoint.endpointId).toBe('101')
  })

  it('MotionSensor ChangeReport', () => {
    const p = buildMotionChangeReportPayload({
      userId: 'u1',
      endpointId: '101',
      detected: true,
      timestamp: ts,
      accessToken: ACCESS_TOKEN,
    })
    expect(p.event.endpoint.scope.token).toBe(ACCESS_TOKEN)
  })

  it('SmartVision ObjectDetection', () => {
    const p = buildSmartVisionObjectDetectionEvent({
      userId: 'u1',
      endpointId: '101',
      detections: [{ eventIdentifier: 'e1', imageNetClass: 'person' }],
      timestamp: ts,
      accessToken: ACCESS_TOKEN,
    })
    expect(p.event.endpoint.scope.token).toBe(ACCESS_TOKEN)
  })

  it('Discovery AddOrUpdateReport', () => {
    const p = buildAddOrUpdateReportPayload('u1', [], ACCESS_TOKEN)
    expect(p.event.payload.scope.token).toBe(ACCESS_TOKEN)
  })

  it('Discovery DeleteReport', () => {
    const p = buildDeleteReportPayload('u1', ['101'], ACCESS_TOKEN)
    expect(p.event.payload.scope.token).toBe(ACCESS_TOKEN)
  })

  it('never leaks the old placeholder', () => {
    const bodies = [
      JSON.stringify(
        buildDoorbellPressPayload({
          userId: 'u1',
          endpointId: '101',
          timestamp: ts,
          accessToken: ACCESS_TOKEN,
        }),
      ),
      JSON.stringify(buildAddOrUpdateReportPayload('u1', [], ACCESS_TOKEN)),
    ]
    for (const body of bodies) expect(body).not.toContain('replaced-by-authorization-header')
  })
})
