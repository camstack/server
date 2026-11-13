import { describe, expect, it } from 'vitest'
import {
  ActionStepSchema,
  AutomationTemplatePayloadSchema,
  BUILTIN_AUTOMATION_TEMPLATES,
  builtinAutomationTemplate,
  expandAutomationTemplate,
  isBuiltinTemplateId,
  type TemplateGroupRow,
} from '../../index.js'

function payloadOf(id: string) {
  const found = builtinAutomationTemplate(id)
  if (found === undefined) throw new Error(`no built-in ${id}`)
  return found.payload
}

describe('built-in automation templates', () => {
  it('every built-in is a valid payload under a builtin: id', () => {
    for (const template of BUILTIN_AUTOMATION_TEMPLATES) {
      expect(isBuiltinTemplateId(template.id)).toBe(true)
      expect(AutomationTemplatePayloadSchema.safeParse(template.payload).success).toBe(true)
    }
  })

  it('Buttons → devices: two keys of one button drive two switches', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [
        {
          button: 40,
          event: { sourceIds: ['1'], kinds: ['press'] },
          targets: [50],
          action: { actionId: 'switch.on' },
        },
        {
          button: 40,
          event: { sourceIds: ['2'], kinds: ['press'] },
          targets: [51],
          action: { actionId: 'switch.off' },
        },
      ],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recipe.when).toMatchObject({
      kind: 'any',
      children: [{ id: 'buttons-0' }, { id: 'buttons-1' }],
    })
    expect(out.recipe.actions).toHaveLength(1)
  })

  it('Buttons → devices expands a switch.toggle command and the step validates', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [
        {
          button: 5656,
          event: { sourceIds: ['1'], kinds: ['press'] },
          targets: [5767],
          action: { actionId: 'switch.toggle' },
        },
      ],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const choose = out.recipe.actions[0]
    expect(choose).toMatchObject({
      kind: 'choose',
      branches: [
        {
          steps: [
            {
              kind: 'command',
              actionId: 'switch.toggle',
              target: { kind: 'devices', ids: [5767] },
            },
          ],
        },
      ],
    })
    if (choose?.kind !== 'choose') return
    const step = choose.branches[0]?.steps[0]
    expect(ActionStepSchema.safeParse(step).success).toBe(true)
  })

  it('Buttons → devices refuses a seventh row (one choose branch per row)', () => {
    const row: TemplateGroupRow = {
      button: 40,
      event: { kinds: ['press'] },
      targets: [50],
      action: { actionId: 'switch.on' },
    }
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: Array.from({ length: 7 }, () => row),
    })
    expect(out.ok).toBe(false)
  })

  it('Motion → light expands with the default delay', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:motion-light'), {
      sensor: 3,
      lights: [4, 5],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recipe.actions[1]).toEqual({ kind: 'wait', seconds: 300 })
    expect(out.recipe.actions[2]).toMatchObject({
      actionId: 'switch.off',
      target: { kind: 'devices', ids: [4, 5] },
    })
  })
})
