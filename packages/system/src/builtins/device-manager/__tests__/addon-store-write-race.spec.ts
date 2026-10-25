/**
 * Every read-modify-write of device-manager's OWN settings row set must be
 * ordered against every other one.
 *
 * `setWrapperActive` reads the whole fleet-wide `deviceBindings` blob, edits
 * one device's slice of it, and writes the whole blob back. Nothing ordered
 * the read against another writer's write, so two activations on DIFFERENT
 * devices — which an operator has every reason to believe are independent —
 * both passed through the same map and the later write silently dropped the
 * earlier one.
 *
 * The value that goes missing is not a nicety. `{ wrapperAddonId: null }` is
 * the explicit "operator disabled" marker: it is what stops `getBindings`
 * step 2 from re-binding a `defaultActive` wrapper. Losing it does not read as
 * "the toggle did not save" — it reads as the camera switching itself back ON
 * (D62: a switch that reports on when it is off is worse than no switch).
 *
 * The window is one settings-door round trip, and on hub-main the door is an
 * RPC to the ISOLATED `sqlite-settings` child: measured 2.9 s for a single-row
 * `get` on the live hub on 2026-08-30 while the storage drain was running
 * (D181). Seconds wide, not milliseconds — which is why the fakes here model
 * the door as something that YIELDS on every call, exactly as
 * `createDoorSettingsView` does, instead of the synchronous `Object.assign`
 * the sibling specs use. A fake that writes without yielding cannot lose an
 * update, and would keep this suite green over the defect.
 *
 * The same shape covers the SIBLING keys on that row set (`locations`,
 * `nextDeviceId`, `roleDisplayDefaults`), because `writeAddonStore` itself is
 * a read-modify-write over the addon's whole key range
 * (`settings-door-view.ts`: `loadPrefixed` → `replacePrefixed`).
 */

import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import type {
  AddonContext,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import type { FakeSettingsStore } from './settings-store-api.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'

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

/** One settings-door round trip. Every door call is an RPC to another process
 *  and every one of them yields — that yield IS the window this file is about. */
function doorRoundTrip(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface DoorLikeSettings {
  readAddonStore(): Promise<Record<string, unknown>>
  writeAddonStore(patch: Record<string, unknown>): Promise<void>
  readDeviceStore(id: number): Promise<Record<string, unknown>>
  writeDeviceStore(id: number, data: Record<string, unknown>): Promise<void>
  clearDeviceStore(id: number): Promise<void>
  readDeviceRuntimeState(): Promise<Record<string, unknown>>
  writeDeviceRuntimeState(): Promise<void>
  clearDeviceRuntimeState(): Promise<void>
  /** How many times the addon-settings row set was READ. */
  addonReads(): number
  /** Hold the NEXT `writeAddonStore` open at the door, so a caller can observe
   *  the system while one writer is mid-flight. */
  parkNextWrite(): ParkedWrite
}

/** A write held at the door: `reached` settles when it gets there, `release`
 *  lets it finish. */
interface ParkedWrite {
  readonly reached: Promise<void>
  release(): void
}

/**
 * The addon-settings surface, with `createDoorSettingsView`'s real semantics:
 * a read is one round trip, and a WRITE is itself read-modify-write (the door
 * loads the addon's whole key range, merges the patch, deletes the range and
 * re-inserts it).
 */
function makeDoorLikeSettings(): DoorLikeSettings {
  let addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  let reads = 0
  let gate: { arrive: () => void; held: Promise<void> } | null = null
  return {
    readAddonStore: async (): Promise<Record<string, unknown>> => {
      reads += 1
      await doorRoundTrip()
      return { ...addonStore }
    },
    writeAddonStore: async (patch: Record<string, unknown>): Promise<void> => {
      await doorRoundTrip()
      const existing = { ...addonStore }
      // The park point is HERE, between the door's own read and its re-insert
      // — the innermost window a writer of this row set is exposed in.
      const parked = gate
      if (parked !== null) {
        gate = null
        parked.arrive()
        await parked.held
      }
      await doorRoundTrip()
      addonStore = { ...existing, ...patch }
    },
    readDeviceStore: async (id: number): Promise<Record<string, unknown>> => ({
      ...deviceStores[id],
    }),
    writeDeviceStore: async (id: number, data: Record<string, unknown>): Promise<void> => {
      deviceStores[id] = { ...data }
    },
    clearDeviceStore: async (id: number): Promise<void> => {
      delete deviceStores[id]
    },
    readDeviceRuntimeState: async (): Promise<Record<string, unknown>> => ({}),
    writeDeviceRuntimeState: async (): Promise<void> => {},
    clearDeviceRuntimeState: async (): Promise<void> => {},
    addonReads: (): number => reads,
    parkNextWrite: (): ParkedWrite => {
      let arrive = (): void => {}
      let release = (): void => {}
      const reached = new Promise<void>((resolve) => {
        arrive = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      gate = { arrive, held }
      return { reached, release: () => release() }
    },
  }
}

interface Harness {
  readonly addon: DeviceManagerAddon
  readonly provider: IDeviceManagerProvider
  readonly store: FakeSettingsStore
  readonly settings: DoorLikeSettings
}

/**
 * `detection-pipeline` is registered as a `defaultActive` wrapper on purpose:
 * that is what makes a LOST deactivation observable through the public read
 * path. With the marker persisted the cap stays unbound; without it, step 2
 * auto-binds the wrapper and the camera is running detection again.
 */
async function setup(): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const store = await makeSettingsStoreApi()
  const settings = makeDoorLikeSettings()
  const capRegistry = new CapabilityRegistry(makeLogger())
  capRegistry.registerWrapper('detection-pipeline', 'detection-pipeline', { defaultActive: true })
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
    settings,
    records,
    kernel: { deviceRegistry: new DeviceRegistry(), capabilityRegistry: capRegistry },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  const providers: readonly ProviderRegistration[] | undefined = Array.isArray(initResult)
    ? initResult
    : initResult?.providers
  const first = providers?.[0]
  if (!first) throw new Error('DeviceManagerAddon did not return provider registrations')
  return { addon, provider: first.provider as IDeviceManagerProvider, store, settings }
}

const CAM_A = 101
const CAM_B = 102
const CAM_CONTROL = 620

/** Is `detection-pipeline` bound for this device, as the runner would see it? */
async function detectionIsBound(addon: DeviceManagerAddon, deviceId: number): Promise<boolean> {
  const { entries } = await addon.getBindings({ deviceId })
  return entries.some((e) => e.capName === 'detection-pipeline')
}

describe('device-manager addon-store writes are ordered against each other', () => {
  it('two setWrapperActive calls on DIFFERENT devices both survive', async () => {
    const h = await setup()
    await seedDeviceRow(h.store, { deviceId: CAM_A, type: 'camera' })
    await seedDeviceRow(h.store, { deviceId: CAM_B, type: 'camera' })
    await seedDeviceRow(h.store, { deviceId: CAM_CONTROL, type: 'camera' })

    // The fixture is live: a camera nobody touched DOES carry the auto-bound
    // `defaultActive` wrapper. Without this the assertions below would pass on
    // a registry that binds nothing at all.
    expect(await detectionIsBound(h.addon, CAM_CONTROL)).toBe(true)

    // Two operators, two cameras, one map. Neither call knows the other exists.
    await Promise.all([
      h.addon.setWrapperActive({
        deviceId: CAM_A,
        capName: 'detection-pipeline',
        wrapperAddonId: 'detection-pipeline',
        active: false,
      }),
      h.addon.setWrapperActive({
        deviceId: CAM_B,
        capName: 'detection-pipeline',
        wrapperAddonId: 'detection-pipeline',
        active: false,
      }),
    ])

    // Behaviour, not a spy: BOTH cameras must stay switched off. The lost
    // update takes the `{wrapperAddonId: null}` marker with it, and step 2
    // then re-binds the `defaultActive` wrapper — the camera switches itself
    // back on.
    expect(await detectionIsBound(h.addon, CAM_A)).toBe(false)
    expect(await detectionIsBound(h.addon, CAM_B)).toBe(false)
    expect(await detectionIsBound(h.addon, CAM_CONTROL)).toBe(true)
  })

  it('a device removal does not drop another device it never named', async () => {
    // `removeDevice` purges the removed device's slice with the SAME
    // read-modify-write over the whole map, and it runs OUTSIDE
    // `withMetaWriteLock` (that lock covers only `rows.remove`). It reads the
    // whole fleet's activations to delete one device's, so it writes back a
    // copy of every OTHER device — including one that changed meanwhile.
    const h = await setup()
    await seedDeviceRow(h.store, { deviceId: CAM_A, type: 'camera' })
    const { id: doomed } = await h.provider.allocateDeviceId({
      addonId: 'rtsp',
      stableId: 'cam-doomed',
    })
    // The doomed device needs an activation of its own, or the purge finds
    // nothing to delete and never writes at all.
    await h.addon.setWrapperActive({
      deviceId: doomed,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })

    // Hold the removal at the exact point it was unprotected: after it has
    // read the fleet-wide map, before it writes the map back.
    const parked = h.settings.parkNextWrite()
    const removal = h.provider.removeDevice({ deviceId: doomed })
    await parked.reached

    // An operator switches a DIFFERENT camera off into that window. Ordered,
    // it queues and lands on top of the purge; unordered it lands first and
    // the purge's pre-read copy of the map then erases it.
    const toggle = h.addon.setWrapperActive({
      deviceId: CAM_A,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    parked.release()
    await Promise.all([removal, toggle])

    expect(await detectionIsBound(h.addon, CAM_A)).toBe(false)
  })

  it('two addLocation calls both land — `locations` is the same shape', async () => {
    const h = await setup()

    await Promise.all([
      h.provider.addLocation({ name: 'Kitchen' }),
      h.provider.addLocation({ name: 'Garage' }),
    ])

    expect([...(await h.provider.listLocations())].sort()).toEqual(['Garage', 'Kitchen'])
  })

  it('two removeLocation calls both take effect', async () => {
    // The mirror image, and it needs its own coverage because `removeLocation`
    // writes `locations` from its OWN pre-read copy: unordered, one deletion
    // resurrects the label the other just removed.
    const h = await setup()
    await h.provider.addLocation({ name: 'Kitchen' })
    await h.provider.addLocation({ name: 'Garage' })
    await h.provider.addLocation({ name: 'Garden' })

    await Promise.all([
      h.provider.removeLocation({ name: 'Kitchen' }),
      h.provider.removeLocation({ name: 'Garage' }),
    ])

    expect([...(await h.provider.listLocations())]).toEqual(['Garden'])
  })

  it('a role-defaults write racing a wrapper toggle keeps both — different KEYS still collide', async () => {
    // `roleDisplayDefaults` is a whole-record replace, so it is not itself
    // read-modify-written and the code said so ("no lock, no RMW"). The write
    // is, though: `createDoorSettingsView.writeAddonStore` loads this addon's
    // whole key range, merges the patch, and re-inserts the range. Two writers
    // naming DIFFERENT keys therefore still lose each other.
    const h = await setup()
    await seedDeviceRow(h.store, { deviceId: CAM_A, type: 'camera' })

    const parked = h.settings.parkNextWrite()
    const roles = h.provider.setRoleDisplayDefaults({ defaults: { battery: { unit: '%' } } })
    await parked.reached

    const toggle = h.addon.setWrapperActive({
      deviceId: CAM_A,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    parked.release()
    await Promise.all([roles, toggle])

    expect((await h.provider.getRoleDisplayDefaults({})).defaults).toHaveProperty('battery')
    expect(await detectionIsBound(h.addon, CAM_A)).toBe(false)
  })

  it('an id allocation racing a wrapper toggle keeps both — and does not deadlock', async () => {
    // `allocateNextDeviceId` bumps `nextDeviceId` on the same row set, from
    // INSIDE `withMetaWriteLock`. Ordering it against the bindings writers
    // means one lock is taken while another is held, so this test is also the
    // proof that the nesting (meta ⊃ addon-store, never the reverse) cannot
    // hang. A deadlock fails it by timing out rather than by asserting.
    const h = await setup()
    await seedDeviceRow(h.store, { deviceId: CAM_A, type: 'camera' })

    const [first, , second] = await Promise.all([
      h.provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-one' }),
      h.addon.setWrapperActive({
        deviceId: CAM_A,
        capName: 'detection-pipeline',
        wrapperAddonId: 'detection-pipeline',
        active: false,
      }),
      h.provider.allocateDeviceId({ addonId: 'rtsp', stableId: 'cam-two' }),
    ])

    // Two distinct devices must never receive the same numeric id.
    expect(first.id).not.toBe(second.id)
    expect(await detectionIsBound(h.addon, CAM_A)).toBe(false)
  })

  it('a read never queues behind a write — the lock is on writers only', async () => {
    // The read side was optimised on 2026-08-30 (`BindingsPass`): the
    // fleet-wide activations blob is resolved once per pass, so a fleet sweep
    // costs a constant number of door round trips whatever the fleet size.
    // Putting `getBindings` / `getAllBindings` under the write lock would undo
    // that in the worst possible way — not by adding a read, but by making a
    // 1 019-device sweep wait on whatever toggle happens to be in flight, on
    // the call `SystemMirror.init` gives 15 s.
    //
    // Asserted as behaviour: a write is PARKED mid-flight, with the lock held,
    // and the reads must still answer. A read that took the lock would never
    // settle and this fails by timing out.
    const h = await setup()
    for (const deviceId of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await seedDeviceRow(h.store, { deviceId, type: 'camera' })
    }
    await h.addon.setWrapperActive({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })

    const parked = h.settings.parkNextWrite()
    const blockedWrite = h.addon.setWrapperActive({
      deviceId: 2,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })
    await parked.reached

    // Both read shapes, while the writer holds the lock.
    const sweep = await h.addon.getAllBindings()
    const single = await h.addon.getBindings({ deviceId: 1 })

    // And they answered with the truth as of the last COMPLETED write —
    // device 1 off, device 2 not yet.
    expect(single.entries.some((e) => e.capName === 'detection-pipeline')).toBe(false)
    expect(sweep.map((r) => r.deviceId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    parked.release()
    await blockedWrite
    expect(await detectionIsBound(h.addon, 2)).toBe(false)
  })
})
