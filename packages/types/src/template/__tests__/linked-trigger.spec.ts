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

  it('answers null for values it cannot read rather than guessing', () => {
    expect(linkedTriggerParamsOf({})).toBeNull()
    expect(
      linkedTriggerParamsOf({ target: 1, action: { actionId: 'switch.dim' }, when: [] }),
    ).toBeNull()
    expect(
      linkedTriggerParamsOf({
        target: 1,
        action: { actionId: 'switch.on' },
        when: [{ kind: 'device-becomes', deviceId: 2 }],
      }),
    ).toBeNull()
  })
})
