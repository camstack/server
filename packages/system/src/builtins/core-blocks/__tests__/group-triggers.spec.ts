import {
  type CompositionSourceRef,
  type CoreBlock,
  type CoreBlockInput,
  type GroupHelperSpec,
  type GroupTrigger,
  compileHelper,
  composedDeviceStableId,
  readRecipeLiteral,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordingLogger } from '../../composer/__tests__/fixtures.js'
import {
  type GroupTriggerSync,
  type OwnedBlockWrite,
  groupTriggerSyncOver,
  ownedGroupOf,
} from '../group-triggers.js'

const ref = (stableId: string, addonId = 'demo'): CompositionSourceRef => ({ addonId, stableId })
const key = (r: CompositionSourceRef): string => `${r.addonId}/${r.stableId}`

const press = (id: string, device = 'button'): GroupTrigger => ({
  id,
  source: { kind: 'fired', device: ref(device), eventIds: ['PRESS_SHORT'] },
  action: { kind: 'switch' },
})

function groupSpec(
  over: Partial<GroupHelperSpec>,
  triggers: readonly GroupTrigger[],
): GroupHelperSpec {
  return {
    kind: 'group',
    templateId: 'light',
    aggregate: 'any',
    active: 'at-least-one',
    members: ['lamp-1', 'lamp-2'].map((id) => ({
      source: ref(id),
      cap: 'switch',
      fieldPath: 'on',
    })),
    triggers: [...triggers],
    ...over,
  }
}

function groupBlock(id: string, spec: GroupHelperSpec): CoreBlock {
  const compiled = compileHelper(spec)
  if (!compiled.ok) throw new Error('the spec did not compile')
  return {
    id,
    name: 'Bathroom light',
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u',
    status: 'stopped',
    lastChangedAt: 1,
    source: { kind: 'composition', composition: compiled.composition },
  }
}

const KNOWN: Readonly<Record<string, number>> = {
  button: 10,
  'lamp-1': 21,
  'lamp-2': 22,
}

let blocks: CoreBlock[]
let loaded: boolean
let deviceRead: () => Promise<ReadonlyMap<string, number>>
let writes: string[]
let sync: GroupTriggerSync
let log: ReturnType<typeof recordingLogger>
let counter: number

function known(
  extra: Readonly<Record<string, number>> = {},
): () => Promise<ReadonlyMap<string, number>> {
  return async () =>
    new Map<string, number>([
      ...Object.entries(KNOWN).map(([id, n]): [string, number] => [key(ref(id)), n]),
      [key(ref(composedDeviceStableId('g1'), 'composer')), 99],
      [key(ref(composedDeviceStableId('g2'), 'composer')), 98],
      ...Object.entries(extra).map(([id, n]): [string, number] => [key(ref(id)), n]),
    ])
}

const owned = (): CoreBlock[] => blocks.filter((b) => ownedGroupOf(b) !== null)

beforeEach(() => {
  blocks = []
  loaded = true
  writes = []
  counter = 0
  deviceRead = known()
  log = recordingLogger()
  sync = groupTriggerSyncOver({
    blocks: {
      isLoaded: () => loaded,
      list: () => blocks,
      get: (id) => blocks.find((b) => b.id === id) ?? null,
    },
    writes: {
      create: async (input: CoreBlockInput) => {
        counter += 1
        writes.push(`create ${input.name}`)
        blocks = [
          ...blocks,
          {
            id: `own${counter}`,
            name: input.name,
            code: input.code ?? '',
            enabled: input.enabled,
            placement: input.placement,
            createdAt: 1,
            updatedAt: 1,
            createdBy: 'system',
            status: 'stopped',
            lastChangedAt: 1,
          },
        ]
      },
      save: async (blockId: string, write: OwnedBlockWrite) => {
        writes.push(`save ${blockId}`)
        blocks = blocks.map((b) => (b.id === blockId ? { ...b, ...write } : b))
      },
      remove: async (blockId: string) => {
        writes.push(`remove ${blockId}`)
        blocks = blocks.filter((b) => b.id !== blockId)
      },
    },
    deviceIds: () => deviceRead(),
    logger: log.logger,
  })
})

describe('group trigger sync', () => {
  it('writes the one automation the group owns, and only that once', async () => {
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    expect(await sync.sync('g1', 'save')).toBe('written')
    const [block] = owned()
    expect(block?.name).toBe('Bathroom light — triggers')
    const read = block === undefined ? null : readRecipeLiteral(block.code)
    expect(read?.status === 'recipe' && read.recipe.ownedBy).toEqual({
      kind: 'group',
      blockId: 'g1',
    })
    expect(await sync.sync('g1', 'save')).toBe('unchanged')
    expect(writes).toEqual(['create Bathroom light — triggers'])
  })

  it('regenerates when a trigger changes, and follows the group name and enabled flag', async () => {
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    await sync.sync('g1', 'save')
    blocks = [groupBlock('g1', groupSpec({}, [press('t1'), press('t2')])), ...owned()]
    expect(await sync.sync('g1', 'save')).toBe('written')
    expect(writes.at(-1)).toBe('save own1')
    blocks = blocks.map((b) => (b.id === 'g1' ? { ...b, enabled: false } : b))
    await sync.sync('g1', 'save')
    expect(owned()[0]?.enabled).toBe(false)
  })

  it('removes the owned block when no trigger is enabled, and when the group is gone', async () => {
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    await sync.sync('g1', 'save')
    blocks = [groupBlock('g1', groupSpec({}, [{ ...press('t1'), enabled: false }])), ...owned()]
    expect(await sync.sync('g1', 'save')).toBe('removed')
    expect(owned()).toEqual([])
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    await sync.sync('g1', 'save')
    blocks = owned()
    await sync.remove('g1')
    expect(owned()).toEqual([])
  })

  it('boot: an orphaned owned block goes, a group with triggers is synced', async () => {
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    await sync.sync('g1', 'save')
    blocks = [...owned(), groupBlock('g2', groupSpec({}, [press('t1')]))]
    await sync.reconcile()
    expect(owned().map((b) => ownedGroupOf(b))).toEqual(['g2'])
  })

  it('boot keeps the block when a trigger device cannot be found; a save writes what resolves', async () => {
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    await sync.sync('g1', 'save')
    const before = owned()[0]?.code
    blocks = [groupBlock('g1', groupSpec({}, [press('t1'), press('t2', 'ghost')])), ...owned()]
    expect(await sync.sync('g1', 'boot')).toBe('kept')
    expect(owned()[0]?.code).toBe(before)
    expect(await sync.sync('g1', 'save')).toBe('unchanged')
    const left = log.lines.filter((l) => l.message === 'group triggers: a trigger was left out')
    expect(left).toHaveLength(2)
    expect(left[0]?.extras?.tags).toEqual({ deviceId: 99 })
  })

  it('writes nothing while the devices cannot be read or the store has not loaded', async () => {
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    deviceRead = async () => {
      throw new Error('device-manager is not up')
    }
    expect(await sync.sync('g1', 'save')).toBe('skipped')
    deviceRead = known()
    loaded = false
    expect(await sync.sync('g1', 'save')).toBe('skipped')
    await sync.reconcile()
    expect(writes).toEqual([])
  })

  it('a group without a device: the owned block commands the members, and no group device is named', async () => {
    blocks = [groupBlock('g1', groupSpec({ output: 'none' }, [press('t1')]))]
    await sync.sync('g1', 'save')
    const code = owned()[0]?.code ?? ''
    expect(code).toContain('21')
    expect(code).toContain('22')
    expect(code).not.toContain('99')
  })

  it('a group saved before its device existed is written when a device registers, and nothing is read otherwise', async () => {
    blocks = [groupBlock('g1', groupSpec({}, [press('t1')]))]
    let reads = 0
    const base = known()
    deviceRead = async () => {
      reads += 1
      const all = new Map(await base())
      all.delete(key(ref(composedDeviceStableId('g1'), 'composer')))
      return reads > 1 ? base() : all
    }
    expect(await sync.sync('g1', 'save')).toBe('kept')
    expect(owned()).toEqual([])
    await sync.wake()
    expect(owned()).toHaveLength(1)
    reads = 0
    await sync.wake()
    expect(reads).toBe(0)
  })

  it('a block that is not owned by a group answers null', () => {
    expect(
      ownedGroupOf({ ...groupBlock('g1', groupSpec({}, [press('t1')])), code: 'export {}' }),
    ).toBeNull()
  })
})
