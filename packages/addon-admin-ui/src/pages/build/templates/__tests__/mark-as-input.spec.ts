import { describe, expect, it } from 'vitest'
import { AutomationTemplatePayloadSchema, type AutomationTemplatePayload } from '@camstack/types'
import { bindableFields, markAsInput, markProblem, removeInput } from '../mark-as-input'

const BODY: AutomationTemplatePayload = AutomationTemplatePayloadSchema.parse({
  version: 1,
  body: {
    when: {
      kind: 'device-becomes',
      deviceId: 5,
      cap: 'motion',
      fieldPath: 'detected',
      becomes: true,
    },
    actions: [
      { kind: 'command', actionId: 'switch.on', target: { kind: 'devices', ids: [6] } },
      { kind: 'wait', seconds: 300 },
    ],
  },
  inputs: [],
  bindings: [],
})

function field(id: string) {
  const found = bindableFields(BODY.body, BODY.bindings).find((f) => f.id === id)
  if (found === undefined) throw new Error(`no bindable field ${id}`)
  return found
}

describe('mark as input', () => {
  it('offers the device, the step target and the wait seconds by shape', () => {
    const fields = bindableFields(BODY.body, BODY.bindings)
    expect(fields.map((f) => `${f.path.join('.')}:${f.kind}`)).toEqual(
      expect.arrayContaining([
        'when.deviceId:device',
        'actions.0.target:device',
        'actions.1.seconds:duration',
      ]),
    )
    expect(fields.find((f) => f.path.join('.') === 'actions.0.target')?.as).toBe('target')
  })

  it('adds the input and a value binding at the field path', () => {
    const seconds = field('actions.1.seconds:duration')
    const next = markAsInput(BODY, seconds, { key: 'delay', label: 'Delay', optional: false })
    expect(next.inputs).toHaveLength(1)
    expect(next.inputs[0]).toMatchObject({ kind: 'duration', key: 'delay', default: 300 })
    expect(next.bindings).toEqual([
      { kind: 'value', input: 'delay', path: ['actions', 1, 'seconds'] },
    ])
  })

  it('binds a step target with as: target', () => {
    const target = field('actions.0.target:device')
    const next = markAsInput(BODY, target, { key: 'lights', label: 'Lights', optional: false })
    expect(next.bindings[0]).toEqual({
      kind: 'value',
      input: 'lights',
      path: ['actions', 0, 'target'],
      as: 'target',
    })
  })

  it('stops offering a field once it is bound', () => {
    const next = markAsInput(BODY, field('actions.1.seconds:duration'), {
      key: 'delay',
      label: 'Delay',
      optional: false,
    })
    expect(
      bindableFields(next.body, next.bindings).some((f) => f.id === 'actions.1.seconds:duration'),
    ).toBe(false)
  })

  it('refuses a taken key and a blank label', () => {
    const next = markAsInput(BODY, field('when.deviceId:device'), {
      key: 'sensor',
      label: 'Sensor',
      optional: false,
    })
    const seconds = field('actions.1.seconds:duration')
    expect(markProblem(next, seconds, { key: 'sensor', label: 'x', optional: false })).toBe(
      'key-taken',
    )
    expect(markProblem(next, seconds, { key: 'delay', label: ' ', optional: false })).toBe('label')
    expect(markProblem(next, seconds, { key: 'delay', label: 'Delay', optional: false })).toBeNull()
  })

  it('removing an input drops its bindings too', () => {
    const one = markAsInput(BODY, field('when.deviceId:device'), {
      key: 'sensor',
      label: 'Sensor',
      optional: false,
    })
    const two = markAsInput(one, field('actions.1.seconds:duration'), {
      key: 'delay',
      label: 'Delay',
      optional: false,
    })
    const removed = removeInput(two, 'sensor')
    expect(removed.inputs.map((i) => i.key)).toEqual(['delay'])
    expect(removed.bindings.map((b) => b.input)).toEqual(['delay'])
  })
})
