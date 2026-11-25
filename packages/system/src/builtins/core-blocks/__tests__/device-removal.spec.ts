import {
  builtinAutomationTemplate,
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  generateAutomationBlock,
  instantiateAutomationTemplate,
  LINKED_TRIGGER_TEMPLATE_ID,
  linkedTriggerParamsOf,
  linkedTriggerValues,
  readRecipeLiteral,
  type CoreBlock,
  type LinkedTriggerSource,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ComposedDeviceIndex, createCoreBlocksRemovalHook } from '../device-removal.js'
import { recordingLogger } from './fixtures.js'

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

function motion(deviceId: number): LinkedTriggerSource {
  return { kind: 'device-becomes', deviceId, cap: 'motion', fieldPath: 'detected', becomes: true }
}

function trigger(id: string, target: number, sources: readonly LinkedTriggerSource[]): CoreBlock {
  const payload = builtinAutomationTemplate(LINKED_TRIGGER_TEMPLATE_ID)?.payload
  if (payload === undefined) throw new Error('setup: no linked-trigger built-in')
  const made = instantiateAutomationTemplate(
    LINKED_TRIGGER_TEMPLATE_ID,
    payload,
    linkedTriggerValues({ targetDeviceId: target, action: 'on', sources: [...sources] }),
  )
  if (!made.ok) throw new Error('setup: the trigger does not expand')
  const name = `trigger ${id}`
  return block(id, name, generateAutomationBlock({ name, recipe: made.recipe }))
}

function world(initial: CoreBlock[]) {
  const blocks = [...initial]
  const removed: string[] = []
  const saved = new Map<string, string>()
  const composed = new ComposedDeviceIndex()
  const log = recordingLogger()
  const hook = createCoreBlocksRemovalHook({
    blocks: () => blocks,
    composed,
    removeBlock: async (blockId) => {
      removed.push(blockId)
      const at = blocks.findIndex((b) => b.id === blockId)
      if (at >= 0) blocks.splice(at, 1)
    },
    saveCode: async (blockId, code) => {
      saved.set(blockId, code)
      const at = blocks.findIndex((b) => b.id === blockId)
      const current = blocks[at]
      if (current !== undefined) blocks[at] = { ...current, code }
    },
    logger: log.logger,
  })
  return { hook, removed, saved, composed, log, blocks }
}

const INPUT = { deviceId: 32, deletedAt: 1, providerAddonId: 'x' }

describe('core-blocks device-removal-hook', () => {
  it('retires the composition that owns the deleted device, through the delete path', async () => {
    const w = world([block('comp-1', 'Composition', 'export default () => {}')])
    w.composed.learn([{ id: 32, stableId: `${COMPOSED_DEVICE_STABLE_ID_PREFIX}comp-1` }])
    const result = await w.hook.onDeviceRemoved(INPUT)
    expect(w.removed).toEqual(['comp-1'])
    expect(result.counts['compositions']).toBe(1)
    expect(
      w.log.lines.some((l) => l.extras?.tags?.deviceId === 32 && l.message.includes('retired')),
    ).toBe(true)
    // Idempotent: a second run finds nothing.
    const again = await w.hook.onDeviceRemoved(INPUT)
    expect(again.counts['compositions']).toBe(0)
    expect(w.removed).toEqual(['comp-1'])
  })

  it('deletes a trigger whose only target is the deleted device', async () => {
    const w = world([trigger('t1', 32, [motion(8)]), trigger('t2', 5, [motion(8)])])
    const result = await w.hook.onDeviceRemoved(INPUT)
    expect(w.removed).toEqual(['t1'])
    expect(result.counts['automations-deleted']).toBe(1)
  })

  it('deletes a trigger whose only source is the deleted device', async () => {
    const w = world([trigger('t1', 5, [motion(32)])])
    await w.hook.onDeviceRemoved(INPUT)
    expect(w.removed).toEqual(['t1'])
  })

  it('keeps a multi-source trigger and drops only the dead source', async () => {
    const w = world([trigger('t1', 5, [motion(32), motion(8)])])
    const result = await w.hook.onDeviceRemoved(INPUT)
    expect(w.removed).toEqual([])
    expect(result.counts['automations-unlinked']).toBe(1)
    const read = readRecipeLiteral(w.saved.get('t1') ?? '')
    if (read.status !== 'recipe') throw new Error('no recipe saved')
    const params = linkedTriggerParamsOf(read.recipe.template?.values ?? {})
    expect(params?.sources.map((s) => (s.kind === 'detection' ? -1 : s.deviceId))).toEqual([8])
    // Idempotent: nothing references 32 any more.
    const again = await w.hook.onDeviceRemoved(INPUT)
    expect(again.counts['automations-unlinked']).toBe(0)
  })

  it('leaves unrelated blocks alone', async () => {
    const w = world([trigger('t1', 5, [motion(8)]), block('c', 'code', 'export default 1')])
    await w.hook.onDeviceRemoved(INPUT)
    expect(w.removed).toEqual([])
    expect(w.saved.size).toBe(0)
  })
})
