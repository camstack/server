import { describe, expect, it } from 'vitest'
import type { ActionStep } from '../../automation/recipe.js'
import type { NcRuleActions } from '../../capabilities/notification-rules.cap.js'
import {
  NC_ALARM_OPENING_EVENT_KINDS,
  ruleAutoTriggersAlarm,
  ruleBelongsToAlarm,
  sensorTransitionNeverFires,
} from '../alarm-membership.js'

const TRIGGER_STEP: ActionStep = {
  kind: 'command',
  target: { kind: 'devices', ids: [900] },
  actionId: 'alarm.trigger',
}
const ARMED = { deviceState: { deviceId: 900, states: ['Armed_Away'] } }

const ACTIONS_OF = (id: string): readonly ActionStep[] | undefined =>
  id === 'internal:a1' ? [TRIGGER_STEP] : undefined

const onTriggerAction: NcRuleActions = { onTrigger: ['internal:a1'] }

describe('ruleBelongsToAlarm (D630, hoisted for the editors)', () => {
  it('an armed-state gate or an on-match Action that triggers the panel makes a rule the alarm', () => {
    expect(ruleBelongsToAlarm({ conditions: ARMED })).toBe(true)
    expect(
      ruleBelongsToAlarm({ conditions: {}, actions: onTriggerAction, actionStepsOf: ACTIONS_OF }),
    ).toBe(true)
    // Button-only (no onTrigger Action) does not make the rule the alarm.
    expect(
      ruleBelongsToAlarm({
        conditions: {},
        actions: { buttons: [{ id: 'b', label: 'Arm', actionId: 'internal:a1' }] },
        actionStepsOf: ACTIONS_OF,
      }),
    ).toBe(false)
    expect(
      ruleBelongsToAlarm({ conditions: { deviceState: { deviceId: 1, states: ['on'] } } }),
    ).toBe(false)
  })

  it('an Action id without a resolver cannot prove membership', () => {
    expect(ruleBelongsToAlarm({ conditions: {}, actions: onTriggerAction })).toBe(false)
  })
})

describe('ruleAutoTriggersAlarm', () => {
  it('is true only for an armed_* gate — not for an explicit trigger binding alone', () => {
    expect(ruleAutoTriggersAlarm({ conditions: ARMED })).toBe(true)
    expect(
      ruleAutoTriggersAlarm({
        conditions: {},
        actions: onTriggerAction,
        actionStepsOf: ACTIONS_OF,
      }),
    ).toBe(false)
  })
})

describe('sensorTransitionNeverFires (D640 × D630)', () => {
  it('an alarm rule over openings that asks for the clear can never fire', () => {
    expect(
      sensorTransitionNeverFires({
        conditions: { ...ARMED, sensorKinds: ['contact'], sensorTransition: 'cleared' },
      }),
    ).toBe(true)
  })

  it('the raise, a non-alarm rule, or a non-opening kind is fine', () => {
    const base = { ...ARMED, sensorKinds: ['contact'] }
    expect(
      sensorTransitionNeverFires({ conditions: { ...base, sensorTransition: 'raised' } }),
    ).toBe(false)
    expect(
      sensorTransitionNeverFires({
        conditions: { sensorKinds: ['contact'], sensorTransition: 'cleared' },
      }),
    ).toBe(false)
    expect(
      sensorTransitionNeverFires({
        conditions: {
          ...ARMED,
          sensorKinds: ['contact', 'motion-sensor'],
          sensorTransition: 'cleared',
        },
      }),
    ).toBe(false)
    expect(
      sensorTransitionNeverFires({ conditions: { ...ARMED, sensorTransition: 'cleared' } }),
    ).toBe(false)
  })

  it('names the three opening kinds the alarm edge reads', () => {
    expect([...NC_ALARM_OPENING_EVENT_KINDS]).toEqual(['contact', 'cover', 'lock', 'switch'])
  })
})
