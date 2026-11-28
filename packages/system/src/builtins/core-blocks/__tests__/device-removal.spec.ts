import {
  builtinAutomationTemplate,
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  generateAutomationBlock,
  instantiateAutomationTemplate,
  LINKED_TRIGGER_TEMPLATE_ID,
  linkedTriggerParamsOf,
  linkedTriggerValues,
  readRecipeLiteral,
  createRecordsAccess,
  type CoreBlock,
  type IDeviceRemovalHookProvider,
  type LinkedTriggerSource,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  createCoreBlocksRemovalHook,
  memoryComposedDevices,
  recordsComposedDevices,
  type ComposedDeviceStore,
} from '../device-removal.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { recordingLogger, type RecordingLogger } from './fixtures.js'

function block(id: string, name: string, code: string): CoreBlock {
  return {
    id,
    name,
    code,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'test',
    status: 'running',
    lastChangedAt: 1,
  }
}

function motion(deviceId: number): LinkedTriggerSource {
  return {
    kind: 'device-becomes',
    deviceId,
    cap: 'motion',
    fieldPath: 'detected',
    becomes: true,
  }
}

function trigger(id: string, target: number, sources: readonly LinkedTriggerSource[]): CoreBlock {
  const payload = builtinAutomationTemplate(LINKED_TRIGGER_TEMPLATE_ID)?.payload
  if (payload === undefined) throw new Error('setup: no linked-trigger built-in')
  const made = instantiateAutomationTemplate(
    LINKED_TRIGGER_TEMPLATE_ID,
    payload,
    linkedTriggerValues({
      targetDeviceId: target,
      action: 'on',
      sources: [...sources],
    }),
  )
  if (!made.ok) throw new Error('setup: the trigger does not expand')
  const name = `trigger ${id}`
  return block(id, name, generateAutomationBlock({ name, recipe: made.recipe }))
}

interface RemovalWorld {
  readonly hook: IDeviceRemovalHookProvider
  readonly removed: string[]
  readonly retired: string[]
  readonly saved: Map<string, string>
  readonly composed: ComposedDeviceStore
  readonly log: RecordingLogger
  readonly blocks: CoreBlock[]
  /** Makes the next `removeBlock` delete the block and then fail, as a half-done delete would. */
  failNextRemove(): void
}

function world(
  initial: CoreBlock[],
  mapping: Map<number, string> = new Map(),
  all: CoreBlock[] = [...initial],
): RemovalWorld {
  const blocks = all
  const removed: string[] = []
  const retired: string[] = []
  const saved = new Map<string, string>()
  const composed = memoryComposedDevices(mapping)
  const log = recordingLogger()
  let failing = false
  const hook = createCoreBlocksRemovalHook({
    blocks: () => blocks,
    composed,
    removeBlock: async (blockId) => {
      removed.push(blockId)
      const at = blocks.findIndex((b) => b.id === blockId)
      if (at >= 0) blocks.splice(at, 1)
      if (failing) {
        failing = false
        throw new Error('claims not released')
      }
    },
    retireClaims: async (blockId) => {
      retired.push(blockId)
    },
    saveCode: async (blockId, code) => {
      saved.set(blockId, code)
      const at = blocks.findIndex((b) => b.id === blockId)
      const current = blocks[at]
      if (current !== undefined) blocks[at] = { ...current, code }
    },
    logger: log.logger,
  })
  return {
    hook,
    removed,
    retired,
    saved,
    composed,
    log,
    blocks,
    failNextRemove: () => {
      failing = true
    },
  }
}

const INPUT = { deviceId: 32, deletedAt: 1, providerAddonId: 'x' }
const COMPOSED_INPUT = {
  deviceId: 32,
  deletedAt: 1,
  providerAddonId: 'composer',
}
const COMPOSED_ROW = [{ id: 32, stableId: `${COMPOSED_DEVICE_STABLE_ID_PREFIX}comp-1` }]

describe('core-blocks device-removal-hook', () => {
  it('retires the composition that owns the deleted device, through the delete path', async () => {
    const w = world([block('comp-1', 'Composition', 'export default () => {}')])
    await w.composed.learn([{ id: 32, stableId: `${COMPOSED_DEVICE_STABLE_ID_PREFIX}comp-1` }])
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

  it('a tombstone processed BEFORE the mapping is known is not applied, and retires once it is', async () => {
    const w = world([block('comp-1', 'Composition', 'export default () => {}')])
    await expect(w.hook.onDeviceRemoved(COMPOSED_INPUT)).rejects.toThrow(/no composition is known/)
    expect(w.removed).toEqual([])
    expect(w.log.lines.some((l) => l.level === 'warn' && l.extras?.tags?.deviceId === 32)).toBe(
      true,
    )
    await w.composed.learn(COMPOSED_ROW)
    await w.hook.onDeviceRemoved(COMPOSED_INPUT)
    expect(w.removed).toEqual(['comp-1'])
  })

  it('a restart keeps the mapping: a fresh hook over the persisted mapping retires the owner', async () => {
    const persisted = new Map<number, string>()
    const before = world([block('comp-1', 'Composition', 'export default () => {}')], persisted)
    await before.composed.learn(COMPOSED_ROW)
    const after = world([], persisted, [block('comp-1', 'Composition', 'export default () => {}')])
    await after.hook.onDeviceRemoved(COMPOSED_INPUT)
    expect(after.removed).toEqual(['comp-1'])
  })

  it('a delete that fails half way keeps the mapping and the retry releases the claims', async () => {
    const w = world([block('comp-1', 'Composition', 'export default () => {}')])
    await w.composed.learn(COMPOSED_ROW)
    w.failNextRemove()
    await expect(w.hook.onDeviceRemoved(COMPOSED_INPUT)).rejects.toThrow(/claims not released/)
    expect(await w.composed.blockOf(32)).toBe('comp-1')
    await w.hook.onDeviceRemoved(COMPOSED_INPUT)
    expect(w.retired).toEqual(['comp-1'])
    expect(await w.composed.blockOf(32)).toBeNull()
  })

  it('never deletes a hand-edited trigger, even when its target is the deleted device', async () => {
    const edited = trigger('t1', 32, [motion(8)])
    const w = world([{ ...edited, code: `${edited.code}\n// edited by hand\n` }])
    await w.hook.onDeviceRemoved(INPUT)
    expect(w.removed).toEqual([])
    expect(w.log.lines.some((l) => l.level === 'warn' && l.extras?.tags?.deviceId === 32)).toBe(
      true,
    )
  })

  it('the persisted mapping survives in the records kind', async () => {
    const w = makeRecordsWorld()
    await w.provider.init()
    const records = createRecordsAccess({
      owner: 'core-blocks',
      transport: w.transportFor('core-blocks'),
      secrets: null,
    })
    await records.declare(coreBlocksRecordKinds)
    const store = recordsComposedDevices(records.kind(coreBlocksRecordKinds['composed-devices']))
    await store.learn([...COMPOSED_ROW, { id: 40, stableId: 'other-1' }])
    expect(await store.blockOf(32)).toBe('comp-1')
    expect(await store.blockOf(40)).toBeNull()
    expect(await store.entries()).toEqual([[32, 'comp-1']])
    await store.forget(32)
    expect(await store.blockOf(32)).toBeNull()
  })
})
