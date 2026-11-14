import { describe, expect, it } from 'vitest'
import {
  ActionStepSchema,
  AutomationTemplateLinkSchema,
  AutomationTemplatePayloadSchema,
  BUILTIN_AUTOMATION_TEMPLATES,
  builtinAutomationTemplate,
  expandAutomationTemplate,
  instantiateAutomationTemplate,
  isBuiltinTemplateId,
  reexpandAutomationInstance,
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
          events: [{ button: 40, event: { sourceIds: ['1'], kinds: ['press'] } }],
          commands: [{ targets: [50], action: { actionId: 'switch.on' } }],
        },
        {
          events: [{ button: 40, event: { sourceIds: ['2'], kinds: ['press'] } }],
          commands: [{ targets: [51], action: { actionId: 'switch.off' } }],
        },
      ],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recipe.when).toMatchObject({
      kind: 'any',
      children: [{ id: 'buttons-0-events-0' }, { id: 'buttons-1-events-0' }],
    })
    expect(out.recipe.actions).toHaveLength(1)
  })

  it('Buttons → devices: a row with two events of two devices and two actions is two leaves and one branch', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [
        {
          events: [
            {
              button: 40,
              event: { sourceIds: ['1'], eventIds: ['press_short'] },
            },
            { button: 41, event: { kinds: ['long-press'] } },
          ],
          commands: [
            { targets: [50], action: { actionId: 'switch.toggle' } },
            { targets: [51, 52], action: { actionId: 'switch.off' } },
          ],
        },
      ],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recipe.when).toEqual({
      kind: 'any',
      children: [
        {
          kind: 'device-fired',
          id: 'buttons-0-events-0',
          deviceId: 40,
          sourceIds: ['1'],
          eventIds: ['press_short'],
        },
        {
          kind: 'device-fired',
          id: 'buttons-0-events-1',
          deviceId: 41,
          kinds: ['long-press'],
        },
      ],
    })
    const choose = out.recipe.actions[0]
    expect(choose).toMatchObject({
      kind: 'choose',
      branches: [
        {
          if: {
            kind: 'triggered-by',
            leafIds: ['buttons-0-events-0', 'buttons-0-events-1'],
          },
          steps: [
            {
              kind: 'command',
              actionId: 'switch.toggle',
              target: { kind: 'devices', ids: [50] },
            },
            {
              kind: 'command',
              actionId: 'switch.off',
              target: { kind: 'devices', ids: [51, 52] },
            },
          ],
        },
      ],
    })
    if (choose?.kind !== 'choose') return
    expect(choose.branches).toHaveLength(1)
    for (const step of choose.branches[0]?.steps ?? []) {
      expect(ActionStepSchema.safeParse(step).success).toBe(true)
    }
  })

  it('Buttons → devices names a missing value of a nested row by its address', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [
        {
          events: [{ button: 40, event: { kinds: ['press'] } }],
          commands: [
            { targets: [50], action: { actionId: 'switch.on' } },
            { action: { actionId: 'switch.off' } },
          ],
        },
      ],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems).toEqual([
      expect.objectContaining({
        code: 'missing-input',
        input: 'buttons.0.commands.1.targets',
      }),
    ])
  })

  it('Buttons → devices refuses a row with no action', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [
        {
          events: [{ button: 40, event: { kinds: ['press'] } }],
          commands: [],
        },
      ],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems).toEqual([
      expect.objectContaining({
        code: 'missing-input',
        input: 'buttons.0.commands',
      }),
    ])
  })

  it('Buttons → devices: a new instance keeps its link and re-expands to the same body', () => {
    const values = {
      buttons: [
        {
          events: [{ button: 40, event: { kinds: ['press' as const] } }],
          commands: [{ targets: [50], action: { actionId: 'switch.on' } }],
        },
      ],
    }
    const payload = payloadOf('builtin:buttons-to-devices')
    const made = instantiateAutomationTemplate('builtin:buttons-to-devices', payload, values)
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(AutomationTemplateLinkSchema.safeParse(made.recipe.template).success).toBe(true)
    const again = reexpandAutomationInstance(payload, made.recipe)
    expect(again.flagged).toBe(false)
    expect(again.recipe).toEqual(made.recipe)
  })

  it('Buttons → devices refuses a seventh row (one choose branch per row)', () => {
    const row: TemplateGroupRow = {
      events: [{ button: 40, event: { kinds: ['press'] } }],
      commands: [{ targets: [50], action: { actionId: 'switch.on' } }],
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
