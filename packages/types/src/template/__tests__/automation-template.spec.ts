import { describe, expect, it } from 'vitest'
import {
  AutomationTemplatePayloadSchema,
  checkTemplatePayload,
  detachAutomationInstance,
  expandAutomationTemplate,
  exportAutomationTemplate,
  instantiateAutomationTemplate,
  reexpandAutomationInstance,
  AutomationTemplateExportSchema,
  type AutomationTemplatePayload,
} from '../../index.js'
import { generateAutomationBlock } from '../../automation/codegen.js'
import { readRecipeLiteral } from '../../automation/recipe-literal.js'

/** Motion sensor → lights on, wait, lights off. */
const MOTION: AutomationTemplatePayload = AutomationTemplatePayloadSchema.parse({
  version: 1,
  body: {
    when: {
      kind: 'device-becomes',
      cap: 'motion',
      fieldPath: 'detected',
      becomes: true,
    },
    actions: [
      { kind: 'command', actionId: 'switch.on' },
      { kind: 'wait', seconds: 300 },
    ],
  },
  inputs: [
    { kind: 'device', key: 'sensor', label: 'Sensor' },
    { kind: 'device', key: 'lights', label: 'Lights', multiple: true },
    {
      kind: 'duration',
      key: 'delay',
      label: 'Delay',
      min: 10,
      max: 3600,
      default: 300,
    },
  ],
  bindings: [
    { kind: 'value', input: 'sensor', path: ['when', 'deviceId'] },
    {
      kind: 'value',
      input: 'lights',
      path: ['actions', 0, 'target'],
      as: 'target',
    },
    { kind: 'value', input: 'delay', path: ['actions', 1, 'seconds'] },
  ],
})

/** N buttons → N device sets: one fired row and one choose branch per row. */
const BUTTONS: AutomationTemplatePayload = AutomationTemplatePayloadSchema.parse({
  version: 1,
  body: {
    when: { kind: 'any', children: [] },
    actions: [{ kind: 'choose', branches: [] }],
  },
  inputs: [
    {
      kind: 'group',
      key: 'buttons',
      label: 'Buttons',
      maxRows: 6,
      inputs: [
        { kind: 'device', key: 'button', label: 'Button' },
        {
          kind: 'event',
          key: 'event',
          label: 'Event',
          deviceInput: 'button',
        },
        { kind: 'device', key: 'targets', label: 'Devices', multiple: true },
        {
          kind: 'action',
          key: 'action',
          label: 'Action',
          deviceInput: 'targets',
        },
      ],
    },
  ],
  bindings: [
    {
      kind: 'rows',
      input: 'buttons',
      path: ['when', 'children'],
      item: { kind: 'device-fired' },
      bindings: [
        { kind: 'row-id', path: ['id'] },
        { kind: 'value', input: 'button', path: ['deviceId'] },
        { kind: 'value', input: 'event', path: [] },
      ],
    },
    {
      kind: 'rows',
      input: 'buttons',
      path: ['actions', 0, 'branches'],
      item: {
        if: { kind: 'triggered-by', leafIds: [] },
        steps: [{ kind: 'command' }],
      },
      bindings: [
        { kind: 'row-id', path: ['if', 'leafIds', 0] },
        {
          kind: 'value',
          input: 'targets',
          path: ['steps', 0, 'target'],
          as: 'target',
        },
        { kind: 'value', input: 'action', path: ['steps', 0] },
      ],
    },
  ],
})

describe('expandAutomationTemplate', () => {
  it('writes each input where its binding points, with defaults for unset optional values', () => {
    const out = expandAutomationTemplate(MOTION, { sensor: 7, lights: [3, 4] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recipe.when).toMatchObject({
      kind: 'device-becomes',
      deviceId: 7,
    })
    expect(out.recipe.actions[0]).toMatchObject({
      target: { kind: 'devices', ids: [3, 4] },
    })
    expect(out.recipe.actions[1]).toEqual({ kind: 'wait', seconds: 300 })
  })

  it('a changed input value changes the expansion', () => {
    const a = expandAutomationTemplate(MOTION, {
      sensor: 7,
      lights: [3],
      delay: 60,
    })
    const b = expandAutomationTemplate(MOTION, {
      sensor: 9,
      lights: [3],
      delay: 120,
    })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.recipe.when).toMatchObject({ deviceId: 7 })
    expect(b.recipe.when).toMatchObject({ deviceId: 9 })
    expect(b.recipe.actions[1]).toEqual({ kind: 'wait', seconds: 120 })
  })

  it('names a missing required input and a value its bounds refuse', () => {
    const out = expandAutomationTemplate(MOTION, { lights: [3], delay: 5 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems).toEqual([
      {
        code: 'missing-input',
        input: 'sensor',
        detail: '"Sensor" is required',
      },
      { code: 'invalid-input', input: 'delay', detail: 'at least 10' },
    ])
  })

  it('expands a repeatable group into one event row and one branch per row, sharing an id', () => {
    const out = expandAutomationTemplate(BUTTONS, {
      buttons: [
        {
          button: 11,
          event: { sourceIds: ['1'], kinds: ['press'] },
          targets: [20],
          action: { actionId: 'switch.on' },
        },
        {
          button: 11,
          event: { sourceIds: ['2'], kinds: ['press'] },
          targets: [21, 22],
          action: { actionId: 'switch.off' },
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
          id: 'buttons-0',
          deviceId: 11,
          sourceIds: ['1'],
          kinds: ['press'],
        },
        {
          kind: 'device-fired',
          id: 'buttons-1',
          deviceId: 11,
          sourceIds: ['2'],
          kinds: ['press'],
        },
      ],
    })
    expect(out.recipe.actions[0]).toMatchObject({
      kind: 'choose',
      branches: [
        {
          if: { kind: 'triggered-by', leafIds: ['buttons-0'] },
          steps: [
            {
              kind: 'command',
              actionId: 'switch.on',
              target: { kind: 'devices', ids: [20] },
            },
          ],
        },
        {
          if: { kind: 'triggered-by', leafIds: ['buttons-1'] },
          steps: [
            {
              kind: 'command',
              actionId: 'switch.off',
              target: { kind: 'devices', ids: [21, 22] },
            },
          ],
        },
      ],
    })
  })

  it('addresses a problem inside a row by group, index and key', () => {
    const out = expandAutomationTemplate(BUTTONS, {
      buttons: [
        {
          button: 11,
          event: { kinds: ['press'] },
          targets: [20],
          action: { actionId: 'not.an.action' },
        },
      ],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems).toEqual([
      {
        code: 'invalid-input',
        input: 'buttons.0.action',
        detail: '"not.an.action" is not a vocabulary action',
      },
    ])
  })

  it('refuses an expansion that is not a valid automation', () => {
    const out = expandAutomationTemplate(BUTTONS, { buttons: [] })
    expect(out.ok).toBe(false)
  })
})

describe('instances', () => {
  const values = { sensor: 7, lights: [3] }

  it('an instance carries its link through codegen and back', () => {
    const made = instantiateAutomationTemplate('t1', MOTION, values)
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const code = generateAutomationBlock({ name: 'Hall', recipe: made.recipe })
    const read = readRecipeLiteral(code)
    expect(read.status).toBe('recipe')
    if (read.status !== 'recipe') return
    expect(read.recipe.template).toMatchObject({ templateId: 't1', values })
    expect(read.recipe.template?.codeHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('re-expands an instance when the template body changes', () => {
    const made = instantiateAutomationTemplate('t1', MOTION, values)
    if (!made.ok) throw new Error('setup')
    const changed = AutomationTemplatePayloadSchema.parse({
      ...MOTION,
      body: { ...MOTION.body, runMode: { mode: 'restart' } },
    })
    const next = reexpandAutomationInstance(changed, made.recipe)
    expect(next.flagged).toBe(false)
    expect(next.recipe.runMode).toEqual({ mode: 'restart' })
    expect(next.recipe.template).toEqual({ templateId: 't1', values })
  })

  it('flags, and keeps the old body of, an instance missing a now-required input', () => {
    const made = instantiateAutomationTemplate('t1', MOTION, values)
    if (!made.ok) throw new Error('setup')
    const stricter = AutomationTemplatePayloadSchema.parse({
      ...MOTION,
      inputs: [...MOTION.inputs, { kind: 'text', key: 'note', label: 'Note' }],
    })
    const next = reexpandAutomationInstance(stricter, made.recipe)
    expect(next.flagged).toBe(true)
    expect(next.recipe.when).toEqual(made.recipe.when)
    expect(next.recipe.actions).toEqual(made.recipe.actions)
    expect(next.recipe.template?.problems).toEqual([
      { code: 'missing-input', input: 'note', detail: '"Note" is required' },
    ])
  })

  it('a flagged instance clears its problems once its values fit again', () => {
    const made = instantiateAutomationTemplate('t1', MOTION, values)
    if (!made.ok) throw new Error('setup')
    const flagged = reexpandAutomationInstance(null, made.recipe)
    expect(flagged.recipe.template?.problems?.[0]?.code).toBe('missing-template')
    const healed = reexpandAutomationInstance(MOTION, flagged.recipe)
    expect(healed.flagged).toBe(false)
    expect(healed.recipe.template?.problems).toBeUndefined()
  })

  it('detaching drops the link and keeps the expansion', () => {
    const made = instantiateAutomationTemplate('t1', MOTION, values)
    if (!made.ok) throw new Error('setup')
    const free = detachAutomationInstance(made.recipe)
    expect(free.template).toBeUndefined()
    expect(free.when).toEqual(made.recipe.when)
  })
})

describe('the automation payload', () => {
  it('is a template kind the store validates', () => {
    expect(checkTemplatePayload('automation', MOTION).ok).toBe(true)
  })

  it('refuses a binding to an undeclared input and an event reading a non-device input', () => {
    const bad = AutomationTemplatePayloadSchema.safeParse({
      ...MOTION,
      inputs: [...MOTION.inputs, { kind: 'event', key: 'ev', label: 'Ev', deviceInput: 'delay' }],
      bindings: [...MOTION.bindings, { kind: 'value', input: 'ghost', path: ['x'] }],
    })
    expect(bad.success).toBe(false)
    if (bad.success) return
    const messages = bad.error.issues.map((i) => i.message)
    expect(messages.some((m) => m.includes('"ghost"'))).toBe(true)
    expect(messages.some((m) => m.includes('"delay"'))).toBe(true)
  })

  it('exports as a versioned JSON document', () => {
    const doc = exportAutomationTemplate('Motion', MOTION)
    expect(AutomationTemplateExportSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
    expect(doc.format).toBe('camstack.automation-template')
    expect(doc.version).toBe(1)
  })
})

describe('a group inside a group row', () => {
  const nested = (bindings: unknown) => ({
    version: 1,
    body: {
      when: { kind: 'any', children: [] },
      actions: [{ kind: 'choose', branches: [] }],
    },
    inputs: [
      {
        kind: 'group',
        key: 'rows',
        label: 'Rows',
        inputs: [
          {
            kind: 'group',
            key: 'fires',
            label: 'Fires',
            inputs: [{ kind: 'device', key: 'source', label: 'Source' }],
          },
          {
            kind: 'group',
            key: 'steps',
            label: 'Steps',
            inputs: [{ kind: 'duration', key: 'pause', label: 'Pause' }],
          },
        ],
      },
    ],
    bindings,
  })
  const BINDINGS = [
    {
      kind: 'rows',
      input: 'rows',
      nested: 'fires',
      path: ['when', 'children'],
      item: { kind: 'device-fired' },
      bindings: [
        { kind: 'row-id', path: ['id'] },
        { kind: 'value', input: 'source', path: ['deviceId'] },
      ],
    },
    {
      kind: 'rows',
      input: 'rows',
      path: ['actions', 0, 'branches'],
      item: { if: { kind: 'triggered-by', leafIds: [] }, steps: [] },
      bindings: [
        { kind: 'row-ids', input: 'fires', path: ['if', 'leafIds'] },
        {
          kind: 'rows',
          input: 'steps',
          path: ['steps'],
          item: { kind: 'wait' },
          bindings: [{ kind: 'value', input: 'pause', path: ['seconds'] }],
        },
      ],
    },
  ]

  it('appends nested rows inside the parent item and flat across every row', () => {
    const payload = AutomationTemplatePayloadSchema.parse(nested(BINDINGS))
    const out = expandAutomationTemplate(payload, {
      rows: [
        { fires: [{ source: 1 }, { source: 2 }], steps: [{ pause: 5 }] },
        { fires: [{ source: 3 }], steps: [{ pause: 7 }, { pause: 9 }] },
      ],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recipe.when).toEqual({
      kind: 'any',
      children: [
        { kind: 'device-fired', id: 'rows-0-fires-0', deviceId: 1 },
        { kind: 'device-fired', id: 'rows-0-fires-1', deviceId: 2 },
        { kind: 'device-fired', id: 'rows-1-fires-0', deviceId: 3 },
      ],
    })
    expect(out.recipe.actions[0]).toEqual({
      kind: 'choose',
      branches: [
        {
          if: {
            kind: 'triggered-by',
            leafIds: ['rows-0-fires-0', 'rows-0-fires-1'],
          },
          steps: [{ kind: 'wait', seconds: 5 }],
        },
        {
          if: { kind: 'triggered-by', leafIds: ['rows-1-fires-0'] },
          steps: [
            { kind: 'wait', seconds: 7 },
            { kind: 'wait', seconds: 9 },
          ],
        },
      ],
    })
  })

  it('refuses a binding that names a nested group the row does not declare', () => {
    const flat = [{ ...BINDINGS[0], nested: 'missing' }]
    const inner = [
      {
        ...BINDINGS[1],
        bindings: [{ kind: 'row-ids', input: 'missing', path: ['if', 'leafIds'] }],
      },
    ]
    const wrongValue = [
      {
        ...BINDINGS[0],
        bindings: [{ kind: 'value', input: 'pause', path: ['deviceId'] }],
      },
    ]
    for (const bindings of [flat, inner, wrongValue]) {
      expect(AutomationTemplatePayloadSchema.safeParse(nested(bindings)).success).toBe(false)
    }
  })

  it('refuses a group nested two levels deep', () => {
    const raw = nested(BINDINGS)
    const deep = {
      ...raw,
      inputs: [
        {
          ...raw.inputs[0],
          inputs: [
            {
              kind: 'group',
              key: 'fires',
              label: 'Fires',
              inputs: raw.inputs[0]?.inputs,
            },
          ],
        },
      ],
      bindings: [],
    }
    expect(AutomationTemplatePayloadSchema.safeParse(deep).success).toBe(false)
  })
})
