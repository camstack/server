import {
  AutomationTemplatePayloadSchema,
  createRecordsAccess,
  generateAutomationBlock,
  instantiateAutomationTemplate,
  readRecipeLiteral,
  type AutomationTemplatePayload,
  type CoreBlock,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { automationTemplateInstancesOver } from '../automation-template-instances.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { TemplatesService } from '../templates-service.js'
import { recordingLogger } from './fixtures.js'

const MOTION: AutomationTemplatePayload = AutomationTemplatePayloadSchema.parse({
  version: 1,
  body: {
    when: { kind: 'device-becomes', cap: 'motion', fieldPath: 'detected', becomes: true },
    actions: [
      { kind: 'command', actionId: 'switch.on' },
      { kind: 'wait', seconds: 300 },
    ],
  },
  inputs: [
    { kind: 'device', key: 'sensor', label: 'Sensor' },
    { kind: 'device', key: 'lights', label: 'Lights', multiple: true },
    { kind: 'duration', key: 'delay', label: 'Delay', default: 300 },
  ],
  bindings: [
    { kind: 'value', input: 'sensor', path: ['when', 'deviceId'] },
    { kind: 'value', input: 'lights', path: ['actions', 0, 'target'], as: 'target' },
    { kind: 'value', input: 'delay', path: ['actions', 1, 'seconds'] },
  ],
})

function block(id: string, name: string, code: string): CoreBlock {
  return {
    id,
    name,
    code,
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'test',
    status: 'running',
    lastChangedAt: 1,
  }
}

function instanceBlock(id: string, templateId: string, values: Record<string, number | number[]>) {
  const made = instantiateAutomationTemplate(templateId, MOTION, values)
  if (!made.ok) throw new Error('setup: the instance does not expand')
  const name = `Automation ${id}`
  return block(id, name, generateAutomationBlock({ name, recipe: made.recipe }))
}

async function world(blocks: CoreBlock[]) {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const saved = new Map<string, string>()
  const automations = automationTemplateInstancesOver({
    blocks: () => blocks,
    saveCode: async (blockId, code) => {
      saved.set(blockId, code)
    },
    logger: recordingLogger().logger,
  })
  let ids = 0
  const service = new TemplatesService({
    templates: records.kind(coreBlocksRecordKinds.templates),
    usage: { devicesUsing: async () => [] },
    automations,
    logger: recordingLogger().logger,
    newId: () => `t${(ids += 1)}`,
  })
  return { service, saved, automations }
}

function savedRecipe(code: string | undefined) {
  const read = readRecipeLiteral(code ?? '')
  if (read.status !== 'recipe') throw new Error(`no recipe in saved code: ${read.status}`)
  return read.recipe
}

describe('automation template instances', () => {
  it('re-expands every instance of a template when the template is saved, and only those', async () => {
    const blocks = [
      instanceBlock('a', 't1', { sensor: 7, lights: [3] }),
      instanceBlock('b', 'other', { sensor: 8, lights: [4] }),
      block('c', 'Hand-written', 'export default () => {}'),
    ]
    const { service, saved } = await world(blocks)
    expect(
      (await service.create({ kind: 'automation', name: 'Motion', payload: MOTION })).status,
    ).toBe('saved')

    const changed = { ...MOTION, body: { ...MOTION.body, runMode: { mode: 'restart' } } }
    expect((await service.update({ id: 't1', payload: changed })).status).toBe('saved')

    expect([...saved.keys()]).toEqual(['a'])
    const recipe = savedRecipe(saved.get('a'))
    expect(recipe.runMode).toEqual({ mode: 'restart' })
    expect(recipe.when).toMatchObject({ deviceId: 7 })
    expect(recipe.template).toEqual({ templateId: 't1', values: { sensor: 7, lights: [3] } })
  })

  it('a rename alone does not touch the instances', async () => {
    const { service, saved } = await world([instanceBlock('a', 't1', { sensor: 7, lights: [3] })])
    await service.create({ kind: 'automation', name: 'Motion', payload: MOTION })
    await service.update({ id: 't1', name: 'Motion v2' })
    expect(saved.size).toBe(0)
  })

  it('flags an instance whose values no longer fit, keeping its last body', async () => {
    const original = instanceBlock('a', 't1', { sensor: 7, lights: [3] })
    const { service, saved } = await world([original])
    await service.create({ kind: 'automation', name: 'Motion', payload: MOTION })
    const stricter = {
      ...MOTION,
      inputs: [...MOTION.inputs, { kind: 'text', key: 'note', label: 'Note' }],
    }
    await service.update({ id: 't1', payload: stricter })

    const recipe = savedRecipe(saved.get('a'))
    const before = savedRecipe(original.code)
    expect(recipe.when).toEqual(before.when)
    expect(recipe.actions).toEqual(before.actions)
    expect(recipe.template?.problems).toEqual([
      { code: 'missing-input', input: 'note', detail: '"Note" is required' },
    ])
  })

  it('refuses to delete a template an automation is made from, naming it', async () => {
    const { service } = await world([instanceBlock('a', 't1', { sensor: 7, lights: [3] })])
    await service.create({ kind: 'automation', name: 'Motion', payload: MOTION })
    expect(await service.delete({ id: 't1' })).toEqual({
      status: 'in-use',
      devices: [],
      automations: [{ blockId: 'a', name: 'Automation a' }],
    })
    expect(await service.get({ id: 't1' })).not.toBeNull()
  })
})

describe('built-in automation templates in the store', () => {
  it('are listed beside the operator templates, read-only', async () => {
    const { service } = await world([])
    const listed = await service.list({ kind: 'automation' })
    expect(listed.some((t) => t.id === 'builtin:buttons-to-devices' && t.builtIn === true)).toBe(
      true,
    )
    expect(await service.list({ kind: 'remote' })).toEqual([])
    expect(await service.get({ id: 'builtin:motion-light' })).toMatchObject({ builtIn: true })
    expect(await service.update({ id: 'builtin:motion-light', name: 'x' })).toMatchObject({
      status: 'refused',
      reason: 'read-only',
    })
    expect(await service.delete({ id: 'builtin:motion-light' })).toEqual({ status: 'read-only' })
  })

  it('an instance whose code comes out the same is not saved again', async () => {
    const { service, saved } = await world([instanceBlock('a', 't1', { sensor: 7, lights: [3] })])
    await service.create({ kind: 'automation', name: 'Motion', payload: MOTION })
    await service.update({ id: 't1', payload: MOTION })
    expect(saved.size).toBe(0)
  })
})
