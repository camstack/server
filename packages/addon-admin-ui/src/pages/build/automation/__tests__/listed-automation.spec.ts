/**
 * A linked trigger is a customization of the device it commands: it is shown,
 * created, edited and deleted only on that device's Customize tab. It is still
 * an automation block, so the Automations list, its count and the global
 * search must leave it out rather than offer it as an editable automation.
 */
import {
  builtinAutomationTemplate,
  generateAutomationBlock,
  LINKED_TRIGGER_TEMPLATE_ID,
  linkedTriggerValues,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { expandInstance } from '../../templates/template-values'
import { isListedAutomation, isPlainScript, looksLikeAutomation } from '../recipe-from-code'

function linkedTriggerCode(): string {
  const template = builtinAutomationTemplate(LINKED_TRIGGER_TEMPLATE_ID)
  if (template === undefined) throw new Error('the built-in is gone')
  const block = expandInstance(
    LINKED_TRIGGER_TEMPLATE_ID,
    template.payload,
    linkedTriggerValues({
      targetDeviceId: 5767,
      action: 'toggle',
      sources: [{ kind: 'device-fired', deviceId: 12, eventIds: ['PRESS_SHORT'] }],
    }),
    'Button → light',
    true,
  )
  if (!block.ok) throw new Error(block.problems.map((p) => p.detail).join('; '))
  if (block.input.code === undefined) throw new Error('the instance has no code')
  return block.input.code
}

const ordinary = generateAutomationBlock({
  name: 'Ordinary',
  recipe: {
    actions: [{ kind: 'wait', seconds: 5 }],
    when: {
      kind: 'device-becomes',
      deviceId: 1,
      cap: 'motion',
      fieldPath: 'detected',
      becomes: true,
    },
  },
})

describe('isListedAutomation', () => {
  it('lists an ordinary automation', () => {
    expect(isListedAutomation(ordinary)).toBe(true)
  })

  it('leaves a linked trigger out, though it is an automation and not a script', () => {
    const code = linkedTriggerCode()
    expect(looksLikeAutomation(code)).toBe(true)
    expect(isPlainScript({ code })).toBe(false)
    expect(isListedAutomation(code)).toBe(false)
  })

  it('lists an automation whose recipe cannot be read, so it can be repaired', () => {
    const broken = ordinary.replace('"when"', '"wh en"')
    expect(looksLikeAutomation(broken)).toBe(true)
    expect(isListedAutomation(broken)).toBe(true)
  })
})
