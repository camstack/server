/**
 * Linked devices — resolver modes and the keys' one write path.
 *
 * Mirrors the display-meta.spec harness (real DeviceManagerAddon, in-memory
 * settings, fake device registry). Exercises:
 *   - getLinkedDevices: device-tree CHILDREN always included (both modes);
 *     auto = + same-location devices (null location → children only);
 *     manual = + persisted manual list instead; self excluded; deduped
 *   - config parsing tolerance (string ids, unknown ids dropped)
 *   - that the device manager contributes NO settings section (D655 — the
 *     `linked-devices` extension slot is the editor) and the
 *     `applyLinkedDevicesPatch` normalization the slot writes through
 *   - the pure resolver core
 */

import type {
  AddonContext,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SettingsStoreClient,
} from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
// Import DeviceRegistry from source (not the `@camstack/system` barrel) so the
// suite runs without a built dist — the barrel transitively pulls node-only
// deps (otplib) that vitest doesn't need for this test.
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import type { LinkCandidate } from '../device-linked-devices.js'
import { deviceManagerCapability } from '@camstack/types'
import {
  applyLinkedDevicesPatch,
  LINKED_IDS_CONFIG_KEY,
  LINKED_MODE_CONFIG_KEY,
  LINKED_TRACKED_IDS_CONFIG_KEY,
  parseLinkedDevicesConfig,
  legacyAutoLinkIds,
  resolveLinkedDeviceIds,
  resolveTrackedEventDeviceIds,
} from '../device-linked-devices.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi, readDeviceRow } from './settings-store-api.js'

let fakeIdSeq = 900

class FakeDevice {
  online = true
  parentDeviceId: number | null = null
  features: readonly string[] = []
  type = 'sensor'
  name: string
  readonly id: number
  readonly config = {
    entries: () => [],
    get: () => undefined,
    set: vi.fn(async () => {}),
    setAll: vi.fn(async () => {}),
    onChange: () => () => {},
  }
  constructor(
    readonly stableId: string,
    id?: number,
  ) {
    this.id = id ?? fakeIdSeq++
    this.name = stableId
  }
  removeDevice = vi.fn(async () => {})
}

function asDevice(d: FakeDevice): IDevice {
  return d as unknown as IDevice
}

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
  const addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  const runtimeStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    // The door-backed view answers a whole addon's device rows with ONE indexed
    // range scan. The fake carries it because `listAll` prefers it, and a fake
    // that lacked it would keep exercising the per-device path this suite
    // exists to count.
    readDeviceStoreBatch: vi.fn(async (ids: readonly number[]) => {
      const out = new Map<number, Record<string, unknown>>()
      for (const id of ids) out.set(id, { ...deviceStores[id] })
      return out
    }),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
    clearDeviceStore: vi.fn(async (id: number) => {
      delete deviceStores[id]
    }),
    readDeviceRuntimeState: vi.fn(async (id: number) => ({ ...runtimeStores[id] })),
    writeDeviceRuntimeState: vi.fn(async (id: number, data: Record<string, unknown>) => {
      runtimeStores[id] = { ...data }
    }),
    clearDeviceRuntimeState: vi.fn(async (id: number) => {
      delete runtimeStores[id]
    }),
  }
}

interface Harness {
  provider: IDeviceManagerProvider
  settings: ReturnType<typeof makeSettings>
  registry: DeviceRegistry
  /** The store the fleet listing reads through — exposed so a spec can count
   *  fleet sweeps, which is the entire point of the batch resolver. */
  settingsStore: SettingsStoreClient
  /** The full sqlite-backed store (settingsStore.api plus the raw backend) —
   *  the device LEDGER (meta rows, including `location`) lives here, not in
   *  `settings` (which is the per-device CONFIG blob). Needed to read a
   *  cascaded `location` back off a row without going through the resolver
   *  under test. */
  store: FakeSettingsStore
  /** The fake event bus — exposed so a spec can count `DeviceMetaChanged`
   *  emissions (the cascade's one-event-per-written-row contract). */
  bus: IEventBus
  /** The fake logger — exposed so a spec can assert a partial-cascade
   *  failure was surfaced (`error`), not swallowed. */
  logger: IScopedLogger
}

async function setup(): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const bus: IEventBus = {
    emit: vi.fn(),
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  const logger = makeLogger()
  const registry = new DeviceRegistry()
  const store = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: store.api },
    id: 'device-manager',
    logger,
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    kernel: { deviceRegistry: registry },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')
  return {
    provider: first.provider as IDeviceManagerProvider,
    settings,
    registry,
    settingsStore: store.api,
    store,
    bus,
    logger,
  }
}

async function registerDevice(
  h: Harness,
  dev: FakeDevice,
  opts: { type?: string; location?: string | null; parentDeviceId?: number | null } = {},
): Promise<void> {
  dev.type = opts.type ?? dev.type
  dev.parentDeviceId = opts.parentDeviceId ?? null
  h.registry.register('test-addon', asDevice(dev))
  await h.provider.allocateDeviceId({ addonId: 'test-addon', stableId: dev.stableId })
  await h.provider.registerDevice({
    addonId: 'test-addon',
    stableId: dev.stableId,
    id: dev.id,
    type: dev.type,
    name: dev.stableId,
    location: opts.location ?? null,
    parentDeviceId: opts.parentDeviceId ?? null,
    config: {},
  })
  // `registerDevice` deliberately preserves the meta-row location (operator
  // field) — write it through the canonical action.
  if (opts.location !== undefined && opts.location !== null) {
    await h.provider.setLocation({ deviceId: dev.id, location: opts.location })
  }
}

/** Camera + child + two located sensors: the standard topology. */
async function seedTopology(h: Harness): Promise<{
  cam: FakeDevice
  child: FakeDevice
  gardenSensor: FakeDevice
  kitchenSensor: FakeDevice
}> {
  const cam = new FakeDevice('cam-1')
  await registerDevice(h, cam, { type: 'camera', location: 'garden' })
  const child = new FakeDevice('cam-1-pir')
  await registerDevice(h, child, { parentDeviceId: cam.id, location: null })
  const gardenSensor = new FakeDevice('garden-contact')
  await registerDevice(h, gardenSensor, { location: 'garden' })
  const kitchenSensor = new FakeDevice('kitchen-flood')
  await registerDevice(h, kitchenSensor, { location: 'kitchen' })
  return { cam, child, gardenSensor, kitchenSensor }
}

describe('getLinkedDevices (resolver modes)', () => {
  it('default (D356): device-tree children only — a same-location device is never linked on its own', async () => {
    const h = await setup()
    const { cam, child, gardenSensor, kitchenSensor } = await seedTopology(h)
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    expect(result.mode).toBe('manual')
    const ids = result.devices.map((d) => d.deviceId)
    expect(ids).toEqual([child.id])
    expect(ids).not.toContain(cam.id)
    expect(ids).not.toContain(gardenSensor.id)
    expect(ids).not.toContain(kitchenSensor.id)
  })

  it('with no manual list and no location: children only', async () => {
    const h = await setup()
    const cam = new FakeDevice('cam-nowhere')
    await registerDevice(h, cam, { type: 'camera', location: null })
    const child = new FakeDevice('cam-nowhere-pir')
    await registerDevice(h, child, { parentDeviceId: cam.id })
    const stray = new FakeDevice('stray')
    await registerDevice(h, stray, { location: 'garden' })
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    expect(result.devices.map((d) => d.deviceId)).toEqual([child.id])
  })

  it('manual: children ALWAYS + the persisted list instead of location', async () => {
    const h = await setup()
    const { cam, child, gardenSensor, kitchenSensor } = await seedTopology(h)
    await h.settings.writeDeviceStore(cam.id, {
      [LINKED_MODE_CONFIG_KEY]: 'manual',
      [LINKED_IDS_CONFIG_KEY]: [kitchenSensor.id],
    })
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    expect(result.mode).toBe('manual')
    const ids = result.devices.map((d) => d.deviceId).sort()
    // Child stays linked; the same-location garden sensor is NOT (manual mode).
    expect(ids).toEqual([child.id, kitchenSensor.id].sort())
    expect(ids).not.toContain(gardenSensor.id)
  })

  it('manual: tolerates string ids, drops unknown ids, dedupes children', async () => {
    const h = await setup()
    const { cam, child, gardenSensor } = await seedTopology(h)
    await h.settings.writeDeviceStore(cam.id, {
      [LINKED_MODE_CONFIG_KEY]: 'manual',
      // child.id is redundant with the always-children rule; 99999 is unknown;
      // string ids come from the multiselect option values.
      [LINKED_IDS_CONFIG_KEY]: [String(gardenSensor.id), child.id, 99_999],
    })
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    const ids = result.devices.map((d) => d.deviceId).sort()
    expect(ids).toEqual([child.id, gardenSensor.id].sort())
  })

  /**
   * End-to-end reproduction of the live bug: a camera's device-tree child is
   * a CONTAINER (`type: 'container'`) — `getBindings(container)` is empty by
   * construction — and the real capability lives on the container's own
   * child (a grandchild of the camera). The container must never appear in
   * `getLinkedDevices`; its child must, so it can be picked as a tracked-event
   * producer.
   */
  it('a container device-tree child is excluded; its own child is linked in its place', async () => {
    const h = await setup()
    const cam = new FakeDevice('cam-101')
    await registerDevice(h, cam, { type: 'camera', location: 'front door' })
    const container = new FakeDevice('door-lock-container')
    await registerDevice(h, container, { type: 'container', parentDeviceId: cam.id })
    const realLock = new FakeDevice('door-lock')
    await registerDevice(h, realLock, { type: 'lock', parentDeviceId: container.id })

    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    const ids = result.devices.map((d) => d.deviceId)
    expect(ids).not.toContain(container.id)
    expect(ids).toContain(realLock.id)
  })
})

/**
 * `setLocation` cascade to a parent's descendants (write-time propagation,
 * 2026-08-26 — replaces the read-time `resolveEffectiveLocation` this file
 * used to exercise via `resolveLinkedDeviceIds`; widened from CONTAINER-only
 * to EVERY parent on 2026-09-01). Covers the operator decisions this design
 * made explicit:
 *   - a parent's location is written to EVERY descendant's own `location`
 *     column, recursively, the instant `setLocation` runs on the parent;
 *   - it OVERWRITES a descendant's own, different, location — the cascade is
 *     a write, not a merge;
 *   - the parent's TYPE is irrelevant: a `camera` with accessories cascades
 *     exactly like a container. The Locations page promises "assign the
 *     parent, the accessories follow"; a type predicate here made that a lie
 *     for the 13 non-container parents measured on the hub;
 *   - a `DeviceMetaChanged` event fires for the parent AND for every
 *     descendant actually written, so `getLinkedDevices` (auto mode) sees the
 *     aligned location on the very next read — the end-to-end fix for the
 *     bug `resolveEffectiveLocation` used to paper over at read time.
 */
describe('setLocation cascade to descendants', () => {
  it("writes the container's location onto every descendant, recursively, and emits one DeviceMetaChanged per row written", async () => {
    const h = await setup()
    const container = new FakeDevice('door-lock-container')
    await registerDevice(h, container, { type: 'container' })
    const child = new FakeDevice('door-lock-child')
    await registerDevice(h, child, { type: 'lock', parentDeviceId: container.id })
    const grandchild = new FakeDevice('door-lock-grandchild')
    await registerDevice(h, grandchild, { type: 'sensor', parentDeviceId: child.id })

    const emit = h.bus.emit as ReturnType<typeof vi.fn>
    emit.mockClear()
    await h.provider.setLocation({ deviceId: container.id, location: 'front door' })

    expect((await readDeviceRow(h.store, container.id)).location).toBe('front door')
    expect((await readDeviceRow(h.store, child.id)).location).toBe('front door')
    expect((await readDeviceRow(h.store, grandchild.id)).location).toBe('front door')

    // One event for the container + one per cascaded descendant — never
    // silent, so the auto-link consumer (and anything else subscribed) can
    // react to the container write AND each descendant write individually.
    const emitted = emit.mock.calls.map(
      (c: unknown[]) => c[0] as { data: { field: string; deviceId: number; value: unknown } },
    )
    const locationEvents = emitted.filter((e) => e.data.field === 'location')
    expect(locationEvents.map((e) => e.data.deviceId).sort((a, b) => a - b)).toEqual(
      [container.id, child.id, grandchild.id].sort((a, b) => a - b),
    )
    expect(locationEvents.every((e) => e.data.value === 'front door')).toBe(true)
  })

  it("OVERWRITES a descendant's own, different, location — the cascade is a write, not a merge (deliberate, documented operator decision)", async () => {
    const h = await setup()
    const container = new FakeDevice('multi-room-container')
    await registerDevice(h, container, { type: 'container' })
    const relocatedChild = new FakeDevice('relocated-child')
    // Operator had deliberately split this child into a different room.
    await registerDevice(h, relocatedChild, {
      type: 'sensor',
      parentDeviceId: container.id,
      location: 'kitchen',
    })

    await h.provider.setLocation({ deviceId: container.id, location: 'front door' })

    expect((await readDeviceRow(h.store, relocatedChild.id)).location).toBe('front door')
  })

  it('a NON-container parent (a camera) cascades exactly like a container — the accessories follow', async () => {
    const h = await setup()
    const parent = new FakeDevice('plain-camera')
    await registerDevice(h, parent, { type: 'camera' })
    const child = new FakeDevice('plain-camera-child')
    await registerDevice(h, child, { type: 'sensor', parentDeviceId: parent.id })
    const grandchild = new FakeDevice('plain-camera-grandchild')
    await registerDevice(h, grandchild, { type: 'switch', parentDeviceId: child.id })

    const emit = h.bus.emit as ReturnType<typeof vi.fn>
    emit.mockClear()
    await h.provider.setLocation({ deviceId: parent.id, location: 'garden' })

    expect((await readDeviceRow(h.store, parent.id)).location).toBe('garden')
    expect((await readDeviceRow(h.store, child.id)).location).toBe('garden')
    expect((await readDeviceRow(h.store, grandchild.id)).location).toBe('garden')

    // Same one-event-per-written-row contract as the container path — a
    // cascade the consumers cannot see is a cascade that did not happen.
    const emitted = emit.mock.calls.map(
      (c: unknown[]) => c[0] as { data: { field: string; deviceId: number; value: unknown } },
    )
    const locationEvents = emitted.filter((e) => e.data.field === 'location')
    expect(locationEvents.map((e) => e.data.deviceId).sort((a, b) => a - b)).toEqual(
      [parent.id, child.id, grandchild.id].sort((a, b) => a - b),
    )
  })

  it('a NON-container parent REWRITES a child that already had a location of its own — no exception for an occupied row', async () => {
    const h = await setup()
    const cam = new FakeDevice('camera-with-relocated-accessory')
    await registerDevice(h, cam, { type: 'camera' })
    // The accessory was previously assigned to a different room, exactly the
    // case the container path already overwrites. A non-container parent must
    // not behave differently: two cascade semantics is worse than one.
    const accessory = new FakeDevice('relocated-accessory')
    await registerDevice(h, accessory, {
      type: 'sensor',
      parentDeviceId: cam.id,
      location: 'kitchen',
    })
    expect((await readDeviceRow(h.store, accessory.id)).location).toBe('kitchen')

    await h.provider.setLocation({ deviceId: cam.id, location: 'front door' })

    expect((await readDeviceRow(h.store, accessory.id)).location).toBe('front door')
  })

  it('a leaf device with NO children is still a single row — nothing to cascade to', async () => {
    const h = await setup()
    const lonely = new FakeDevice('lonely-sensor')
    await registerDevice(h, lonely, { type: 'sensor' })
    const unrelated = new FakeDevice('unrelated-sensor')
    await registerDevice(h, unrelated, { type: 'sensor' })

    await h.provider.setLocation({ deviceId: lonely.id, location: 'garden' })

    expect((await readDeviceRow(h.store, lonely.id)).location).toBe('garden')
    // Removing the type predicate must not turn the cascade into a fleet-wide
    // write: only DESCENDANTS move.
    expect((await readDeviceRow(h.store, unrelated.id)).location).toBeNull()
  })

  it('a cascade write failure is surfaced, not silent: succeeding descendants still land and the failure is logged against the PARENT', async () => {
    const h = await setup()
    const container = new FakeDevice('flaky-container')
    await registerDevice(h, container, { type: 'container' })
    const goodChild = new FakeDevice('flaky-good-child')
    await registerDevice(h, goodChild, { type: 'sensor', parentDeviceId: container.id })
    const badChild = new FakeDevice('flaky-bad-child')
    await registerDevice(h, badChild, { type: 'sensor', parentDeviceId: container.id })

    const realUpdateWhere = h.store.backend.updateWhere.bind(h.store.backend)
    const updateSpy = vi
      .spyOn(h.store.backend, 'updateWhere')
      .mockImplementation(async (input: Parameters<typeof realUpdateWhere>[0]) => {
        if (
          input.collection === 'device-manager:devices' &&
          input.filter.where?.id === String(badChild.id)
        ) {
          throw new Error('simulated row-write failure')
        }
        return realUpdateWhere(input)
      })

    await h.provider.setLocation({ deviceId: container.id, location: 'front door' })

    // The good sibling still landed — one failing row does not abort the rest.
    expect((await readDeviceRow(h.store, goodChild.id)).location).toBe('front door')
    // The bad sibling did NOT land — it stayed at its pre-cascade (null) value.
    expect((await readDeviceRow(h.store, badChild.id)).location).toBeNull()
    // The failure is surfaced via the logger, tagged on the PARENT (the
    // device the operator actually acted on) — never indistinguishable from
    // a clean cascade.
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('cascade partially failed'),
      expect.objectContaining({
        tags: { deviceId: container.id },
        meta: expect.objectContaining({ failedIds: [badChild.id] }),
      }),
    )
    updateSpy.mockRestore()
  })
})

describe('linked devices have no settings section (D655)', () => {
  it('the device-manager cap declares no device-settings contribution', () => {
    expect('exposesDeviceSettings' in deviceManagerCapability).toBe(false)
  })

  it('the provider exposes no contribution methods — the extension slot is the editor', async () => {
    const h = await setup()
    expect('getDeviceSettingsContribution' in h.provider).toBe(false)
    expect('getDeviceLiveContribution' in h.provider).toBe(false)
    expect('applyDeviceSettingsPatch' in h.provider).toBe(false)
  })

  it('applyLinkedDevicesPatch normalizes and persists the list, and never writes a mode', async () => {
    const h = await setup()
    const { cam, gardenSensor } = await seedTopology(h)
    await applyLinkedDevicesPatch({ settings: h.settings }, cam.id, {
      [LINKED_MODE_CONFIG_KEY]: 'manual',
      [LINKED_IDS_CONFIG_KEY]: [String(gardenSensor.id), 'not-a-number'],
    })
    const blob = await h.settings.readDeviceStore(cam.id)
    expect(blob[LINKED_MODE_CONFIG_KEY]).toBeUndefined()
    expect(blob[LINKED_IDS_CONFIG_KEY]).toEqual([gardenSensor.id])
  })
})

describe('tracked-event device selection', () => {
  it('defaults to NONE when unset — producing tracked events is an explicit opt-in', () => {
    expect(resolveTrackedEventDeviceIds({}, [5, 6, 7])).toEqual([])
  })
  it('restricts to the configured subset (intersected with linked)', () => {
    const cfg = { [LINKED_TRACKED_IDS_CONFIG_KEY]: [6, 99] }
    expect(resolveTrackedEventDeviceIds(cfg, [5, 6, 7])).toEqual([6])
  })
  it('empty array means NONE produce tracked events', () => {
    const cfg = { [LINKED_TRACKED_IDS_CONFIG_KEY]: [] }
    expect(resolveTrackedEventDeviceIds(cfg, [5, 6, 7])).toEqual([])
  })
})

describe('tracked-event selection persistence (absent vs explicit empty)', () => {
  it('applyLinkedDevicesPatch persists an EXPLICIT EMPTY selection as [] (distinguishable from absent)', async () => {
    const h = await setup()
    const { cam } = await seedTopology(h)
    await applyLinkedDevicesPatch({ settings: h.settings }, cam.id, {
      [LINKED_TRACKED_IDS_CONFIG_KEY]: [],
    })
    const blob = await h.settings.readDeviceStore(cam.id)
    // The key is PRESENT and an empty array — not dropped — so the resolver can
    // tell "operator deselected everything" from "never configured".
    expect(LINKED_TRACKED_IDS_CONFIG_KEY in blob).toBe(true)
    expect(blob[LINKED_TRACKED_IDS_CONFIG_KEY]).toEqual([])
    // End-to-end: no linked device produces tracked events.
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    expect(result.devices.length).toBeGreaterThan(0)
    expect(result.devices.every((d) => d.producesTrackedEvents === false)).toBe(true)
  })
})

describe('getLinkedDevices producesTrackedEvents flag', () => {
  it('defaults all linked devices to producesTrackedEvents=false (opt-in)', async () => {
    const h = await setup()
    const { cam } = await seedTopology(h)
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    expect(result.devices.length).toBeGreaterThan(0)
    expect(result.devices.every((d) => d.producesTrackedEvents === false)).toBe(true)
  })
  it('restricts producesTrackedEvents to the configured subset', async () => {
    const h = await setup()
    const { cam, child, gardenSensor } = await seedTopology(h)
    await h.settings.writeDeviceStore(cam.id, {
      [LINKED_IDS_CONFIG_KEY]: [gardenSensor.id],
      [LINKED_TRACKED_IDS_CONFIG_KEY]: [gardenSensor.id],
    })
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })
    const garden = result.devices.find((d) => d.deviceId === gardenSensor.id)
    const childDev = result.devices.find((d) => d.deviceId === child.id)
    expect(garden?.producesTrackedEvents).toBe(true)
    expect(childDev?.producesTrackedEvents).toBe(false)
  })
})

describe('pure helpers', () => {
  it('parseLinkedDevicesConfig defaults + tolerance', () => {
    expect(parseLinkedDevicesConfig({})).toEqual({ mode: 'manual', manualIds: [] })
    expect(
      parseLinkedDevicesConfig({
        [LINKED_MODE_CONFIG_KEY]: 'manual',
        [LINKED_IDS_CONFIG_KEY]: ['7', 8, 8, 'x', 2.5],
      }),
    ).toEqual({ mode: 'manual', manualIds: [7, 8] })
    // The mode key is history, not an input (D356): any value reads `manual`.
    expect(parseLinkedDevicesConfig({ [LINKED_MODE_CONFIG_KEY]: 'auto' }).mode).toBe('manual')
  })

  it('resolveLinkedDeviceIds: children always, the manual list, self excluded — the legacy auto rule stays testable for the backfill', () => {
    const candidates: LinkCandidate[] = [
      { id: 1, stableId: 's1', parentDeviceId: null, location: 'garden', type: DeviceType.Camera }, // self
      { id: 2, stableId: 's2', parentDeviceId: 1, location: null, type: DeviceType.Sensor }, // child
      { id: 3, stableId: 's3', parentDeviceId: null, location: 'garden', type: DeviceType.Sensor }, // same location
      { id: 4, stableId: 's4', parentDeviceId: null, location: 'kitchen', type: DeviceType.Sensor }, // elsewhere
    ]
    expect(legacyAutoLinkIds({ selfId: 1, selfLocation: 'garden', candidates })).toEqual([3])
    expect(
      resolveLinkedDeviceIds({
        selfId: 1,
        config: { mode: 'manual', manualIds: [4, 99] },
        candidates,
      }),
    ).toEqual([2, 4])
  })

  /**
   * The live bug this task exists for: `getBindings(container)` is empty by
   * construction, `getBindings(child)` has the capability. Excluding the
   * container WITHOUT substituting the child would leave the operator with
   * no selectable entry at all — worse than before. Covers both structural
   * ways a container can be reached: device-tree child of the camera, and a
   * persisted manual pick.
   */
  it('resolveLinkedDeviceIds: a container is never linked — its children are, in its place', () => {
    const candidates: LinkCandidate[] = [
      {
        id: 101,
        stableId: 's101',
        parentDeviceId: null,
        location: 'front door',
        type: DeviceType.Camera,
      }, // self
      {
        id: 4127,
        stableId: 's4127',
        parentDeviceId: 101,
        location: null,
        type: DeviceType.Container,
      }, // container child of camera
      {
        id: 4131,
        stableId: 's4131',
        parentDeviceId: 4127,
        location: null,
        type: DeviceType.Sensor,
      }, // real device, child of container
    ]
    const autoResult = resolveLinkedDeviceIds({
      selfId: 101,
      config: { mode: 'manual', manualIds: [] },
      candidates,
    })
    expect(autoResult).not.toContain(4127)
    expect(autoResult).toContain(4131)

    // Manual mode: the operator's persisted list names the CONTAINER (a
    // stale pick from before this fix, or simply what auto used to surface).
    // It resolves through the same expansion — not stripped from config,
    // just never itself part of the resolved set.
    const manualResult = resolveLinkedDeviceIds({
      selfId: 101,
      config: { mode: 'manual', manualIds: [4127] },
      candidates,
    })
    expect(manualResult).not.toContain(4127)
    expect(manualResult).toContain(4131)
  })

  /**
   * (2026-08-26, adapted — was "…inherits the container location" and
   * asserted the opposite.) Read-time inheritance is GONE: `setLocation`
   * (device-meta-actions.ts) now cascades a container's location to every
   * descendant's own `location` column the instant the operator sets it —
   * matching here is a plain per-candidate field compare, nothing more. A
   * top-level HA-adopted container that shares the camera's `location`
   * while its capability-bearing child underneath is still `location: null`
   * is exactly the pre-cascade state: the operator has not (yet) re-saved
   * the container's location since this design shipped, so the child does
   * NOT auto-link. It gets there the moment the operator touches the
   * container's location again (covered end-to-end in
   * device-meta-actions "setLocation cascade" below) — never by a reader
   * resolving it live.
   */
  it('legacyAutoLinkIds (the retired auto rule, kept for the backfill): a container child with no location of its own is NOT auto-linked — no read-time inheritance', () => {
    const candidates: LinkCandidate[] = [
      {
        id: 101,
        stableId: 's101',
        parentDeviceId: null,
        location: 'front door',
        type: DeviceType.Camera,
      }, // self
      // top-level container, NOT a device-tree child of the camera —
      // reachable only through the same-location match.
      {
        id: 4127,
        stableId: 's4127',
        parentDeviceId: null,
        location: 'front door',
        type: DeviceType.Container,
      },
      {
        id: 4131,
        stableId: 's4131',
        parentDeviceId: 4127,
        location: null,
        type: DeviceType.Sensor,
      },
    ]
    const result = legacyAutoLinkIds({ selfId: 101, selfLocation: 'front door', candidates })
    expect(result).not.toContain(4127)
    expect(result).not.toContain(4131)
  })

  /**
   * The write-time counterpart of the test above: once the descendant's OWN
   * `location` column carries the cascaded value (what `setLocation` writes
   * — simulated here directly on the candidate, since this describes the
   * PURE resolver), the plain field compare links it same as any other
   * candidate. No special-casing needed once the column itself is aligned.
   */
  it('legacyAutoLinkIds (the retired auto rule, kept for the backfill): a descendant WITH the cascaded location on its own column is linked', () => {
    const candidates: LinkCandidate[] = [
      {
        id: 101,
        stableId: 's101',
        parentDeviceId: null,
        location: 'front door',
        type: DeviceType.Camera,
      }, // self
      {
        id: 4127,
        stableId: 's4127',
        parentDeviceId: null,
        location: 'front door',
        type: DeviceType.Container,
      },
      // location now stamped directly on the child's own row — this is what
      // setLocation's cascade produces, not something this resolver derives.
      {
        id: 4131,
        stableId: 's4131',
        parentDeviceId: 4127,
        location: 'front door',
        type: DeviceType.Sensor,
      },
    ]
    const result = legacyAutoLinkIds({ selfId: 101, selfLocation: 'front door', candidates })
    expect(result).not.toContain(4127)
    expect(result).toContain(4131)
  })

  it("resolveLinkedDeviceIds (auto): a child's OWN explicit (non-cascaded) location is never silently overwritten by a read", () => {
    const candidates: LinkCandidate[] = [
      {
        id: 101,
        stableId: 's101',
        parentDeviceId: null,
        location: 'front door',
        type: DeviceType.Camera,
      }, // self
      {
        id: 4127,
        stableId: 's4127',
        parentDeviceId: null,
        location: 'front door',
        type: DeviceType.Container,
      },
      // deliberately relocated by the operator to a DIFFERENT room — must
      // not inherit, and therefore must not auto-link to the front door camera.
      {
        id: 4131,
        stableId: 's4131',
        parentDeviceId: 4127,
        location: 'kitchen',
        type: DeviceType.Sensor,
      },
    ]
    const result = legacyAutoLinkIds({ selfId: 101, selfLocation: 'front door', candidates })
    expect(result).not.toContain(4127)
    expect(result).not.toContain(4131)
  })

  it('resolveLinkedDeviceIds: a childless container contributes nothing (never dropped-then-orphaned)', () => {
    const candidates: LinkCandidate[] = [
      { id: 1, stableId: 's1', parentDeviceId: null, location: null, type: DeviceType.Camera },
      { id: 2, stableId: 's2', parentDeviceId: 1, location: null, type: DeviceType.Container }, // no children at all
    ]
    expect(legacyAutoLinkIds({ selfId: 1, selfLocation: null, candidates })).toEqual([])
  })
})

describe('getLinkedDevicesBatch', () => {
  it('answers exactly what N single calls answer, tagged with the camera', async () => {
    const h = await setup()
    const { cam, child, gardenSensor } = await seedTopology(h)
    const cam2 = new FakeDevice('cam-2')
    await registerDevice(h, cam2, { type: 'camera', location: 'kitchen' })

    const batch = await h.provider.getLinkedDevicesBatch({ deviceIds: [cam.id, cam2.id] })
    const singles = [
      await h.provider.getLinkedDevices({ deviceId: cam.id }),
      await h.provider.getLinkedDevices({ deviceId: cam2.id }),
    ]

    expect(batch).toEqual([
      { deviceId: cam.id, ...singles[0] },
      { deviceId: cam2.id, ...singles[1] },
    ])
    expect(batch[0]?.devices.map((d) => d.deviceId)).toEqual([child.id])
    expect(batch[0]?.devices.map((d) => d.deviceId)).not.toContain(gardenSensor.id)
  })

  /**
   * The whole reason this method exists. Resolving one camera needs the whole
   * fleet as candidates, so the single-device path runs a full listing PER
   * CALL — on the live hub 2026-08-25 that made 30 concurrent
   * `getLinkedDevices` take 4110 ms to return 7260 bytes. A batch that still
   * lists once per camera would pass every assertion above and fix nothing.
   */
  it('reads the fleet ONCE, not once per camera', async () => {
    const h = await setup()
    const { cam } = await seedTopology(h)
    const cams = [cam.id]
    for (let i = 0; i < 5; i += 1) {
      const extra = new FakeDevice(`cam-extra-${i}`)
      await registerDevice(h, extra, { type: 'camera', location: 'garden' })
      cams.push(extra.id)
    }
    const fleetReads = vi.spyOn(h.settingsStore.query, 'query')

    await h.provider.getLinkedDevicesBatch({ deviceIds: cams })
    const batchReads = fleetReads.mock.calls.length
    fleetReads.mockClear()

    for (const id of cams) await h.provider.getLinkedDevices({ deviceId: id })
    const perDeviceReads = fleetReads.mock.calls.length

    expect(batchReads * cams.length).toBeLessThanOrEqual(perDeviceReads)
    expect(perDeviceReads / batchReads).toBeGreaterThanOrEqual(cams.length)
    fleetReads.mockRestore()
  })

  it('dedupes ids and keeps a row for a camera that resolves to nothing', async () => {
    const h = await setup()
    const lonely = new FakeDevice('cam-lonely')
    await registerDevice(h, lonely, { type: 'camera', location: null })

    const out = await h.provider.getLinkedDevicesBatch({
      deviceIds: [lonely.id, lonely.id, 99_999],
    })

    // Both ids answer — an unknown device is `devices: []`, never a gap the
    // caller cannot see. Duplicates collapse.
    expect(out.map((r) => r.deviceId)).toEqual([lonely.id, 99_999])
    expect(out.every((r) => r.devices.length === 0)).toBe(true)
  })

  it('an empty ask reads nothing at all', async () => {
    const h = await setup()
    await seedTopology(h)
    const fleetReads = vi.spyOn(h.settingsStore.query, 'query')

    expect(await h.provider.getLinkedDevicesBatch({ deviceIds: [] })).toEqual([])
    expect(fleetReads).not.toHaveBeenCalled()
    fleetReads.mockRestore()
  })
})

/**
 * The fleet listing is CANDIDATES, and a candidate is five columns.
 *
 * `listAll`'s full projection materialises `config` with one
 * `readDeviceStore` per device, sequentially, on device-manager's event loop —
 * and linked-device policy reads none of it (`resolveFor` takes `config` from
 * the ONE per-camera blob it fetches alongside). Asking for the full
 * projection here therefore swept every device's settings row to use nothing.
 *
 * Measured on the live hub 2026-08-25: 36 814 `query addon-device-settings` a
 * minute over a 967-device fleet, ~38 full-fleet sweeps, most of them behind
 * this one query.
 *
 * The assertion is a COUNT, not a shape: the answer was always correct, and
 * the only thing that ever went wrong was how many reads it cost. It is
 * written against persisted-only devices because the live-registry branch of
 * `listAll` never reads a settings row at all — a fleet that is entirely live
 * would pass this test with the bug in place.
 */
describe('the linked-devices fleet listing costs no per-device settings read', () => {
  /** Persisted, NOT in the live registry — the branch that pays per device. */
  async function seedPersistedOnly(h: Harness, stableId: string, location: string): Promise<void> {
    const dev = new FakeDevice(stableId)
    await h.provider.allocateDeviceId({ addonId: 'forked-addon', stableId })
    await h.provider.registerDevice({
      addonId: 'forked-addon',
      stableId,
      id: dev.id,
      type: 'sensor',
      name: stableId,
      location: null,
      parentDeviceId: null,
      config: {},
    })
    await h.provider.setLocation({ deviceId: dev.id, location })
  }

  it('reads ONE device store — the camera whose config it needs — not one per device', async () => {
    const h = await setup()
    const cam = new FakeDevice('cam-counting')
    await registerDevice(h, cam, { type: 'camera', location: 'garden' })
    for (let i = 0; i < 12; i++) await seedPersistedOnly(h, `sensor-${i}`, 'garden')

    h.settings.readDeviceStore.mockClear()
    const result = await h.provider.getLinkedDevices({ deviceId: cam.id })

    // Still the right answer: every located sensor is linked.
    // Nothing links itself (D356); the point is the ONE read, whatever it resolves.
    expect(result.devices.length).toBe(0)
    // And it cost exactly the camera's own config blob.
    expect(h.settings.readDeviceStore.mock.calls.map(([id]) => id)).toEqual([cam.id])
  })

  /**
   * The other half of the same bill.
   *
   * Narrowing the CALLERS to `slim` fixes the callers that remember. The full
   * projection is still a legitimate request — a dispatch route needs
   * `sourceInfo`, which comes out of `config` — and it used to cost one
   * SEQUENTIAL settings round trip per fleet row on hub-main's event loop. So
   * the count that matters is round TRIPS, not rows: the answer is unchanged,
   * only its price is.
   */
  it('a FULL-projection fleet listing costs ONE store round trip, not one per device', async () => {
    const h = await setup()
    for (let i = 0; i < 40; i++) await seedPersistedOnly(h, `full-proj-${i}`, 'garden')

    h.settings.readDeviceStore.mockClear()
    h.settings.readDeviceStoreBatch.mockClear()
    const all = await h.provider.listAll({})

    expect(all.length).toBeGreaterThanOrEqual(40)
    expect(h.settings.readDeviceStore).not.toHaveBeenCalled()
    expect(h.settings.readDeviceStoreBatch).toHaveBeenCalledTimes(1)
  })

  it('a SLIM fleet listing still reads no per-device store at all', async () => {
    const h = await setup()
    for (let i = 0; i < 40; i++) await seedPersistedOnly(h, `slim-proj-${i}`, 'garden')

    h.settings.readDeviceStore.mockClear()
    h.settings.readDeviceStoreBatch.mockClear()
    await h.provider.listAll({ projection: 'slim' })

    expect(h.settings.readDeviceStore).not.toHaveBeenCalled()
    expect(h.settings.readDeviceStoreBatch).not.toHaveBeenCalled()
  })

  it('the batch pays one camera blob per camera and nothing for the fleet', async () => {
    const h = await setup()
    const cams: number[] = []
    for (let i = 0; i < 3; i++) {
      const cam = new FakeDevice(`cam-batch-${i}`)
      await registerDevice(h, cam, { type: 'camera', location: 'garden' })
      cams.push(cam.id)
    }
    for (let i = 0; i < 12; i++) await seedPersistedOnly(h, `batch-sensor-${i}`, 'garden')

    h.settings.readDeviceStore.mockClear()
    await h.provider.getLinkedDevicesBatch({ deviceIds: cams })

    expect(h.settings.readDeviceStore.mock.calls.map(([id]) => id).sort()).toEqual([...cams].sort())
  })
})

/**
 * A container contributes ONE child — the one it stands for.
 *
 * It used to contribute every child it had, recursively. On a real hub that is
 * what the operator sees: opening a camera's linked devices on a room with a
 * multi-entity climate container lists Batteria, ch9, two window contacts, two
 * "Last seen", humidity, Schedule, three "Temperatura", Update and a siren —
 * a dozen rows for one appliance, none of which is the appliance.
 *
 * A container has no controllable surface of its own, which is why it cannot
 * simply be linked as itself; but "expand it" and "expand it into everything"
 * are different answers, and the second one is a list nobody can use.
 *
 * The child is chosen by `resolveContainerPrimaryChild` — the same rule
 * admin-ui renders a container AS, now living in `@camstack/types` instead of
 * being restated here, in ui-library, in the HA adoption mapping and in the
 * viewer.
 */
describe('resolveLinkedDeviceIds: a container contributes its PRIMARY child only', () => {
  it('links the defining actuator, not its auxiliary entities', () => {
    const candidates: LinkCandidate[] = [
      {
        id: 101,
        stableId: 's101',
        parentDeviceId: null,
        location: 'hall',
        type: DeviceType.Camera,
      },
      {
        id: 900,
        stableId: 's900',
        parentDeviceId: 101,
        location: null,
        type: DeviceType.Container,
      },
      { id: 901, stableId: 's901', parentDeviceId: 900, location: null, type: DeviceType.Sensor },
      { id: 902, stableId: 's902', parentDeviceId: 900, location: null, type: DeviceType.Climate },
      { id: 903, stableId: 's903', parentDeviceId: 900, location: null, type: DeviceType.Switch },
    ]
    const result = resolveLinkedDeviceIds({
      selfId: 101,
      config: { mode: 'manual', manualIds: [] },
      candidates,
    })
    expect(result).toContain(902)
    expect(result).not.toContain(901)
    expect(result).not.toContain(903)
    expect(result).not.toContain(900)
  })

  it('still contributes nothing for a childless container', () => {
    const candidates: LinkCandidate[] = [
      {
        id: 101,
        stableId: 's101',
        parentDeviceId: null,
        location: 'hall',
        type: DeviceType.Camera,
      },
      {
        id: 900,
        stableId: 's900',
        parentDeviceId: 101,
        location: null,
        type: DeviceType.Container,
      },
    ]
    const result = resolveLinkedDeviceIds({
      selfId: 101,
      config: { mode: 'manual', manualIds: [] },
      candidates,
    })
    expect(result).not.toContain(900)
    expect(result).toHaveLength(0)
  })

  it('resolves a container-of-containers to one leaf, not to a subtree', () => {
    const candidates: LinkCandidate[] = [
      {
        id: 101,
        stableId: 's101',
        parentDeviceId: null,
        location: 'hall',
        type: DeviceType.Camera,
      },
      {
        id: 900,
        stableId: 's900',
        parentDeviceId: 101,
        location: null,
        type: DeviceType.Container,
      },
      {
        id: 910,
        stableId: 's910',
        parentDeviceId: 900,
        location: null,
        type: DeviceType.Container,
      },
      { id: 911, stableId: 's911', parentDeviceId: 910, location: null, type: DeviceType.Light },
      { id: 912, stableId: 's912', parentDeviceId: 910, location: null, type: DeviceType.Sensor },
    ]
    const result = resolveLinkedDeviceIds({
      selfId: 101,
      config: { mode: 'manual', manualIds: [] },
      candidates,
    })
    expect(result).toEqual([911])
  })
})

/**
 * A container contributes ONE child, and WHICH one the operator gets to decide.
 *
 * Both halves of that decision have to survive the `slim` projection this
 * module is pinned to (it exists to stop a measured 36 814-queries-per-minute
 * config sweep). They do, because both are columns: the pick sits on the
 * container's row and `stableId` on each child's. Keying the match on
 * `sourceInfo.id` — which lives in the config blob `slim` does not read —
 * would have missed the pick for 677 of the 925 live container children whose
 * `sourceInfo.id` differs from their `stableId`, and fallen back to priority
 * while looking exactly like an operator who never chose.
 */
describe('resolveLinkedDeviceIds: the container primary child', () => {
  const camera: LinkCandidate = {
    id: 101,
    stableId: 's101',
    parentDeviceId: null,
    location: 'front door',
    type: DeviceType.Camera,
  }
  const kids: LinkCandidate[] = [
    {
      id: 556,
      stableId: 'gree:light',
      parentDeviceId: 554,
      location: null,
      type: DeviceType.Switch,
    },
    { id: 555, stableId: 'gree:ac', parentDeviceId: 554, location: null, type: DeviceType.Climate },
  ]
  const resolve = (primaryChildEntityId?: string | null): readonly number[] =>
    resolveLinkedDeviceIds({
      selfId: 101,
      config: { mode: 'manual', manualIds: [] },
      candidates: [
        camera,
        {
          id: 554,
          stableId: 's554',
          parentDeviceId: 101,
          location: null,
          type: DeviceType.Container,
          ...(primaryChildEntityId !== undefined ? { primaryChildEntityId } : {}),
        },
        ...kids,
      ],
    })

  it('defaults to the defining actuator, not to the first child', () => {
    const ids = resolve()
    expect(ids).toContain(555)
    expect(ids).not.toContain(556)
  })

  it("honours the operator's pick over the type default", () => {
    // The whole reason the pick exists: the operator wants the LIGHT, not the
    // climate the priority list would choose.
    const ids = resolve('gree:light')
    expect(ids).toContain(556)
    expect(ids).not.toContain(555)
  })

  it('falls back to the default when the pick names nothing that exists', () => {
    // A re-sync that dropped the chosen entity must leave the container
    // represented, not blank.
    expect(resolve('gree:gone')).toContain(555)
  })

  it('treats a cleared pick as no pick', () => {
    expect(resolve(null)).toContain(555)
  })
})

/**
 * The LOCATION rule must agree with the container rule.
 *
 * Measured on the live hub for "Camera hall" (104): 15 linked devices,
 * of which ten were container children listed individually — three "Batteria",
 * three "Last seen"/"Temperatura" pairs, and the six children of "Clima zona
 * giorno". The operator saw a dozen rows for three appliances.
 *
 * The container-expansion path was already fixed to contribute ONE child. This
 * path never went through it: `setLocation` CASCADES a container's location
 * onto its descendants' own `location` column, so every child matches the
 * camera's location individually and is added directly. Skipping the container
 * here — on the stated grounds that "every real candidate is matched
 * individually below" — is exactly what let all of them in.
 */
describe('legacyAutoLinkIds: location must not bypass the container rule', () => {
  const CAM = 104
  const camera: LinkCandidate = {
    id: CAM,
    stableId: 's104',
    parentDeviceId: null,
    location: 'Hall',
    type: DeviceType.Camera,
  }
  // "Clima zona giorno": a container whose six children all inherited Hall.
  const container: LinkCandidate = {
    id: 4266,
    stableId: 's4266',
    parentDeviceId: null,
    location: 'Hall',
    type: DeviceType.Container,
  }
  const children: LinkCandidate[] = [
    {
      id: 4267,
      stableId: 'upd',
      parentDeviceId: 4266,
      location: 'Hall',
      type: DeviceType.Update,
    },
    {
      id: 4268,
      stableId: 'hum',
      parentDeviceId: 4266,
      location: 'Hall',
      type: DeviceType.Sensor,
    },
    {
      id: 4271,
      stableId: 'clima',
      parentDeviceId: 4266,
      location: 'Hall',
      type: DeviceType.Thermostat,
    },
    {
      id: 4272,
      stableId: 'sched',
      parentDeviceId: 4266,
      location: 'Hall',
      type: DeviceType.Sensor,
    },
  ]
  const resolve = (): readonly number[] =>
    legacyAutoLinkIds({
      selfId: CAM,
      selfLocation: 'Hall',
      candidates: [camera, container, ...children],
    })

  it('contributes ONE child for the container, not all of them', () => {
    const ids = resolve().filter((id) => id !== CAM)
    expect(ids).toHaveLength(1)
  })

  it('and it is the defining actuator', () => {
    // The thermostat IS the appliance; Update, humidity and Schedule are its
    // auxiliaries. Same precedence the container path uses.
    expect(resolve()).toContain(4271)
  })

  it('never lists the container itself', () => {
    expect(resolve()).not.toContain(4266)
  })

  it('still links a same-location device that has no container parent', () => {
    const loose: LinkCandidate = {
      id: 591,
      stableId: 's591',
      parentDeviceId: null,
      location: 'Hall',
      type: DeviceType.Sensor,
    }
    const ids = legacyAutoLinkIds({
      selfId: CAM,
      selfLocation: 'Hall',
      candidates: [camera, loose],
    })
    expect(ids).toContain(591)
  })
})
