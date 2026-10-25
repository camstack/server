/**
 * `getChildrenBatch` — a question about many parents is TWO reads, not two per
 * parent.
 *
 * The boot census on the live hub, 2026-08-27, 120-second window, 1 017
 * devices:
 *
 *     DeviceRowStore.list < DeviceRowStore.listByParent < getChildren
 *     calls 1 024      rows 919
 *
 * plus the primary-key `get` each of those calls made first, to learn which
 * addon owns the parent.
 *
 * Every assertion here is on WHAT THE LEDGER WAS ASKED FOR — the collection,
 * the number of statements, and the `whereIn` shape — never on the children
 * that came back. A per-parent loop and a `whereIn` return exactly the same
 * devices; asserting on the answer would pass either way, which is the defect,
 * not the test.
 */

import type {
  AddonContext,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'

const DEVICE_LEDGER = 'device-manager:devices'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeSettings() {
  const deviceStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({})),
    writeAddonStore: vi.fn(async () => {}),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    readDeviceStoreBatch: vi.fn(async (ids: readonly number[]) => {
      const out = new Map<number, Record<string, unknown>>()
      for (const id of ids) out.set(id, { ...deviceStores[id] })
      return out
    }),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
    clearDeviceStore: vi.fn(async () => {}),
    readDeviceRuntimeState: vi.fn(async () => ({})),
    writeDeviceRuntimeState: vi.fn(async () => {}),
    clearDeviceRuntimeState: vi.fn(async () => {}),
  }
}

/** One statement the device ledger was asked to run. */
interface LedgerRead {
  readonly op: 'get' | 'query'
  readonly whereIn?: Record<string, unknown>
  readonly where?: Record<string, unknown>
}

interface Harness {
  readonly provider: IDeviceManagerProvider
  readonly store: FakeSettingsStore
  /** Reads against the device ledger since the last {@link reset}. */
  readonly reads: () => readonly LedgerRead[]
  readonly reset: () => void
}

async function setup(): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const store = await makeSettingsStoreApi()
  const bus: IEventBus = {
    emit: vi.fn(),
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: store.api },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings: makeSettings(),
    records,
    kernel: { deviceRegistry: new DeviceRegistry() },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  const providers: readonly ProviderRegistration[] | undefined = Array.isArray(initResult)
    ? initResult
    : (initResult?.providers ?? undefined)
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')

  // Spy on the ENGINE, not on a hand-rolled double: what lands here is the
  // statement the store actually ran.
  let recorded: LedgerRead[] = []
  const realQuery = store.backend.query.bind(store.backend)
  const realGet = store.backend.get.bind(store.backend)
  vi.spyOn(store.backend, 'query').mockImplementation(async (input) => {
    if (input.collection === DEVICE_LEDGER) {
      recorded.push({
        op: 'query',
        ...(input.filter?.whereIn !== undefined ? { whereIn: input.filter.whereIn } : {}),
        ...(input.filter?.where !== undefined ? { where: input.filter.where } : {}),
      })
    }
    return realQuery(input)
  })
  vi.spyOn(store.backend, 'get').mockImplementation(async (input) => {
    if (input.collection === DEVICE_LEDGER) recorded.push({ op: 'get' })
    return realGet(input)
  })

  return {
    provider: first.provider as IDeviceManagerProvider,
    store,
    reads: () => recorded,
    reset: () => {
      recorded = []
    },
  }
}

/** Six parents, two children each — persisted only, no live registry entries. */
const PARENT_IDS: readonly number[] = [700, 701, 702, 703, 704, 705]

async function seedTree(h: Harness): Promise<void> {
  for (const parentId of PARENT_IDS) {
    await seedDeviceRow(h.store, { deviceId: parentId, type: 'container' })
    for (const offset of [1, 2]) {
      await seedDeviceRow(h.store, {
        deviceId: parentId * 10 + offset,
        type: 'sensor',
        parentDeviceId: parentId,
      })
    }
  }
}

describe('deviceManager.getChildrenBatch — the ledger is asked TWICE, not twice per parent', () => {
  let h: Harness

  beforeEach(async () => {
    h = await setup()
    await seedTree(h)
    h.reset()
  })

  it('costs one read per parent per statement when asked one parent at a time', async () => {
    for (const parentId of PARENT_IDS) {
      await h.provider.getChildren({ parentDeviceId: parentId })
    }
    // The measurement the batch exists to remove: an ownership `get` and a
    // `listByParent` scan, EACH, for every parent.
    expect(h.reads().filter((r) => r.op === 'get').length).toBe(PARENT_IDS.length)
    expect(h.reads().filter((r) => r.op === 'query').length).toBe(PARENT_IDS.length)
  })

  it('costs exactly two statements for the whole set', async () => {
    await h.provider.getChildrenBatch({ parentDeviceIds: [...PARENT_IDS] })

    const reads = h.reads()
    expect(reads.length).toBe(2)
    // Ownership for every parent the live registry does not hold: ONE keyed
    // sweep, not one primary-key read each.
    expect(reads[0]?.whereIn).toEqual({ deviceId: [...PARENT_IDS] })
    // The children of every parent: ONE indexed sweep.
    expect(reads[1]?.whereIn).toEqual({ parentDeviceId: [...PARENT_IDS] })
    expect(reads.some((r) => r.op === 'get')).toBe(false)
  })

  it('reads NOTHING for an empty set, rather than degrading to the whole fleet', async () => {
    // In production an empty `whereIn` list is DROPPED by the filter compiler,
    // so a batch that reached the store with no ids would answer with every
    // device that has a parent. The contract is asserted on what was asked.
    const answer = await h.provider.getChildrenBatch({ parentDeviceIds: [] })
    expect(h.reads()).toEqual([])
    expect(answer).toEqual({})
  })

  it('leaves a parent it does not know ABSENT, rather than inventing an empty row', async () => {
    const answer = await h.provider.getChildrenBatch({ parentDeviceIds: [700, 4242] })
    expect(Object.keys(answer)).toEqual(['700'])
  })

  it('leaves a KNOWN but childless parent absent too — same fact, same answer', async () => {
    await seedDeviceRow(h.store, { deviceId: 799, type: 'sensor' })
    const answer = await h.provider.getChildrenBatch({ parentDeviceIds: [700, 799] })
    expect(Object.keys(answer)).toEqual(['700'])
  })

  it('answers each parent exactly what the single-parent path answers', async () => {
    // Parity, so the batch is a cost fix and not a second projection that can
    // drift from the one the reconcile has always seen.
    const batch = await h.provider.getChildrenBatch({ parentDeviceIds: [...PARENT_IDS] })
    for (const parentId of PARENT_IDS) {
      const single = await h.provider.getChildren({ parentDeviceId: parentId })
      expect(batch[String(parentId)]).toEqual(single)
    }
  })

  it('de-duplicates a repeated parent instead of naming it twice in the IN list', async () => {
    await h.provider.getChildrenBatch({ parentDeviceIds: [700, 700, 701] })
    expect(h.reads()[1]?.whereIn).toEqual({ parentDeviceId: [700, 701] })
  })
})
