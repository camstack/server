/**
 * `node-removal-hook` dispatch (#265): the hub records a tombstone BEFORE it
 * calls anyone, each acknowledgement shrinks it, and an implementer that was
 * down is told by the re-drive — never because a node is "absent".
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, NodeRemovedInput, RecordKindHandle } from '@camstack/types'
import type { ClusterNodeTombstoneBody } from '@camstack/system'
import {
  clearSingletonNodeOverrides,
  NodeRemovalDispatcher,
  NodeTombstoneStore,
  type NodeRemovalHooks,
  type SingletonOverrideRegistry,
} from '../node-removal-hooks'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as IScopedLogger

interface Row {
  readonly id: string
  readonly at: number
  readonly data: ClusterNodeTombstoneBody
}

function memoryKind() {
  const rows = new Map<string, Row>()
  const kind = {
    put: async (row: Row) => {
      rows.set(row.id, row)
    },
    get: async (id: string) => rows.get(id) ?? null,
    delete: async (id: string) => {
      rows.delete(id)
    },
    name: 'node-tombstones',
    query: async () => ({ records: [...rows.values()], nextCursor: null }),
  }
  return { rows, kind: kind as unknown as RecordKindHandle<ClusterNodeTombstoneBody> }
}

function setup(implementers: string[], call: NodeRemovalHooks['call']) {
  const { rows, kind } = memoryKind()
  const store = new NodeTombstoneStore(logger, () => kind)
  const hooks: NodeRemovalHooks = { implementers: () => implementers, call }
  return { rows, dispatcher: new NodeRemovalDispatcher({ hooks, store, logger }) }
}

describe('NodeRemovalDispatcher', () => {
  it('records the tombstone before calling, and deletes it once everyone acknowledged', async () => {
    let pendingAtCall: readonly string[] = []
    const harness = setup(['addon-ai', 'other'], async () => {
      pendingAtCall = [...(harness.rows.get('mac')?.data.pending ?? [])]
      return { counts: { profiles: 1 } }
    })

    const report = await harness.dispatcher.nodeForgotten('mac', 1000)

    expect(pendingAtCall.length).toBeGreaterThan(0)
    expect(report.acknowledged).toEqual(['addon-ai', 'other'])
    expect(harness.rows.has('mac')).toBe(false)
  })

  it('keeps an implementer that keeps failing pending, after bounded retries', async () => {
    const call = vi.fn(async (addonId: string, _input: NodeRemovedInput) => {
      if (addonId === 'down') throw new Error('unreachable')
      return { counts: {} }
    })
    const harness = setup(['addon-ai', 'down'], call)

    const report = await harness.dispatcher.nodeForgotten('mac', 1000)

    expect(report.pending).toEqual(['down'])
    expect(call.mock.calls.filter(([id]) => id === 'down')).toHaveLength(3)
    expect(harness.rows.get('mac')?.data.pending).toEqual(['down'])
  })

  it('re-drives a pending tombstone once the implementer is registered again', async () => {
    const up = { value: false }
    const call = vi.fn(async () => ({ counts: { profiles: 2 } }))
    const { rows, kind } = memoryKind()
    const store = new NodeTombstoneStore(logger, () => kind)
    const hooks: NodeRemovalHooks = {
      implementers: () => (up.value ? ['addon-ai'] : []),
      call,
    }
    await store.record('mac', 1000, ['addon-ai'])
    const dispatcher = new NodeRemovalDispatcher({ hooks, store, logger })

    await dispatcher.redrive()
    expect(call).not.toHaveBeenCalled()
    expect(rows.has('mac')).toBe(true)

    up.value = true
    await dispatcher.redrive()
    expect(call).toHaveBeenCalledWith('addon-ai', { nodeId: 'mac', removedAt: 1000 })
    expect(rows.has('mac')).toBe(false)
  })

  it('writes no tombstone and calls nobody when there is no implementer', async () => {
    const call = vi.fn(async () => ({ counts: {} }))
    const harness = setup([], call)
    await harness.dispatcher.nodeForgotten('mac', 1000)
    expect(call).not.toHaveBeenCalled()
    expect(harness.rows.size).toBe(0)
  })
})

type CapList = ReturnType<SingletonOverrideRegistry['listCapabilities']>

describe('clearSingletonNodeOverrides', () => {
  it('clears the persisted preference then the live override, only for that node', async () => {
    const overrides = new Map<string, Map<string, string>>([
      [
        'llm',
        new Map([
          ['mac', 'addon-ai'],
          ['other', 'addon-ai'],
        ]),
      ],
      ['stt', new Map([['other', 'x']])],
    ])
    const registry: SingletonOverrideRegistry = {
      listCapabilities: () =>
        [
          { name: 'llm', mode: 'singleton' },
          { name: 'stt', mode: 'singleton' },
          { name: 'col', mode: 'collection' },
        ] as unknown as CapList,
      getSingletonNodeOverrides: (cap) => new Map(overrides.get(cap) ?? []),
      clearSingletonNodeOverride: (cap, node) => {
        overrides.get(cap)?.delete(node)
      },
    }
    const set = vi.fn(async () => undefined)

    const cleared = await clearSingletonNodeOverrides('mac', registry, { set })

    expect(cleared).toBe(1)
    expect(set).toHaveBeenCalledWith('capabilities.singletonNode.llm.mac', null)
    expect(overrides.get('llm')?.has('mac')).toBe(false)
    expect(overrides.get('llm')?.has('other')).toBe(true)
  })

  it('leaves the live override when the persisted clear fails', async () => {
    const overrides = new Map([['llm', new Map([['mac', 'addon-ai']])]])
    const clear = vi.fn()
    const registry: SingletonOverrideRegistry = {
      listCapabilities: () => [{ name: 'llm', mode: 'singleton' }] as unknown as CapList,
      getSingletonNodeOverrides: (cap) => new Map(overrides.get(cap) ?? []),
      clearSingletonNodeOverride: clear,
    }
    await expect(
      clearSingletonNodeOverrides('mac', registry, {
        set: async () => {
          throw new Error('door closed')
        },
      }),
    ).rejects.toThrow('door closed')
    expect(clear).not.toHaveBeenCalled()
  })
})
