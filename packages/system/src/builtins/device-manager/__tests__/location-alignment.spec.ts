/**
 * Location alignment — the two RETROACTIVITY holes D252/D329 left open.
 *
 * The cascade (`setLocation` → every descendant's own `location` column) only
 * runs when `setLocation` is CALLED. Measured on the live hub 2026-09-04:
 * 40 containers whose location predated the cascade carried 373 children at
 * `location: null` — the whole container invisible to auto-mode linking, with
 * not one log line saying so. This suite covers the mechanism that closes it:
 *
 *   1. a ONE-SHOT boot backfill (marker-guarded) that fills every
 *      null-location descendant of a located ancestor — fill-null-only, an
 *      automated pass carries no operator intent and must never overwrite an
 *      explicit different location (only `setLocation` may);
 *   2. an EVERY-BOOT read-only detection that WARNS per misaligned ancestor —
 *      the state can re-enter (partial cascade failure) and must never again
 *      be silent;
 *   3. registration-time inheritance: a child adopted AFTER its container's
 *      location was set inherits it the instant it registers — the same hole
 *      reopened by every later-adopted child, closed at the same write-time
 *      layer the cascade lives in (never at read time). Container ancestors
 *      only: a located CAMERA's accessories are reachable structurally, and a
 *      location on their own column would leak them into every other
 *      same-room camera's companions;
 *   4. the auto-link resolver LOGS a container it skips whose children could
 *      never match — a branch that drops work says so.
 */

import type {
  AddonContext,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import type { PersistedDeviceMeta } from '../device-meta-types.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { LOCATION_BACKFILL_MARKER_KEY, planNullLocationFills } from '../location-alignment.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi, readDeviceRow } from './settings-store-api.js'

let idSeq = 7000

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

/** The durable state a reboot carries over: the sqlite ledger + addon store. */
interface PersistentState {
  readonly store: FakeSettingsStore
  readonly settings: ReturnType<typeof makeSettings>
}

interface BootHandle {
  readonly provider: IDeviceManagerProvider
  readonly logger: IScopedLogger
  readonly bus: IEventBus
  readonly state: PersistentState
}

/**
 * One device-manager "boot" over the given persistent state. A fresh addon
 * instance, registry and bus each time — exactly what a hub restart gives the
 * builtin — while the ledger and addon store survive.
 */
async function boot(shared?: PersistentState): Promise<BootHandle> {
  const state: PersistentState = shared ?? {
    store: await makeSettingsStoreApi(),
    settings: makeSettings(),
  }
  const addon = new DeviceManagerAddon()
  const bus: IEventBus = {
    emit: vi.fn(),
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  const logger = makeLogger()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: state.store.api },
    id: 'device-manager',
    logger,
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings: state.settings,
    records,
    kernel: { deviceRegistry: new DeviceRegistry() },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')
  return { provider: first.provider as IDeviceManagerProvider, logger, bus, state }
}

/** Register a device through the canonical action path. */
async function register(
  h: BootHandle,
  opts: { type?: string; parentDeviceId?: number | null; location?: string } = {},
): Promise<number> {
  const id = idSeq++
  const stableId = `align-dev-${id}`
  await h.provider.allocateDeviceId({ addonId: 'test-addon', stableId })
  await h.provider.registerDevice({
    addonId: 'test-addon',
    stableId,
    id,
    type: opts.type ?? 'sensor',
    name: stableId,
    location: null,
    parentDeviceId: opts.parentDeviceId ?? null,
    config: {},
  })
  if (opts.location !== undefined) {
    await h.provider.setLocation({ deviceId: id, location: opts.location })
  }
  return id
}

/**
 * Write a location straight onto the ledger row, bypassing `setLocation` and
 * therefore its cascade — the exact persisted state of a container whose
 * location predates the cascade shipping (or whose cascade partially failed).
 */
async function writeLocationRaw(
  state: PersistentState,
  deviceId: number,
  location: string,
): Promise<void> {
  await state.store.backend.updateWhere({
    collection: 'device-manager:devices',
    filter: { where: { id: String(deviceId) } },
    data: { location },
  })
}

/** Reset the one-shot marker to the pre-upgrade state. */
async function resetBackfillMarker(state: PersistentState): Promise<void> {
  await state.settings.writeAddonStore({ [LOCATION_BACKFILL_MARKER_KEY]: 0 })
}

function locationEventsOf(bus: IEventBus): Array<{ deviceId: number; value: unknown }> {
  const emit = bus.emit as ReturnType<typeof vi.fn>
  return emit.mock.calls
    .map(
      (c: unknown[]) => c[0] as { data?: { field?: string; deviceId?: number; value?: unknown } },
    )
    .filter((e) => e.data?.field === 'location')
    .map((e) => ({ deviceId: e.data?.deviceId as number, value: e.data?.value }))
}

function meta(over: Partial<PersistedDeviceMeta> & { id: number }): PersistedDeviceMeta {
  return {
    type: 'sensor',
    name: `d${over.id}`,
    addonId: 'test-addon',
    stableId: `s${over.id}`,
    location: null,
    disabled: false,
    parentDeviceId: null,
    ...over,
  }
}

describe('planNullLocationFills (pure)', () => {
  it('fills a null-location child AND grandchild from the located ancestor', () => {
    const rows = [
      meta({ id: 1, location: 'front door', type: DeviceType.Container }),
      meta({ id: 2, parentDeviceId: 1 }),
      meta({ id: 3, parentDeviceId: 2 }),
    ]
    const plan = planNullLocationFills(rows)
    expect(plan.map((f) => f.id).sort((a, b) => a - b)).toEqual([2, 3])
    expect(plan.every((f) => f.location === 'front door' && f.ancestorId === 1)).toBe(true)
  })

  it('prefers the NEAREST located ancestor over a farther one', () => {
    const rows = [
      meta({ id: 1, location: 'casa', type: DeviceType.Container }),
      meta({ id: 2, parentDeviceId: 1, location: 'kitchen', type: DeviceType.Container }),
      meta({ id: 3, parentDeviceId: 2 }),
    ]
    const plan = planNullLocationFills(rows)
    expect(plan).toEqual([{ id: 3, location: 'kitchen', ancestorId: 2 }])
  })

  /**
   * D352 narrowing (operator decision, 2026-09-05): an automated fill runs
   * ONLY when the nearest located ancestor is a CONTAINER. A non-container
   * parent's subtree (camera + siren/floodlight) is already fully reachable
   * through the structural children rule — its accessories gain nothing from
   * a location, and what a location COSTS was verified on the live fleet
   * shape: a camera child that gains the room becomes a location-match
   * companion of EVERY other camera in that room (`ids.add`, no container
   * expansion on a camera parent) — the exact cross-camera noise the panel
   * was cleaned of twice. Verified with the real resolver over the real
   * fleet + a synthetic second Hall camera: filling siren 591 added it to
   * the second camera's linked set.
   */
  it('fills NOTHING under a located NON-container parent — a camera subtree is structural', () => {
    const rows = [
      meta({ id: 104, location: 'Hall', type: DeviceType.Camera }),
      meta({ id: 591, parentDeviceId: 104 }),
      meta({ id: 3220, parentDeviceId: 104 }),
    ]
    expect(planNullLocationFills(rows)).toEqual([])
  })

  it('a located CAMERA between the child and a located container BLOCKS the fill — nearest located ancestor decides', () => {
    const rows = [
      meta({ id: 1, location: 'casa', type: DeviceType.Container }),
      meta({ id: 2, parentDeviceId: 1, location: 'Hall', type: DeviceType.Camera }),
      meta({ id: 3, parentDeviceId: 2 }),
    ]
    expect(planNullLocationFills(rows)).toEqual([])
  })

  it("leaves a descendant's explicit different location alone — fill-null-only", () => {
    const rows = [
      meta({ id: 1, location: 'front door', type: DeviceType.Container }),
      meta({ id: 2, parentDeviceId: 1, location: 'kitchen' }),
    ]
    expect(planNullLocationFills(rows)).toEqual([])
  })

  it('plans nothing when no ancestor carries a location', () => {
    const rows = [meta({ id: 1 }), meta({ id: 2, parentDeviceId: 1 })]
    expect(planNullLocationFills(rows)).toEqual([])
  })

  it('survives a pathological parent cycle in persisted data', () => {
    const rows = [
      meta({ id: 1, parentDeviceId: 2 }),
      meta({ id: 2, parentDeviceId: 1 }),
      meta({ id: 3, location: 'garden', type: DeviceType.Container }),
      meta({ id: 4, parentDeviceId: 3 }),
    ]
    const plan = planNullLocationFills(rows)
    expect(plan).toEqual([{ id: 4, location: 'garden', ancestorId: 3 }])
  })
})

describe('boot backfill — one-shot repair of pre-cascade containers', () => {
  it('aligns a legacy subtree at boot, recursively, emitting one DeviceMetaChanged per written row and logging per ancestor', async () => {
    const h1 = await boot()
    const containerId = await register(h1, { type: 'container' })
    const childId = await register(h1, { type: 'lock', parentDeviceId: containerId })
    const grandchildId = await register(h1, { type: 'sensor', parentDeviceId: childId })
    // Legacy state: the container's location landed BEFORE the cascade shipped.
    await writeLocationRaw(h1.state, containerId, 'front door')
    await resetBackfillMarker(h1.state)

    const h2 = await boot(h1.state)

    expect((await readDeviceRow(h2.state.store, childId)).location).toBe('front door')
    expect((await readDeviceRow(h2.state.store, grandchildId)).location).toBe('front door')
    // COALESCED: one `DeviceMetaChanged` per repaired ANCESTOR, never one per
    // row. The viewer invalidates its meta-sensitive queries on EVERY event of
    // this category (device-meta-invalidation.tsx, deliberately broad), so a
    // fleet-wide backfill emitting per row would fire hundreds of client
    // invalidations at boot for one repair. One event per subtree carries the
    // identical effect for every derived-state consumer, and the per-device
    // boot consumers re-warm from rows afterwards (`SystemAddonsReady`).
    const events = locationEventsOf(h2.bus)
    expect(events).toEqual([{ deviceId: containerId, value: 'front door' }])
    // Never a silent mass write: one line per repaired ancestor, device-tagged.
    expect(h2.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('location backfill'),
      expect.objectContaining({ tags: { deviceId: containerId } }),
    )
  })

  it('END-TO-END: after the backfill boot, the container child carries the camera location the picker suggests by', async () => {
    const h1 = await boot()
    const camId = await register(h1, { type: 'camera', location: 'front door' })
    const containerId = await register(h1, { type: 'container' })
    const lockId = await register(h1, { type: 'lock', parentDeviceId: containerId })
    await writeLocationRaw(h1.state, containerId, 'front door')
    await resetBackfillMarker(h1.state)

    const h2 = await boot(h1.state)
    // D356: nothing links by location any more — what the cascade buys is
    // that the child carries the camera's location, so the picker SUGGESTS it.
    expect((await readDeviceRow(h2.state.store, lockId)).location).toBe(
      (await readDeviceRow(h2.state.store, camId)).location,
    )
  })

  it("never overwrites a descendant's explicit different location", async () => {
    const h1 = await boot()
    const containerId = await register(h1, { type: 'container' })
    const relocatedId = await register(h1, {
      type: 'sensor',
      parentDeviceId: containerId,
      location: 'kitchen',
    })
    await writeLocationRaw(h1.state, containerId, 'front door')
    await resetBackfillMarker(h1.state)

    const h2 = await boot(h1.state)

    expect((await readDeviceRow(h2.state.store, relocatedId)).location).toBe('kitchen')
  })

  it('runs ONCE: with the marker set, later misalignment is NOT rewritten — but IS warned about, every boot', async () => {
    const h1 = await boot() // marker lands on this clean first boot
    const containerId = await register(h1, { type: 'container' })
    const childId = await register(h1, { type: 'lock', parentDeviceId: containerId })
    // State re-entered AFTER the one-shot already ran (e.g. a partial cascade).
    await writeLocationRaw(h1.state, containerId, 'front door')

    const h2 = await boot(h1.state)

    // Not repaired — the one-shot must not fight an operator's later edits.
    expect((await readDeviceRow(h2.state.store, childId)).location).toBeNull()
    // But never silent: the detection names the ancestor to re-save.
    expect(h2.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('misaligned'),
      expect.objectContaining({
        tags: { deviceId: containerId },
        meta: expect.objectContaining({
          location: 'front door',
          misalignedDescendantIds: [childId],
        }),
      }),
    )
  })

  /**
   * The live 7-row state (sirens/floodlight under located cameras 103, 109,
   * 587, 104, 592, 101) is the operator's DELIBERATE exclusion, left alone:
   * a camera's accessories are already linked structurally to their own
   * camera, and giving them a location would leak them into every other
   * same-room camera's companions (verified against the real fleet shape).
   * So the backfill does not touch them AND the detection does not nag about
   * them — a state we chose not to repair must not be warned about forever.
   */
  it('camera-child misalignment is neither repaired NOR warned — structural linking covers it', async () => {
    const h1 = await boot()
    const camId = await register(h1, { type: 'camera' })
    const sirenId = await register(h1, { type: 'siren', parentDeviceId: camId })
    await writeLocationRaw(h1.state, camId, 'front door')
    await resetBackfillMarker(h1.state)

    const h2 = await boot(h1.state)

    expect((await readDeviceRow(h2.state.store, sirenId)).location).toBeNull()
    expect(h2.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('misaligned'),
      expect.anything(),
    )
  })

  it('a clean fleet boots with no repair writes and no warnings', async () => {
    const h1 = await boot()
    const containerId = await register(h1, { type: 'container', location: 'front door' })
    await register(h1, { type: 'lock', parentDeviceId: containerId })

    const writesBefore = h1.state.store.writes.length
    const h2 = await boot(h1.state)

    const ledgerWrites = h2.state.store.writes
      .slice(writesBefore)
      .filter((w) => w.collection === 'device-manager:devices' && w.op !== 'set')
    expect(ledgerWrites).toEqual([])
    expect(h2.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('misaligned'),
      expect.anything(),
    )
  })
})

describe('registerDevice — a later-adopted child inherits the located ancestor at write time', () => {
  it('a child adopted AFTER the container location was set carries it on its own row, with a DeviceMetaChanged', async () => {
    const h = await boot()
    const containerId = await register(h, { type: 'container', location: 'front door' })
    const emit = h.bus.emit as ReturnType<typeof vi.fn>
    emit.mockClear()

    const childId = await register(h, { type: 'lock', parentDeviceId: containerId })

    expect((await readDeviceRow(h.state.store, childId)).location).toBe('front door')
    const events = locationEventsOf(h.bus)
    expect(events).toContainEqual({ deviceId: childId, value: 'front door' })
  })

  it('END-TO-END: the late-adopted child carries the location the picker suggests by — no re-save needed', async () => {
    const h = await boot()
    const camId = await register(h, { type: 'camera', location: 'front door' })
    const containerId = await register(h, { type: 'container', location: 'front door' })

    const lockId = await register(h, { type: 'lock', parentDeviceId: containerId })

    // D356: the picker suggests it by location; nothing links it on its own.
    expect((await readDeviceRow(h.state.store, lockId)).location).toBe(
      (await readDeviceRow(h.state.store, camId)).location,
    )
  })

  it('a child adopted under a located CAMERA does NOT inherit — its own camera already links it structurally', async () => {
    const h = await boot()
    const camId = await register(h, { type: 'camera', location: 'front door' })

    const sirenId = await register(h, { type: 'siren', parentDeviceId: camId })

    // No location stamped: a camera accessory with the room on its own column
    // would auto-link to every OTHER camera in the room (cross-camera noise);
    // its own camera needs no location to reach it.
    expect((await readDeviceRow(h.state.store, sirenId)).location).toBeNull()
    const result = await h.provider.getLinkedDevices({ deviceId: camId })
    expect(result.devices.map((d) => d.deviceId)).toContain(sirenId)
  })

  it('a row that already carries a location keeps it — inheritance fills null only', async () => {
    const h = await boot()
    const containerId = await register(h, { type: 'container', location: 'front door' })
    // The device exists first with its own explicit room…
    const childId = await register(h, { type: 'sensor', location: 'kitchen' })
    // …and is then re-registered (re-parented) under the located container.
    await h.provider.registerDevice({
      addonId: 'test-addon',
      stableId: `align-dev-${childId}`,
      id: childId,
      type: 'sensor',
      name: `align-dev-${childId}`,
      location: null,
      parentDeviceId: containerId,
      config: {},
    })

    expect((await readDeviceRow(h.state.store, childId)).location).toBe('kitchen')
  })

  it('out-of-order adoption: a middle parent registered after its own child pulls the ancestor location down to it', async () => {
    const h = await boot()
    const grandparentId = await register(h, { type: 'container', location: 'garden' })
    // The leaf registers FIRST, naming a parent the ledger does not know yet.
    const middleId = idSeq++
    const leafId = await register(h, { type: 'sensor', parentDeviceId: middleId })
    expect((await readDeviceRow(h.state.store, leafId)).location).toBeNull()
    // Now the middle container arrives, under the located grandparent.
    await h.provider.allocateDeviceId({ addonId: 'test-addon', stableId: `align-dev-${middleId}` })
    await h.provider.registerDevice({
      addonId: 'test-addon',
      stableId: `align-dev-${middleId}`,
      id: middleId,
      type: 'container',
      name: `align-dev-${middleId}`,
      location: null,
      parentDeviceId: grandparentId,
      config: {},
    })

    expect((await readDeviceRow(h.state.store, middleId)).location).toBe('garden')
    expect((await readDeviceRow(h.state.store, leafId)).location).toBe('garden')
  })
})
