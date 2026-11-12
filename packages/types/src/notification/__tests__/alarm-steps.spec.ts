import { describe, expect, it } from 'vitest'
import type { ActionStep } from '../../automation/recipe.js'
import { CAP_VOCABULARY_BY_NAME } from '../../device/cap-vocabulary/vocabulary.js'
import {
  NC_ALARM_PANEL_ACTION_IDS,
  NC_ALARM_TRIGGER_ACTION_ID,
  stepActuatesAlarmPanel,
  stepPullsAlarmTrigger,
} from '../alarm-steps.js'

const step = (actionId: string): ActionStep => ({
  kind: 'command',
  target: { kind: 'devices', ids: [3] },
  actionId,
})

const alarmActions = () => CAP_VOCABULARY_BY_NAME['alarm-panel']?.actions ?? []

describe('alarm steps — the one rule for a step on the alarm panel', () => {
  it('lists exactly the vocabulary actions of the alarm-panel cap', () => {
    expect([...NC_ALARM_PANEL_ACTION_IDS].sort()).toEqual(
      alarmActions()
        .map((a) => a.id)
        .sort(),
    )
  })

  it('names the one action whose method is the panel trigger', () => {
    const trigger = alarmActions().filter((a) => a.method === 'trigger')
    expect(trigger.map((a) => a.id)).toEqual([NC_ALARM_TRIGGER_ACTION_ID])
  })

  it('reads a command step by action id, never a wait or another cap', () => {
    expect(stepActuatesAlarmPanel(step('alarm.arm.night'))).toBe(true)
    expect(stepActuatesAlarmPanel(step('switch.on'))).toBe(false)
    expect(stepActuatesAlarmPanel({ kind: 'wait', seconds: 1 })).toBe(false)
    expect(stepPullsAlarmTrigger(step('alarm.trigger'))).toBe(true)
    expect(stepPullsAlarmTrigger(step('alarm.disarm'))).toBe(false)
  })
})
