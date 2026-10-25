/**
 * Authoring rules for a rule's actions (shared-sequence shape).
 */

import type { NcRuleActions, NcSharedSequence } from '@camstack/types'
import { DeviceType, NotificationActionIconSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  actionsToForm,
  EMPTY_RULE_ACTIONS,
  formToActions,
  NC_ACTION_ICON_OPTIONS,
  ruleActionPresets,
  SIREN_PRESET_SECONDS,
  validateRuleActions,
  withPresetOnTrigger,
} from '../notification-rule-actions'

const SEQ: NcSharedSequence = {
  id: 'seq-1',
  name: 'open-gate',
  minDelaySec: 30,
  actions: [
    { kind: 'cap', deviceId: 7, cap: 'lock', method: 'unlock' },
    { kind: 'wait', seconds: 5 },
  ],
}

describe('an untouched rule round-trips', () => {
  it('emits undefined for an empty form, so the stored block is preserved', () => {
    expect(formToActions(EMPTY_RULE_ACTIONS)).toBeUndefined()
  })

  it('reads an absent actions block as empty rather than as a change', () => {
    expect(actionsToForm(undefined)).toEqual(EMPTY_RULE_ACTIONS)
  })

  it('carries every field of a stored block back out unchanged', () => {
    const stored: NcRuleActions = {
      onTrigger: [{ kind: 'sequence', sequenceId: 'seq-1' }],
      onTriggerOff: [{ kind: 'do', action: { kind: 'wait', seconds: 1 } }],
      buttons: [{ id: 'open', label: 'Open', sequenceId: 'seq-1', icon: 'unlock' }],
    }
    expect(formToActions(actionsToForm(stored))).toEqual(stored)
  })
})

describe('a button that could never appear is refused here', () => {
  it('flags a button naming a sequence that does not exist', () => {
    const problems = validateRuleActions(
      {
        ...EMPTY_RULE_ACTIONS,
        buttons: [{ id: 'x', label: 'X', sequenceId: 'typo' }],
      },
      new Set(['seq-1']),
    )
    expect(problems.map((p) => p.kind)).toContain('unknown-sequence')
  })

  it('accepts a button pointing at a known sequence', () => {
    const problems = validateRuleActions(
      {
        ...EMPTY_RULE_ACTIONS,
        buttons: [{ id: 'x', label: 'X', sequenceId: 'seq-1' }],
      },
      new Set(['seq-1']),
    )
    expect(problems).toEqual([])
  })
})

describe('presets', () => {
  const DEVICES = [
    { id: 1023, name: 'Alarm', type: DeviceType.AlarmPanel },
    { id: 44, name: 'Sirena', type: DeviceType.Siren },
    { id: 102, name: 'Cancello', type: DeviceType.Camera },
  ]

  it('offers only what this hub can actually actuate', () => {
    expect(ruleActionPresets(DEVICES).map((p) => p.id)).toEqual(['trigger-alarm', 'siren-44'])
  })

  it('builds the alarm sequence with the four facts that live in a cap file', () => {
    const preset = ruleActionPresets(DEVICES).find((p) => p.id === 'trigger-alarm')
    expect(preset?.build()).toEqual({
      name: 'trigger the alarm',
      actions: [{ kind: 'cap', deviceId: 1023, cap: 'alarm-panel', method: 'trigger', args: {} }],
    })
  })

  it('the siren turns itself back OFF, and carries its own budget', () => {
    const sequence = ruleActionPresets(DEVICES)
      .find((p) => p.id === 'siren-44')
      ?.build()
    expect(sequence?.actions).toEqual([
      { kind: 'cap', deviceId: 44, cap: 'switch', method: 'setState', args: { on: true } },
      { kind: 'wait', seconds: SIREN_PRESET_SECONDS },
      { kind: 'cap', deviceId: 44, cap: 'switch', method: 'setState', args: { on: false } },
    ])
    expect(sequence?.minDelaySec).toBe(60)
  })

  it('binds a created sequence id onto onTrigger', () => {
    const next = withPresetOnTrigger(EMPTY_RULE_ACTIONS, SEQ.id)
    expect(next.onTrigger).toEqual([{ kind: 'sequence', sequenceId: 'seq-1' }])
  })
})

describe('NC_ACTION_ICON_OPTIONS', () => {
  it('offers EVERY icon in the closed vocabulary', () => {
    const offered = new Set(NC_ACTION_ICON_OPTIONS.map((o) => o.value))
    const missing = NotificationActionIconSchema.options.filter((v) => !offered.has(v))
    expect(missing, 'icon tokens the operator cannot pick').toEqual([])
  })
})
