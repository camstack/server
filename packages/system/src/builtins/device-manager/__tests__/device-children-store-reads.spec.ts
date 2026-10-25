/**
 * `getChildren` / `getChildrenBatch` — the number of SETTINGS-DOOR round trips
 * a child projection costs.
 *
 * `getChildrenBatch` removed the ledger N+1 (`device-children-batch.spec.ts`
 * owns that: two statements for the whole set, not two per parent) and stopped
 * one step short. `projectChildren` still issued one
 * `settings.readDeviceStore(childId)` per child that the hub registry does not
 * hold — and on the live hub 2026-08-30 **all 896 children belong to forked
 * provider addons**, so hub-main's registry holds none of them and every one
 * took that branch. A single-row `settingsStore.get` measured 2.9 s mid-drain
 * that day; `deviceManager.getAllBindings`, the same defect one file over, was
 * measured at 740 s against a 15 s budget.
 *
 * ## What is counted, and why it is counted HERE
 *
 * `ctx.settings` for the device-manager is the REAL `createDoorSettingsView`
 * over the REAL `SqliteSettingsBackend`, and the counter sits on the door
 * between them — the exact object whose every call is a round trip to the
 * isolated `sqlite-settings` child in production. It is a `Proxy`, so it counts
 * calls on EVERY method including ones that do not exist yet: a read that
 * arrives on an unnamed method still fails these tests. Five tests in this repo
 * have passed for the wrong reason by counting a fake production never touched;
 * there is one door here and one counter on it.
 *
 * Wall clock is never asserted. The number that survives the drain is *how many
 * round trips*, so that is the only number here.
 */

import type {
  AddonContext,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ISettingsStoreProvider,
  ProviderRegistration,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import type { AddonSettingsView } from '../../../kernel/config-manager.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { createDoorSettingsView } from '../../../kernel/settings-door-view.js'
import { createDataStoreDispatch } from '../../storage-orchestrator/data-store-dispatch.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'

const DEVICE_SETTINGS = 'addon-device-settings'

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

/** Door calls since the last reset, split by collection. */
interface DoorCensus {
  readonly total: number
  readonly byCollection: Readonly<Record<string, number>>
}

interface CountingDoor {
  readonly door: ISettingsStoreProvider
  readonly census: () => DoorCensus
  readonly reset: () => void
}

/**
 * Wrap a door so EVERY call through it is counted, whatever the method is
 * named.
 *
 * A per-method wrapper counts the methods it was told about; the defect this
 * file pins is a read arriving somewhere nobody thought to instrument. The
 * `Proxy` has no list.
 */
function countingDoor(inner: ISettingsStoreProvider): CountingDoor {
  let total = 0
  let byCollection: Record<string, number> = {}
  const door = new Proxy(inner, {
    get(target, prop, receiver) {
      const member: unknown = Reflect.get(target, prop, receiver)
      if (typeof member !== 'function') return member
      return (input: unknown): unknown => {
        total += 1
        const collection: unknown =
          typeof input === 'object' && input !== null ? Reflect.get(input, 'collection') : undefined
        if (typeof collection === 'string') {
          byCollection[collection] = (byCollection[collection] ?? 0) + 1
        }
        return Reflect.apply(member, target, [input])
      }
    },
  })
  return {
    door,
    census: () => ({ total, byCollection: { ...byCollection } }),
    reset: () => {
      total = 0
      byCollection = {}
    },
  }
}

interface Harness {
  readonly provider: IDeviceManagerProvider
  readonly store: FakeSettingsStore
  readonly settings: AddonSettingsView
  readonly registry: DeviceRegistry
  readonly census: () => DoorCensus
  readonly reset: () => void
}

async function setup(): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const store = await makeSettingsStoreApi()
  const counting = countingDoor(createDataStoreDispatch(() => [store.backend]))
  const settings = createDoorSettingsView('device-manager', counting.door, {
    getSection: async () => ({}),
    setSection: () => undefined,
  })
  const bus: IEventBus = {
    emit: vi.fn(),
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  const registry = new DeviceRegistry()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: store.api },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    kernel: { deviceRegistry: registry },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  const providers: readonly ProviderRegistration[] | undefined = Array.isArray(initResult)
    ? initResult
    : (initResult?.providers ?? undefined)
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')

  return {
    provider: first.provider as IDeviceManagerProvider,
    store,
    settings,
    registry,
    census: counting.census,
    reset: counting.reset,
  }
}

/** Three parents, four persisted children each — none of them live, which is
 *  the live hub's shape: 896 of 896 children are owned by forked addons. */
const PARENT_IDS: readonly number[] = [800, 801, 802]
const CHILDREN_PER_PARENT = 4

function childIdsOf(parentId: number): readonly number[] {
  return Array.from({ length: CHILDREN_PER_PARENT }, (_, i) => parentId * 10 + i + 1)
}

async function seedTree(h: Harness): Promise<void> {
  for (const parentId of PARENT_IDS) {
    await seedDeviceRow(h.store, { deviceId: parentId, type: 'container' })
    for (const childId of childIdsOf(parentId)) {
      await seedDeviceRow(h.store, { deviceId: childId, type: 'sensor', parentDeviceId: parentId })
      // A real child's settings row: HA accessory children persist
      // `entityId` + `system`, which `buildSourceInfoFromConfig` reads back
      // into `sourceInfo`. Config that is DROPPED must be visible as a
      // difference, so every child carries some.
      await h.settings.writeDeviceStore(childId, {
        entityId: `sensor.child_${childId}`,
        system: 'homeassistant',
        retentionDays: childId,
      })
    }
  }
}

describe('projectChildren — persisted child configs are ONE door read for the pass', () => {
  let h: Harness

  beforeEach(async () => {
    h = await setup()
    await seedTree(h)
    h.reset()
  })

  it('reads the device store ONCE for a parent, not once per child', async () => {
    await h.provider.getChildren({ parentDeviceId: 800 })
    const census = h.census()
    expect(census.byCollection[DEVICE_SETTINGS] ?? 0).toBe(1)
    // Nothing else reaches the door on this path — the ledger goes through
    // `ctx.api.settingsStore`, not through here.
    expect(census.total).toBe(1)
  })

  it('reads the device store ONCE for the whole batch, not once per child of each parent', async () => {
    await h.provider.getChildrenBatch({ parentDeviceIds: [...PARENT_IDS] })
    const census = h.census()
    expect(census.byCollection[DEVICE_SETTINGS] ?? 0).toBe(1)
    expect(census.total).toBe(1)
  })

  it('costs NO door read at all for a parent with no children', async () => {
    await seedDeviceRow(h.store, { deviceId: 899, type: 'sensor' })
    h.reset()
    await h.provider.getChildren({ parentDeviceId: 899 })
    expect(h.census().total).toBe(0)
  })

  it('answers for every seeded child, in row order, with its config verbatim', async () => {
    // The answer must not narrow: same devices, same order, same `config`.
    // `config` is checked against the per-device reader being replaced, so a
    // batch that silently dropped a key would show up here.
    const answer = await h.provider.getChildren({ parentDeviceId: 800 })
    expect(answer.map((c) => c.id)).toEqual([...childIdsOf(800)])
    for (const child of answer) {
      expect(child.config).toEqual(await h.settings.readDeviceStore(child.id))
      expect(child.parentDeviceId).toBe(800)
    }
  })

  it('derives sourceInfo from the batched config exactly as the per-device read did', async () => {
    const answer = await h.provider.getChildren({ parentDeviceId: 801 })
    for (const child of answer) {
      expect(child.sourceInfo).toMatchObject({ id: `sensor.child_${child.id}` })
    }
  })
})

describe('projectChildren — the batched answer', () => {
  it('single-parent and batch still answer the same thing, config included', async () => {
    const h = await setup()
    await seedTree(h)
    const batch = await h.provider.getChildrenBatch({ parentDeviceIds: [...PARENT_IDS] })
    for (const parentId of PARENT_IDS) {
      expect(batch[String(parentId)]).toEqual(
        await h.provider.getChildren({ parentDeviceId: parentId }),
      )
    }
  })
})
