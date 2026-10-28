import { describe, expect, it } from 'vitest'
import { evaluateStationaryTrigger, type StationaryTrigger } from '../stationary-trigger.js'

const event = (over: Record<string, unknown> = {}) => ({
  deviceId: 7,
  entryId: 'e1',
  className: 'car',
  phase: 'appeared',
  zones: ['drive'],
  ...over,
})

const trigger: StationaryTrigger = {
  kind: 'stationary',
  deviceIds: [7],
  phase: 'appeared',
}

describe('evaluateStationaryTrigger', () => {
  it('fires on the wanted phase and exposes deviceId, className, zones, phase, entryId', () => {
    const d = evaluateStationaryTrigger(trigger, event())
    expect(d.kind).toBe('fire')
    expect(d.kind === 'fire' && d.vars).toEqual({
      deviceId: 7,
      className: 'car',
      zones: ['drive'],
      phase: 'appeared',
      entryId: 'e1',
    })
  })

  it('ignores the other phase, another device and a malformed event without a trace', () => {
    expect(evaluateStationaryTrigger(trigger, event({ phase: 'departed' })).kind).toBe('ignore')
    expect(evaluateStationaryTrigger(trigger, event({ deviceId: 8 })).kind).toBe('ignore')
    expect(evaluateStationaryTrigger(trigger, event({ deviceId: 'x' })).kind).toBe('ignore')
    expect(evaluateStationaryTrigger(trigger, event({ phase: 'moved' })).kind).toBe('ignore')
  })

  it('a departed trigger fires on departed only', () => {
    const t: StationaryTrigger = { ...trigger, phase: 'departed' }
    expect(evaluateStationaryTrigger(t, event({ phase: 'departed' })).kind).toBe('fire')
    expect(evaluateStationaryTrigger(t, event()).kind).toBe('ignore')
  })

  it('classes: a macro class matches its raw classes, a mismatch is rejected with a reason', () => {
    const t: StationaryTrigger = { ...trigger, classes: ['vehicle'] }
    expect(evaluateStationaryTrigger(t, event({ className: 'truck' })).kind).toBe('fire')
    const miss = evaluateStationaryTrigger(t, event({ className: 'person' }))
    expect(miss.kind).toBe('reject')
    expect(miss.kind === 'reject' && miss.reason).toContain('person')
  })

  it('zones: at least one must match; none, or a producer that sent none, is rejected', () => {
    const t: StationaryTrigger = { ...trigger, zones: ['drive', 'garage'] }
    expect(evaluateStationaryTrigger(t, event({ zones: ['garage'] })).kind).toBe('fire')
    expect(evaluateStationaryTrigger(t, event({ zones: ['lawn'] })).kind).toBe('reject')
    expect(evaluateStationaryTrigger(t, event({ zones: [] })).kind).toBe('reject')
    expect(evaluateStationaryTrigger(t, event({ zones: undefined })).kind).toBe('reject')
  })

  it('no zone filter fires whatever the zones', () => {
    expect(evaluateStationaryTrigger(trigger, event({ zones: [] })).kind).toBe('fire')
  })
})
