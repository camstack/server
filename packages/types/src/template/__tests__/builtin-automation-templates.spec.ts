import { describe, expect, it } from 'vitest'
import {
  AutomationTemplateLinkSchema,
  AutomationTemplatePayloadSchema,
  BUILTIN_AUTOMATION_TEMPLATES,
  builtinAutomationTemplate,
  expandAutomationTemplate,
  instantiateAutomationTemplate,
  isBuiltinTemplateId,
  reexpandAutomationInstance,
  type TemplateGroupRow,
  type TemplateInputValues,
  type TemplateTimeWindowValue,
} from '../../index.js'
import { ConditionMirror, evaluateWhenTree } from '../../automation/condition-eval.js'
import type { TimeSite } from '../../time/time-spec.js'

const FIRED = { kind: 'device-fired', deviceId: 5656, sourceIds: ['1'], eventIds: ['press_short'] }
const STEP = { kind: 'command', actionId: 'switch.on', target: { kind: 'devices', ids: [50] } }

/** The operator's: Tasto 1 short press toggles two lights; a second button turns a room's switches off. */
const BUTTONS_2: TemplateInputValues = {
  buttons: [
    {
      when: [FIRED],
      do: [
        { kind: 'command', actionId: 'switch.toggle', target: { kind: 'devices', ids: [6001] } },
        { kind: 'command', actionId: 'switch.toggle', target: { kind: 'devices', ids: [6002] } },
      ],
    },
    {
      when: [
        {
          kind: 'device-fired',
          id: 'btn-b',
          deviceId: 5656,
          sourceIds: ['2'],
          eventIds: ['press_long'],
        },
      ],
      do: [
        {
          kind: 'command',
          actionId: 'switch.off',
          target: { kind: 'domain', deviceType: 'switch', roomId: 'Bagno' },
        },
      ],
    },
  ],
}

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

  it('Buttons → devices: two buttons are one `any` and one branch each, steps verbatim', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), BUTTONS_2)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recipe.when).toEqual({
      kind: 'any',
      children: [
        {
          kind: 'device-fired',
          id: 'buttons-0-when-0',
          deviceId: 5656,
          sourceIds: ['1'],
          eventIds: ['press_short'],
        },
        {
          kind: 'device-fired',
          id: 'btn-b',
          deviceId: 5656,
          sourceIds: ['2'],
          eventIds: ['press_long'],
        },
      ],
    })
    expect(out.recipe.actions).toEqual([
      {
        kind: 'choose',
        branches: [
          {
            if: { kind: 'triggered-by', leafIds: ['buttons-0-when-0'] },
            steps: [
              { kind: 'command', actionId: 'switch.toggle', target: { kind: 'devices', ids: [6001] } },
              { kind: 'command', actionId: 'switch.toggle', target: { kind: 'devices', ids: [6002] } },
            ],
          },
          {
            if: { kind: 'triggered-by', leafIds: ['btn-b'] },
            steps: [
              {
                kind: 'command',
                actionId: 'switch.off',
                target: { kind: 'domain', deviceType: 'switch', roomId: 'Bagno' },
              },
            ],
          },
        ],
      },
    ])
  })

  it('Buttons → devices: a domain-target command is stored and expands unchanged', () => {
    const step = {
      kind: 'command',
      actionId: 'switch.off',
      target: { kind: 'domain', deviceType: 'switch', roomId: 'Bagno' },
    }
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [{ when: [FIRED], do: [step] }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const choose = out.recipe.actions[0]
    expect(choose?.kind === 'choose' ? choose.branches[0]?.steps : undefined).toEqual([step])
  })

  it('Buttons → devices: an entry of a kind the input does not allow is refused', () => {
    const wait = { kind: 'wait', seconds: 5 }
    const manual = { kind: 'manual' }
    const cases = [
      { when: [FIRED], do: [wait], at: 'buttons.0.do' },
      { when: [manual], do: [STEP], at: 'buttons.0.when' },
    ]
    for (const c of cases) {
      const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
        buttons: [{ when: c.when, do: c.do }],
      })
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.problems).toEqual([
        expect.objectContaining({ code: 'invalid-input', input: c.at }),
      ])
    }
  })

  it('Buttons → devices: an entry that is not an automation element is refused', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [{ when: [FIRED], do: [{ kind: 'command', actionId: 'no.such_action' }] }],
    })
    expect(out.ok).toBe(false)
  })

  it('Buttons → devices names a missing list by its address', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      buttons: [{ when: [FIRED], do: [] }],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems).toEqual([
      expect.objectContaining({ code: 'invalid-input', input: 'buttons.0.do' }),
    ])
  })

  it('Buttons → devices: a new instance keeps its link and re-expands to the same body', () => {
    const payload = payloadOf('builtin:buttons-to-devices')
    const made = instantiateAutomationTemplate('builtin:buttons-to-devices', payload, BUTTONS_2)
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(AutomationTemplateLinkSchema.safeParse(made.recipe.template).success).toBe(true)
    const again = reexpandAutomationInstance(payload, made.recipe)
    expect(again.flagged).toBe(false)
    expect(again.recipe).toEqual(made.recipe)
  })

  it('Buttons → devices refuses a seventh row (one choose branch per row)', () => {
    const row: TemplateGroupRow = { when: [FIRED], do: [STEP] }
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

describe('built-in automation templates: the optional "Only when" window', () => {
  const ROME: TimeSite = { lat: 41.9028, lon: 12.4964, timeZone: 'Europe/Rome' }
  const nightWeekdays: TemplateTimeWindowValue = {
    between: { from: { kind: 'clock', hh: 22, mm: 0 }, to: { kind: 'clock', hh: 6, mm: 0 } },
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  }
  const buttons: TemplateInputValues = { buttons: [{ when: [FIRED], do: [STEP] }] }
  const motion: TemplateInputValues = { sensor: 3, lights: [4, 5] }

  /** The built-in as it was before the window existed: no input, no gate. */
  function withoutWindow(id: string) {
    const payload = payloadOf(id)
    return {
      ...payload,
      inputs: payload.inputs.filter((input) => input.kind !== 'time-window'),
      bindings: payload.bindings.filter((binding) => binding.kind !== 'gate'),
    }
  }

  it('left empty, both built-ins expand to the very body they had without it', () => {
    const cases: readonly (readonly [string, TemplateInputValues])[] = [
      ['builtin:buttons-to-devices', buttons],
      ['builtin:motion-light', motion],
    ]
    for (const [id, values] of cases) {
      const out = expandAutomationTemplate(payloadOf(id), values)
      const bare = expandAutomationTemplate(withoutWindow(id), values)
      expect(out.ok && bare.ok).toBe(true)
      if (!out.ok || !bare.ok) return
      expect(JSON.stringify(out.recipe)).toBe(JSON.stringify(bare.recipe))
    }
  })

  it('filled, the tree is all[time-is, <the tree it had>] on both built-ins', () => {
    for (const [id, values] of [
      ['builtin:buttons-to-devices', buttons],
      ['builtin:motion-light', motion],
    ] as const) {
      const bare = expandAutomationTemplate(withoutWindow(id), values)
      const out = expandAutomationTemplate(payloadOf(id), { ...values, active: nightWeekdays })
      expect(out.ok && bare.ok).toBe(true)
      if (!out.ok || !bare.ok) return
      expect(out.recipe.when).toEqual({
        kind: 'all',
        children: [{ kind: 'time-is', ...nightWeekdays }, bare.recipe.when],
      })
      expect(out.recipe.actions).toEqual(bare.recipe.actions)
    }
  })

  it('a button press runs its branch inside the window and nothing outside it', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:buttons-to-devices'), {
      ...buttons,
      active: nightWeekdays,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const mirror = new ConditionMirror([])
    const pressed = { firedPath: 'when.1.0', site: ROME }
    const tuesdayNight = Date.parse('2026-01-13T22:00:00Z')
    const saturdayNight = Date.parse('2026-01-17T22:00:00Z')
    const tuesdayNoon = Date.parse('2026-01-13T11:00:00Z')
    expect(evaluateWhenTree(out.recipe.when, mirror, tuesdayNight, pressed).pass).toBe(true)
    expect(evaluateWhenTree(out.recipe.when, mirror, saturdayNight, pressed).pass).toBe(false)
    expect(evaluateWhenTree(out.recipe.when, mirror, tuesdayNoon, pressed).pass).toBe(false)
    // The branch still knows which leaf started the run, one level further down.
    const [choose] = out.recipe.actions
    if (choose?.kind !== 'choose') throw new Error('expected a choose step')
    const branchIf = choose.branches[0]?.if
    if (branchIf === undefined) throw new Error('expected a guarded branch')
    const guard = evaluateWhenTree(branchIf, mirror, tuesdayNight, {
      site: ROME,
      trigger: { leafId: 'buttons-0-when-0' },
    })
    expect(guard.pass).toBe(true)
  })

  it('a window with neither a time nor a day is refused at its own address', () => {
    const out = expandAutomationTemplate(payloadOf('builtin:motion-light'), {
      ...motion,
      active: { days: [] },
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems).toEqual([
      expect.objectContaining({ code: 'invalid-input', input: 'active' }),
    ])
  })
})
