import { describe, expect, it } from 'vitest'
import {
  AutomationRecipeSchema,
  AutomationTemplatePayloadSchema,
  type AutomationTemplatePayload,
} from '@camstack/types'
import { convertInstance, expandInstance } from '../template-values'

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
