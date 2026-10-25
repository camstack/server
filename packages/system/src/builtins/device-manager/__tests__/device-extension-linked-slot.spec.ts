/**
 * D648 / D655 — the `linked-devices` extension slot, the only editor of a
 * camera's linked devices and of their tracked-event opt-in, over the keys
 * `getLinkedDevices` resolves from.
 *
 * Real `DeviceManagerAddon`, in-memory settings (the harness of
 * `device-linked-devices.spec.ts`). Pins:
 *   - `listSlots` answers exactly the manual list `getLinkedDevices` resolves
 *     from, with each pick's health (a deleted pick is shown, never dropped),
 *     and the stored tracked-event opt-in;
 *   - a `setSlot` write persists byte-for-byte what `applyLinkedDevicesPatch`
 *     persists, and the resolver reads it back — picks and opt-in;
 *   - the opt-in: absent on a write leaves it untouched, one for a device that
 *     is not picked is refused by name, one the editor cannot see is kept;
 *   - a NEW container pick (and the camera itself) is refused by name before
 *     anything is persisted; an already-persisted one is kept;
 *   - candidates never offer the camera, its tree children or a container, and
 *     suggest (never save) devices in the camera's location;
 *   - a non-camera host gets no slot.
 */
import type {
  AddonContext,
  IDeviceExtensionProvider,
  IDeviceManagerProvider,
  IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import {
  applyLinkedDevicesPatch,
  LINKED_IDS_CONFIG_KEY,
  LINKED_TRACKED_IDS_CONFIG_KEY,
} from '../device-linked-devices.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi, type FakeSettingsStore } from './settings-store-api.js'
import {
  isDeviceExtensionProvider,
  isDeviceManagerProvider,
  makeAddonContext,
  providerOf,
  registrationsOf,
} from './typed-addon-context.js'

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

/** The per-device config blobs, and the settings surface over them. */
interface SettingsHarness {
  readonly stores: Record<number, Record<string, unknown>>
  readonly settings: NonNullable<AddonContext['settings']>
}

function makeSettings(): SettingsHarness {
  const stores: Record<number, Record<string, unknown>> = {}
  const addonStore: Record<string, unknown> = {}
  return {
    stores,
    settings: {
      readAddonStore: async () => ({ ...addonStore }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      },
      readDeviceStoreBatch: async (ids: readonly number[]) =>
        new Map(ids.map((id) => [id, { ...stores[id] }])),
      listDeviceStoreIds: async () => Object.keys(stores).map(Number),
      readDeviceStore: async (id: number) => ({ ...stores[id] }),
      writeDeviceStore: async (id: number, data: Record<string, unknown>) => {
        stores[id] = { ...data }
      },
      clearDeviceStore: async (id: number) => {
        delete stores[id]
      },
      readDeviceRuntimeState: async () => ({}),
      writeDeviceRuntimeState: async () => undefined,
      clearDeviceRuntimeState: async () => undefined,
      getSection: async () => ({}),
      setSection: async () => undefined,
    },
  }
}

interface Harness {
  readonly manager: IDeviceManagerProvider
  readonly extension: IDeviceExtensionProvider
  readonly settings: SettingsHarness['settings']
  readonly stores: SettingsHarness['stores']
  readonly logger: IScopedLogger
  /** The ledger — so a spec can COUNT fleet reads (`list` scans vs `getMany`). */
  readonly store: FakeSettingsStore
}

async function setup(): Promise<Harness> {
  const addon = new DeviceManagerAddon()
  const { stores, settings } = makeSettings()
  const logger = makeLogger()
  const store = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = makeAddonContext({
    id: 'device-manager',
    logger,
    settings,
    records,
    api: { settingsStore: store.api },
  })
  const regs = registrationsOf(await addon.initialize(ctx))
  return {
    manager: providerOf(regs, 'device-manager', isDeviceManagerProvider),
    extension: providerOf(regs, 'device-extension', isDeviceExtensionProvider),
    settings,
    stores,
    logger,
    store,
  }
}

/** A ledger-only device: what `listAll` answers for a device a forked runner owns. */
interface DeviceRef {
  readonly id: number
}

async function add(
  h: Harness,
  name: string,
  opts: { type?: string; location?: string | null; parentDeviceId?: number | null } = {},
): Promise<DeviceRef> {
  const stableId = name
  const { id } = await h.manager.allocateDeviceId({ addonId: 'test-addon', stableId })
  await h.manager.registerDevice({
    addonId: 'test-addon',
    stableId,
    id,
    type: opts.type ?? 'sensor',
    name,
    location: null,
    parentDeviceId: opts.parentDeviceId ?? null,
    config: {},
  })
  if (opts.location !== undefined && opts.location !== null) {
    await h.manager.setLocation({ deviceId: id, location: opts.location })
  }
  return { id }
}

const SLOT_REF = 'device-manager:linked-devices'

async function topology(h: Harness) {
  const cam = await add(h, 'cam-101', { type: 'camera', location: 'porch' })
  const child = await add(h, 'cam-101-pir', { parentDeviceId: cam.id })
  const porch = await add(h, 'porch-contact', { location: 'porch' })
  const kitchen = await add(h, 'kitchen-flood', { location: 'kitchen' })
  const container = await add(h, 'lock-container', { type: 'container', location: 'porch' })
  const lock = await add(h, 'lock', { type: 'lock', parentDeviceId: container.id })
  return { cam, child, porch, kitchen, container, lock }
}

async function slotValueOf(h: Harness, deviceId: number): Promise<unknown> {
  const rows = await h.extension.listSlots({ deviceId })
  const row = rows[0]
  return row?.state === 'ok' ? row.value : null
}

describe('linked-devices slot — the keys the resolver reads', () => {
  it('lists exactly the manual list getLinkedDevices resolves from, with health', async () => {
    const h = await setup()
    const { cam, kitchen } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, {
      [LINKED_IDS_CONFIG_KEY]: [String(kitchen.id), 99_999],
    })

    const rows = await h.extension.listSlots({ deviceId: cam.id })
    expect(rows).toEqual([
      expect.objectContaining({
        state: 'ok',
        slotRef: SLOT_REF,
        slot: 'linked-devices',
        authority: 'device-manager:_linkedDeviceIds',
        // No opt-in stored: NONE, the answer the resolver gives.
        value: { slot: 'linked-devices', deviceIds: [kitchen.id, 99_999], trackedDeviceIds: [] },
        sources: [
          { deviceId: kitchen.id, name: 'kitchen-flood', health: 'ok' },
          expect.objectContaining({ deviceId: 99_999, name: null, health: 'missing' }),
        ],
      }),
    ])
    const resolved = await h.manager.getLinkedDevices({ deviceId: cam.id })
    expect(resolved.devices.map((d) => d.deviceId)).toContain(kitchen.id)
  })

  it('a setSlot write persists byte-for-byte what applyLinkedDevicesPatch persists', async () => {
    const h = await setup()
    const { cam, porch, kitchen } = await topology(h)
    const twin = await add(h, 'cam-102', { type: 'camera' })
    const tracked = { [LINKED_TRACKED_IDS_CONFIG_KEY]: [porch.id] }
    await h.settings.writeDeviceStore(cam.id, { ...tracked })
    await h.settings.writeDeviceStore(twin.id, { ...tracked })

    await h.extension.setSlot({
      deviceId: cam.id,
      slotRef: SLOT_REF,
      value: { slot: 'linked-devices', deviceIds: [porch.id, kitchen.id] },
    })
    await applyLinkedDevicesPatch({ settings: h.settings }, twin.id, {
      [LINKED_IDS_CONFIG_KEY]: [String(porch.id), String(kitchen.id)],
    })
    expect(JSON.stringify(h.stores[cam.id])).toBe(JSON.stringify(h.stores[twin.id]))
  })

  it('the resolver reads what setSlot wrote — the picks and the opt-in', async () => {
    const h = await setup()
    const { cam, porch, kitchen } = await topology(h)

    await h.extension.setSlot({
      deviceId: cam.id,
      slotRef: SLOT_REF,
      value: {
        slot: 'linked-devices',
        deviceIds: [porch.id, kitchen.id],
        trackedDeviceIds: [porch.id],
      },
    })
    const resolved = await h.manager.getLinkedDevices({ deviceId: cam.id })
    const byId = new Map(resolved.devices.map((d) => [d.deviceId, d]))
    expect(byId.get(porch.id)?.producesTrackedEvents).toBe(true)
    expect(byId.get(kitchen.id)?.producesTrackedEvents).toBe(false)
    expect(await slotValueOf(h, cam.id)).toEqual({
      slot: 'linked-devices',
      deviceIds: [porch.id, kitchen.id],
      trackedDeviceIds: [porch.id],
    })
  })
})

describe('linked-devices slot — the tracked-event opt-in (D655)', () => {
  it('a write without an opt-in leaves the stored one untouched', async () => {
    const h = await setup()
    const { cam, porch, kitchen } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, {
      [LINKED_IDS_CONFIG_KEY]: [porch.id],
      [LINKED_TRACKED_IDS_CONFIG_KEY]: [porch.id],
    })
    await h.extension.setSlot({
      deviceId: cam.id,
      slotRef: SLOT_REF,
      value: { slot: 'linked-devices', deviceIds: [porch.id, kitchen.id] },
    })
    expect(h.stores[cam.id]?.[LINKED_TRACKED_IDS_CONFIG_KEY]).toEqual([porch.id])
  })

  it('an explicit empty opt-in is stored as [] — un-ticking the last device', async () => {
    const h = await setup()
    const { cam, porch } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, {
      [LINKED_IDS_CONFIG_KEY]: [porch.id],
      [LINKED_TRACKED_IDS_CONFIG_KEY]: [porch.id],
    })
    await h.extension.setSlot({
      deviceId: cam.id,
      slotRef: SLOT_REF,
      value: { slot: 'linked-devices', deviceIds: [porch.id], trackedDeviceIds: [] },
    })
    expect(h.stores[cam.id]?.[LINKED_TRACKED_IDS_CONFIG_KEY]).toEqual([])
  })

  it('refuses a NEW opt-in for a device the camera does not link, by name — nothing persisted', async () => {
    const h = await setup()
    const { cam, porch, kitchen } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, { [LINKED_IDS_CONFIG_KEY]: [porch.id] })
    await expect(
      h.extension.setSlot({
        deviceId: cam.id,
        slotRef: SLOT_REF,
        value: { slot: 'linked-devices', deviceIds: [porch.id], trackedDeviceIds: [kitchen.id] },
      }),
    ).rejects.toThrow(new RegExp(`linked device, not ${kitchen.id}`))
    expect(h.stores[cam.id]).toEqual({ [LINKED_IDS_CONFIG_KEY]: [porch.id] })
    expect(h.logger.warn).toHaveBeenCalledWith(
      'linked-devices: write refused — nothing persisted',
      expect.objectContaining({ tags: { deviceId: cam.id } }),
    )
  })

  it('what was read writes back unchanged — a stored opt-in outside the picks included', async () => {
    const h = await setup()
    const { cam, child, porch, kitchen } = await topology(h)
    const stored = {
      [LINKED_IDS_CONFIG_KEY]: [porch.id],
      // A tree child, and a device no longer picked: both outside the picks.
      [LINKED_TRACKED_IDS_CONFIG_KEY]: [child.id, kitchen.id, porch.id],
    }
    await h.settings.writeDeviceStore(cam.id, { ...stored })
    const read = await slotValueOf(h, cam.id)
    if (read === null || typeof read !== 'object') throw new Error('no linked-devices value')
    expect(read).toEqual({
      slot: 'linked-devices',
      deviceIds: [porch.id],
      trackedDeviceIds: [child.id, kitchen.id, porch.id],
    })
    await expect(
      h.extension.setSlot({
        deviceId: cam.id,
        slotRef: SLOT_REF,
        value: {
          slot: 'linked-devices',
          deviceIds: [porch.id],
          trackedDeviceIds: [child.id, kitchen.id, porch.id],
        },
      }),
    ).resolves.toEqual({ applied: true, reload: 'none' })
    expect(h.stores[cam.id]).toEqual(stored)
  })

  it('a written opt-in REPLACES the stored one — a stale one is removed by leaving it out', async () => {
    const h = await setup()
    const { cam, porch, kitchen } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, {
      [LINKED_IDS_CONFIG_KEY]: [porch.id],
      [LINKED_TRACKED_IDS_CONFIG_KEY]: [kitchen.id, porch.id],
    })
    await h.extension.setSlot({
      deviceId: cam.id,
      slotRef: SLOT_REF,
      value: { slot: 'linked-devices', deviceIds: [porch.id], trackedDeviceIds: [porch.id] },
    })
    expect(h.stores[cam.id]?.[LINKED_TRACKED_IDS_CONFIG_KEY]).toEqual([porch.id])
  })
})

describe('linked-devices slot — devices linked by structure (D655, D356)', () => {
  it('lists the tree children as implied sources, never as picks', async () => {
    const h = await setup()
    const { cam, child, porch } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, { [LINKED_IDS_CONFIG_KEY]: [porch.id] })
    const rows = await h.extension.listSlots({ deviceId: cam.id })
    const row = rows[0]
    if (row?.state !== 'ok') throw new Error('expected one ok row')
    expect(row.value).toMatchObject({ deviceIds: [porch.id] })
    expect(row.impliedSources).toEqual([{ deviceId: child.id, name: 'cam-101-pir', health: 'ok' }])
  })

  it('a picked container is never a source of its own — the child it stands for is implied', async () => {
    const h = await setup()
    const { cam, child, container, lock } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, { [LINKED_IDS_CONFIG_KEY]: [container.id] })
    const rows = await h.extension.listSlots({ deviceId: cam.id })
    const row = rows[0]
    if (row?.state !== 'ok') throw new Error('expected one ok row')
    const implied = (row.impliedSources ?? []).map((s) => s.deviceId)
    expect(implied).toEqual(expect.arrayContaining([child.id, lock.id]))
    expect(implied).not.toContain(container.id)
    // The same set the resolver answers — the policy is its function, not a copy.
    const resolved = await h.manager.getLinkedDevices({ deviceId: cam.id })
    expect(resolved.devices.map((d) => d.deviceId).toSorted()).toEqual(implied.toSorted())
  })

  it('a tree child can be opted in, and then produces tracked events', async () => {
    const h = await setup()
    const { cam, child, porch } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, { [LINKED_IDS_CONFIG_KEY]: [porch.id] })
    await h.extension.setSlot({
      deviceId: cam.id,
      slotRef: SLOT_REF,
      value: { slot: 'linked-devices', deviceIds: [porch.id], trackedDeviceIds: [child.id] },
    })
    const resolved = await h.manager.getLinkedDevices({ deviceId: cam.id })
    const byId = new Map(resolved.devices.map((d) => [d.deviceId, d]))
    expect(byId.get(child.id)?.producesTrackedEvents).toBe(true)
    expect(byId.get(porch.id)?.producesTrackedEvents).toBe(false)
  })
})

describe('linked-devices slot — picks and candidates', () => {
  it('refuses a NEW container pick and the camera itself by name — nothing persisted', async () => {
    const h = await setup()
    const { cam, porch, container } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, { [LINKED_IDS_CONFIG_KEY]: [porch.id] })

    await expect(
      h.extension.setSlot({
        deviceId: cam.id,
        slotRef: SLOT_REF,
        value: { slot: 'linked-devices', deviceIds: [porch.id, container.id, cam.id] },
      }),
    ).rejects.toThrow(new RegExp(`${container.id} is a container.*${cam.id} is the camera itself`))
    expect(h.stores[cam.id]).toEqual({ [LINKED_IDS_CONFIG_KEY]: [porch.id] })
    expect(h.logger.warn).toHaveBeenCalledWith(
      'linked-devices: write refused — nothing persisted',
      expect.objectContaining({ tags: { deviceId: cam.id } }),
    )
  })

  it('keeps a container that was ALREADY persisted, and shows it as unavailable', async () => {
    const h = await setup()
    const { cam, porch, container } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, { [LINKED_IDS_CONFIG_KEY]: [container.id] })

    const rows = await h.extension.listSlots({ deviceId: cam.id })
    const row = rows[0]
    expect(row?.state === 'ok' ? row.sources[0]?.health : null).toBe('unavailable')
    await expect(
      h.extension.setSlot({
        deviceId: cam.id,
        slotRef: SLOT_REF,
        value: { slot: 'linked-devices', deviceIds: [container.id, porch.id] },
      }),
    ).resolves.toEqual({ applied: true, reload: 'none' })
  })

  it('candidates: never self, its children or a container; same location suggested', async () => {
    const h = await setup()
    const { cam, child, porch, kitchen, container, lock } = await topology(h)
    const { candidates } = await h.extension.listCandidates({ deviceId: cam.id, slotRef: SLOT_REF })
    const ids = candidates.map((c) => c.deviceId)
    expect(ids).not.toContain(cam.id)
    expect(ids).not.toContain(child.id)
    expect(ids).not.toContain(container.id)
    expect(ids).toEqual(expect.arrayContaining([porch.id, kitchen.id, lock.id]))
    expect(candidates.find((c) => c.deviceId === porch.id)).toMatchObject({
      suggested: true,
      reason: 'same location',
    })
    expect(candidates.find((c) => c.deviceId === kitchen.id)?.suggested).toBe(false)
    expect(candidates.find((c) => c.deviceId === lock.id)?.parentName).toBe('lock-container')
    // A suggestion is never saved on its own (D356).
    expect(h.stores[cam.id]).toBeUndefined()
  })

  it('lists without a fleet scan — the picked ids are read by id, in one batch', async () => {
    const h = await setup()
    const { cam, porch, kitchen } = await topology(h)
    await h.settings.writeDeviceStore(cam.id, { [LINKED_IDS_CONFIG_KEY]: [porch.id, kitchen.id] })
    const query = vi.spyOn(h.store.backend, 'query')
    await h.extension.listSlots({ deviceId: cam.id })
    const ledgerReads = query.mock.calls
      .map(([input]) => input)
      .filter((input) => input.collection === 'device-manager:devices')
    // Every ledger read names its ids; not one lists the fleet.
    expect(ledgerReads.length).toBeGreaterThan(0)
    for (const input of ledgerReads)
      expect(input.filter?.whereIn ?? input.filter?.where).toBeDefined()
    // The two picks are labelled by ONE batched read, not one per id; the
    // camera's subtree is read by parent, one level per read (D655).
    const byId = ledgerReads.filter((input) => input.filter?.whereIn?.['deviceId'] !== undefined)
    expect(byId).toHaveLength(1)
  })

  it('a non-camera host is offered no slot', async () => {
    const h = await setup()
    const { porch } = await topology(h)
    expect(await h.extension.listSlots({ deviceId: porch.id })).toEqual([])
  })
})
