import { describe, expect, it } from 'vitest'
import {
  AutomationRecipeSchema,
  AutomationTemplatePayloadSchema,
  type AutomationTemplatePayload,
  BUILTIN_AUTOMATION_TEMPLATES,
} from '@camstack/types'
import {
  convertInstance,
  expandInstance,
  initialValues,
  withAddedNestedRow,
  withNestedValue,
  withoutNestedRow,
} from '../template-values'

const PAYLOAD: AutomationTemplatePayload = AutomationTemplatePayloadSchema.parse({
  version: 1,
  body: {
    when: {
      kind: 'device-becomes',
      deviceId: 5,
      cap: 'motion',
      fieldPath: 'detected',
      becomes: true,
    },
    actions: [{ kind: 'wait', seconds: 300 }],
  },
  inputs: [{ kind: 'duration', key: 'delay', label: 'Delay', min: 1, max: 3600 }],
  bindings: [{ kind: 'value', input: 'delay', path: ['actions', 0, 'seconds'] }],
})

describe('expandInstance / convertInstance', () => {
  it('a missing required input is a problem at its address, nothing is built', () => {
    const result = expandInstance('tpl-1', PAYLOAD, {}, 'Lamp', true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems.map((p) => p.code)).toContain('missing-input')
  })

  it('expands the values into a block that keeps the template link', () => {
    const result = expandInstance('tpl-1', PAYLOAD, { delay: 60 }, 'Lamp', true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.recipe.template?.templateId).toBe('tpl-1')
    expect(result.input).toMatchObject({ name: 'Lamp', enabled: true })
    expect(JSON.stringify(result.recipe.actions)).toContain('60')
  })

  it('convert drops the link and keeps the expanded body', () => {
    const made = expandInstance('tpl-1', PAYLOAD, { delay: 60 }, 'Lamp', true)
    if (!made.ok) throw new Error('expansion failed')
    const converted = convertInstance(AutomationRecipeSchema.parse(made.recipe), 'Lamp', true)
    expect(converted.ok).toBe(true)
    if (!converted.ok) return
    expect(converted.recipe.template).toBeUndefined()
    expect(converted.recipe.actions).toEqual(made.recipe.actions)
    expect(converted.input.code).not.toContain('tpl-1')
  })
})

describe('a group inside a group row', () => {
  const buttons = BUILTIN_AUTOMATION_TEMPLATES.find((t) => t.id === 'builtin:buttons-to-devices')
  if (buttons === undefined) throw new Error('the buttons template is not built in')
  const group = buttons.payload.inputs.find((i) => i.key === 'buttons')
  if (group === undefined || group.kind !== 'group') throw new Error('buttons is not a group')
  const commands = group.inputs.find((i) => i.key === 'commands')
  if (commands === undefined || commands.kind !== 'group') throw new Error('commands is not nested')
  const at = { groupKey: 'buttons', index: 0, group: commands }

  it('a new row starts each nested group at its minimum rows', () => {
    expect(initialValues(buttons.payload)).toEqual({ buttons: [{ events: [{}], commands: [{}] }] })
  })

  it('adds, fills and removes an entry of a nested group without touching its siblings', () => {
    const start = withNestedValue(initialValues(buttons.payload), at, 0, 'targets', [7])
    const added = withNestedValue(withAddedNestedRow(start, at), at, 1, 'targets', [8])
    expect(added).toEqual({
      buttons: [{ events: [{}], commands: [{ targets: [7] }, { targets: [8] }] }],
    })
    expect(withoutNestedRow(added, at, 0)).toEqual({
      buttons: [{ events: [{}], commands: [{ targets: [8] }] }],
    })
    expect(start).toEqual({ buttons: [{ events: [{}], commands: [{ targets: [7] }] }] })
  })

  it('never goes under the minimum or over the maximum rows', () => {
    const start = initialValues(buttons.payload)
    expect(withoutNestedRow(start, at, 0)).toBe(start)
    let full = start
    for (let i = 0; i < 20; i += 1) full = withAddedNestedRow(full, at)
    const rows = full['buttons']
    const first = Array.isArray(rows) ? rows[0] : undefined
    const stored = typeof first === 'object' && first !== null ? first['commands'] : undefined
    expect(Array.isArray(stored) ? stored.length : 0).toBe(commands.maxRows)
  })
})
