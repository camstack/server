import { describe, it, expect } from 'vitest'
import { buildMotionChangeReportPayload } from '../lwa-event-gateway.js'

describe('buildMotionChangeReportPayload', () => {
  const ts = 1_700_000_000_000

  it('builds an Alexa.MotionSensor ChangeReport with DETECTED state', () => {
    const p = buildMotionChangeReportPayload({
      userId: 'u1',
      endpointId: '42',
      detected: true,
      timestamp: ts,
      accessToken: 'tok',
    })
    expect(p.event.header.namespace).toBe('Alexa')
    expect(p.event.header.name).toBe('ChangeReport')
    expect(p.event.endpoint.endpointId).toBe('42')
    const prop = p.event.payload.change.properties[0]!
    expect(prop.namespace).toBe('Alexa.MotionSensor')
    expect(prop.name).toBe('detectionState')
    expect(prop.value).toBe('DETECTED')
    expect(prop.timeOfSample).toBe(new Date(ts).toISOString())
  })

  it('reports NOT_DETECTED when motion clears', () => {
    const p = buildMotionChangeReportPayload({
      userId: 'u1',
      endpointId: '42',
      detected: false,
      timestamp: ts,
      accessToken: 'tok',
    })
    expect(p.event.payload.change.properties[0]!.value).toBe('NOT_DETECTED')
  })
})
