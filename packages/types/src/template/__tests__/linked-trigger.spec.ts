import { describe, expect, it } from 'vitest'
import { linkedTriggerParamsOf, linkedTriggerValues } from '../linked-trigger.js'

describe('linkedTriggerParamsOf', () => {
  it('reads back what linkedTriggerValues wrote', () => {
    const values = linkedTriggerValues({
      targetDeviceId: 5767,
      action: 'toggle',
      sources: [
        { kind: 'device-fired', deviceId: 12, sourceIds: ['1'], eventIds: ['PRESS_SHORT'] },
        { kind: 'device-fired', deviceId: 12, sourceIds: ['2'], eventIds: ['PRESS_SHORT'] },
      ],
    })
    expect(linkedTriggerParamsOf(values)).toEqual({
      targetDeviceId: 5767,
      action: 'toggle',
      capability: 'switch',
      sources: [
        { kind: 'device-fired', deviceId: 12, sourceIds: ['1'], eventIds: ['PRESS_SHORT'] },
        { kind: 'device-fired', deviceId: 12, sourceIds: ['2'], eventIds: ['PRESS_SHORT'] },
      ],
    })
  })

  it('keeps a capability whose name has a dot-free id and a non-default cap', () => {
    const values = linkedTriggerValues({
      targetDeviceId: 1,
      action: 'off',
      capability: 'light',
      sources: [{ kind: 'device-event', deviceId: 3, category: 'doorbell' }],
    })
    expect(linkedTriggerParamsOf(values)?.capability).toBe('light')
    expect(linkedTriggerParamsOf(values)?.action).toBe('off')
  })

  it('carries "on for a time", a state source, a detection source and the time window', () => {
    const params = {
      targetDeviceId: 4,
      action: 'on' as const,
      onForSeconds: 300,
      activeWindow: { days: ['sat' as const, 'sun' as const] },
      sources: [
        {
          kind: 'device-becomes' as const,
          deviceId: 3,
          cap: 'motion',
          fieldPath: 'detected',
          becomes: true,
        },
        { kind: 'detection' as const, deviceIds: [9], subjects: [{ macro: 'person' as const }] },
      ],
    }
    const values = linkedTriggerValues(params)
    expect(values['onFor']).toBe(300)
    expect(values['active']).toEqual({ days: ['sat', 'sun'] })
    expect(linkedTriggerParamsOf(values)).toEqual({ ...params, capability: 'switch' })
  })

  it('a plain trigger writes neither a duration nor a window', () => {
    const values = linkedTriggerValues({
      targetDeviceId: 4,
      action: 'on',
      sources: [{ kind: 'device-event', deviceId: 3, category: 'doorbell' }],
    })
    expect(Object.keys(values).sort()).toEqual(['action', 'target', 'when'])
  })

  it('refuses a duration on anything but "on"', () => {
    expect(() =>
      linkedTriggerValues({
        targetDeviceId: 4,
        action: 'toggle',
        onForSeconds: 60,
        sources: [{ kind: 'device-event', deviceId: 3, category: 'doorbell' }],
      }),
    ).toThrow(/can be held for a time/)
  })

  it('answers null for values it cannot read rather than guessing', () => {
    expect(linkedTriggerParamsOf({})).toBeNull()
    expect(
      linkedTriggerParamsOf({ target: 1, action: { actionId: 'switch.dim' }, when: [] }),
    ).toBeNull()
    expect(
      linkedTriggerParamsOf({
        target: 1,
        action: { actionId: 'switch.on' },
        when: [{ kind: 'stationary', deviceIds: [2], phase: 'appeared' }],
      }),
    ).toBeNull()
  })
})

describe('the device-state limit ("only while night")', () => {
  const night = {
    deviceId: 77,
    cap: 'binary',
    fieldPath: 'on',
    operator: 'eq' as const,
    value: false,
  }
  const base = {
    targetDeviceId: 4,
    action: 'on' as const,
    sources: [{ kind: 'device-event' as const, deviceId: 3, category: 'doorbell' }],
  }

  it('round-trips as the activeWhen parameter and the activeWhen input', () => {
    const values = linkedTriggerValues({ ...base, activeWhen: night })
    expect(values['activeWhen']).toEqual(night)
    expect(linkedTriggerParamsOf(values)?.activeWhen).toEqual(night)
  })

  it('a trigger without it writes no activeWhen input', () => {
    expect(Object.keys(linkedTriggerValues(base))).not.toContain('activeWhen')
  })
})
