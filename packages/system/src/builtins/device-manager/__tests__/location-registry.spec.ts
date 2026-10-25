/**
 * `removeLocation({ cascade: true })` is a read-modify-write over device rows,
 * and it must take the same write lock every other device writer takes.
 *
 * It did not. The cascade read the whole `deviceMeta` blob, computed a new map
 * with the matching devices' `location` set to `null`, and wrote it back —
 * entirely OUTSIDE `withMetaWriteLock`, while `setName` / `setLocation` /
 * `setDisabled` / `registerDevice` all ran inside it. Two losses followed from
 * that, and the blob shape made the second one much worse:
 *
 *   - an operator `setLocation` landing between the cascade's read and its
 *     write was silently reverted to `null`;
 *   - the cascade wrote the WHOLE map, so a `registerDevice` in the same window
 *     had its entire freshly-written row replaced by the pre-read snapshot.
 *
 * The flatten removes the second (a column write cannot carry a stale copy of
 * another device's row) and leaves the first, which is what this file pins:
 * the operator's write is ordered against the cascade rather than racing it.
 */

import { DeviceRegistry } from '@camstack/system'
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
import { makeSettingsStoreApi, readDeviceRow } from './settings-store-api.js'

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

/** The addon-settings surface: locations live here, devices do not. */
function makeSettings() {
  let addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: async (): Promise<Record<string, unknown>> => ({ ...addonStore }),
    writeAddonStore: async (patch: Record<string, unknown>): Promise<void> => {
      addonStore = { ...addonStore, ...patch }
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
  }
}

async function setup(): Promise<{
  provider: IDeviceManagerProvider
  store: FakeSettingsStore
  /** The ADDON store — where `locations` actually lives. `listLocations`
   *  de-duplicates case-insensitively on read, so a duplicate written into this
   *  array is invisible through the provider. Reading it raw is the only way to
   *  pin that a rename does not accumulate labels. */
  settings: ReturnType<typeof makeSettings>
}> {
  const addon = new DeviceManagerAddon()
  const store = await makeSettingsStoreApi()
  const bus: IEventBus = {
    emit: vi.fn(),
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  const settings = makeSettings()
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
    kernel: { deviceRegistry: new DeviceRegistry() },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  const providers: readonly ProviderRegistration[] | undefined = Array.isArray(initResult)
    ? initResult
    : initResult?.providers
  const first = providers?.[0]
  if (!first) throw new Error('DeviceManagerAddon did not return provider registrations')
  return { provider: first.provider as IDeviceManagerProvider, store, settings }
}

async function seedDevice(
  provider: IDeviceManagerProvider,
  stableId: string,
  location: string,
): Promise<number> {
  const { id } = await provider.allocateDeviceId({ addonId: 'rtsp', stableId })
  await provider.registerDevice({
    addonId: 'rtsp',
    stableId,
    id,
    type: 'camera',
    name: stableId,
    parentDeviceId: null,
    config: {},
  })
  await provider.setLocation({ deviceId: id, location })
  return id
}

describe('removeLocation cascade', () => {
  it('clears the label from every device that referenced it', async () => {
    const { provider, store } = await setup()
    const kitchen = await seedDevice(provider, 'cam-kitchen', 'Kitchen')
    const garage = await seedDevice(provider, 'cam-garage', 'Garage')
    await provider.addLocation({ name: 'Kitchen' })

    // Case-insensitive + trimmed, same equality the registry uses.
    await provider.removeLocation({ name: '  kitchen ', cascade: true })

    expect((await readDeviceRow(store, kitchen)).location).toBeNull()
    expect((await readDeviceRow(store, garage)).location).toBe('Garage')
    expect(await provider.listLocations()).toEqual(['Garage'])
  })

  it('leaves devices alone without cascade — the registry is a suggestion list', async () => {
    const { provider, store } = await setup()
    const kitchen = await seedDevice(provider, 'cam-kitchen', 'Kitchen')
    await provider.addLocation({ name: 'Kitchen' })

    await provider.removeLocation({ name: 'Kitchen' })

    expect((await readDeviceRow(store, kitchen)).location).toBe('Kitchen')
  })

  it('does not revert an operator setLocation that races it', async () => {
    const { provider, store } = await setup()
    const kitchen = await seedDevice(provider, 'cam-kitchen', 'Kitchen')

    // Hold the cascade open at the exact point the old code was unprotected:
    // after it has read the fleet, before it writes. `setLocation` is fired
    // into that window. Under the write lock it QUEUES and lands last; without
    // it, the cascade's write follows and silently reverts the operator.
    let releaseCascade = (): void => {}
    const cascadeReached = new Promise<void>((resolve) => {
      const gate = new Promise<void>((release) => {
        releaseCascade = release
      })
      const realQuery = store.api.query.query
      store.api.query.query = async (input: Parameters<typeof realQuery>[0]) => {
        const rows = await realQuery(input)
        if (input.collection === 'device-manager:devices') {
          store.api.query.query = realQuery
          resolve()
          await gate
        }
        return rows
      }
    })

    const cascade = provider.removeLocation({ name: 'Kitchen', cascade: true })
    await cascadeReached
    const operator = provider.setLocation({ deviceId: kitchen, location: 'Garage' })
    // Give the operator's call every chance to land first if nothing orders it.
    // Under the lock it is parked on a promise only `releaseCascade` can settle,
    // so this window cannot let it through; without the lock it runs to
    // completion here and the cascade then overwrites it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseCascade()
    await Promise.all([cascade, operator])

    expect((await readDeviceRow(store, kitchen)).location).toBe('Garage')
  })
})

/**
 * `renameLocation` — one server operation, because the client sequence was not.
 *
 * The admin UI renamed a room as `addLocation(new)` → N × `setLocation(device,
 * new)` → `removeLocation(old)`, all from the browser. Three separate calls
 * with no transaction between them: a closed tab, a lost network or a reload
 * halfway leaves the fleet SPLIT across two rooms, one of which the operator
 * believes no longer exists.
 *
 * The shape mirrors `removeLocation({ cascade: true })` exactly, including the
 * part that is not obvious: the registry edit takes the addon-store lock and
 * RELEASES it before the device cascade takes the meta lock. Holding both, in
 * that order, is the reverse of `allocateNextDeviceId`'s meta ⊃ addon-store
 * nesting — the pair that deadlocks.
 */
describe('renameLocation', () => {
  it('replaces the label and moves every device that referenced it', async () => {
    const { provider, store } = await setup()
    const kitchen = await seedDevice(provider, 'cam-kitchen', 'Kitchen')
    const garage = await seedDevice(provider, 'cam-garage', 'Garage')
    await provider.addLocation({ name: 'Kitchen' })
    await provider.addLocation({ name: 'Garage' })

    await provider.renameLocation({ from: 'Kitchen', to: 'Kitchen grande' })

    expect((await readDeviceRow(store, kitchen)).location).toBe('Kitchen grande')
    expect((await readDeviceRow(store, garage)).location).toBe('Garage')
    // `listLocations` sorts and folds in labels carried by devices, so what is
    // pinned here is the SET, not an order. An earlier version of this test
    // claimed to pin in-place ordering; disarming the implementation to append
    // left it green, which is how the claim was found to be empty.
    expect(await provider.listLocations()).toEqual(['Garage', 'Kitchen grande'])
  })

  it('matches `from` the way the rest of the registry does — trimmed, case-insensitive', async () => {
    const { provider, store } = await setup()
    const kitchen = await seedDevice(provider, 'cam-kitchen', 'Kitchen')
    await provider.addLocation({ name: 'Kitchen' })

    await provider.renameLocation({ from: '  kitchen ', to: 'Sala' })

    expect((await readDeviceRow(store, kitchen)).location).toBe('Sala')
    expect(await provider.listLocations()).toEqual(['Sala'])
  })

  it('applies a case-only rename instead of dismissing it as a no-op', async () => {
    const { provider, store } = await setup()
    const kitchen = await seedDevice(provider, 'cam-kitchen', 'kitchen')
    await provider.addLocation({ name: 'kitchen' })

    // Fixing the capitalisation of a room is a real edit, and the equality the
    // registry uses would call this "already present" and drop it.
    await provider.renameLocation({ from: 'kitchen', to: 'Kitchen' })

    expect(await provider.listLocations()).toEqual(['Kitchen'])
    expect((await readDeviceRow(store, kitchen)).location).toBe('Kitchen')
  })

  it('merges into an existing room without leaving a duplicate label', async () => {
    const { provider, store, settings } = await setup()
    const a = await seedDevice(provider, 'cam-a', 'Sala')
    const b = await seedDevice(provider, 'cam-b', 'Hall')
    await provider.addLocation({ name: 'Sala' })
    await provider.addLocation({ name: 'Hall' })

    await provider.renameLocation({ from: 'Sala', to: 'Hall' })

    expect((await readDeviceRow(store, a)).location).toBe('Hall')
    expect((await readDeviceRow(store, b)).location).toBe('Hall')
    expect(await provider.listLocations()).toEqual(['Hall'])
    // `listLocations` would fold a duplicate away, so the assertion above
    // cannot see one. The stored array can, and it is what grows: without the
    // target being dropped first, every rename onto an existing room appends
    // another copy of that room's label, forever.
    expect((await settings.readAddonStore()).locations).toEqual(['Hall'])
  })

  it('refuses an empty target and writes NOTHING — not the registry, not a device', async () => {
    const { provider, store } = await setup()
    const kitchen = await seedDevice(provider, 'cam-kitchen', 'Kitchen')
    await provider.addLocation({ name: 'Kitchen' })

    await expect(provider.renameLocation({ from: 'Kitchen', to: '   ' })).rejects.toThrow()

    // A half-applied rename is the exact failure this method exists to remove.
    expect(await provider.listLocations()).toEqual(['Kitchen'])
    expect((await readDeviceRow(store, kitchen)).location).toBe('Kitchen')
  })

  it('reports how many devices it moved', async () => {
    const { provider } = await setup()
    await seedDevice(provider, 'cam-a', 'Sala')
    await seedDevice(provider, 'cam-b', 'Sala')
    await seedDevice(provider, 'cam-c', 'Kitchen')
    await provider.addLocation({ name: 'Sala' })

    const result = await provider.renameLocation({ from: 'Sala', to: 'Hall' })

    // The UI says what happened. A silent count is how "it did nothing" and
    // "it did everything" end up looking the same.
    expect(result).toEqual({ moved: 2 })
  })

  it('renames a room that is not in the registry, because devices still carry it', async () => {
    const { provider, store } = await setup()
    const ghost = await seedDevice(provider, 'cam-ghost', 'Ripostiglio')

    // The registry is a suggestion list: a label can exist on devices without
    // being registered (a deleted room, an import). Refusing here would leave
    // the only devices that need the rename unreachable.
    const result = await provider.renameLocation({ from: 'Ripostiglio', to: 'Sgabuzzino' })

    expect((await readDeviceRow(store, ghost)).location).toBe('Sgabuzzino')
    expect(result).toEqual({ moved: 1 })
  })
})

/**
 * The location ICON map — a second key beside the registry, because a location
 * is a label and not a row, so there is nowhere else to hang one.
 *
 * Two things this pins that nothing else can:
 *
 *   - it is keyed on `locationIconKey` (trimmed, lower-cased), the equality the
 *     registry already matches on. Keyed on the displayed casing instead, a
 *     case-only rename — a real edit this repo supports, see above — would
 *     silently orphan the icon;
 *   - rename and remove CARRY IT. A key left behind survives in a map nobody
 *     lists, and a room re-created under the same name later inherits an icon
 *     its operator never chose.
 *
 * And a value outside the closed vocabulary reads as ABSENT, never as itself:
 * the whole reason the set is closed is that both surfaces can draw every
 * member, and an id from a hand-edit or a newer hub is exactly the value a
 * renderer can only draw as a hole.
 */
describe('location icons', () => {
  it('stores an icon and returns it under the folded key', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Kitchen' })

    await provider.setLocationIcon({ location: '  Kitchen ', icon: 'utensils' })

    expect(await provider.listLocationIcons()).toEqual([
      { locationKey: 'kitchen', icon: 'utensils' },
    ])
  })

  it('leaves a location with no icon ABSENT — never a default pin', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Kitchen' })
    await provider.addLocation({ name: 'Garage' })
    await provider.setLocationIcon({ location: 'Garage', icon: 'car' })

    // The fallback is the renderer's job. Folding it in here would make "the
    // operator picked the pin" and "the operator picked nothing" the same
    // answer, and the picker has to draw them differently.
    expect(await provider.listLocationIcons()).toEqual([{ locationKey: 'garage', icon: 'car' }])
  })

  it('clears an assignment with `icon: null`', async () => {
    const { provider } = await setup()
    await provider.setLocationIcon({ location: 'Kitchen', icon: 'utensils' })

    await provider.setLocationIcon({ location: 'kitchen', icon: null })

    expect(await provider.listLocationIcons()).toEqual([])
  })

  it('refuses an empty label', async () => {
    const { provider } = await setup()
    await expect(provider.setLocationIcon({ location: '   ', icon: 'car' })).rejects.toThrow()
  })

  it('accepts a label nobody registered — the registry is a suggestion list', async () => {
    const { provider } = await setup()
    await seedDevice(provider, 'cam-ghost', 'Ripostiglio')

    await provider.setLocationIcon({ location: 'Ripostiglio', icon: 'package' })

    expect(await provider.listLocationIcons()).toEqual([
      { locationKey: 'ripostiglio', icon: 'package' },
    ])
  })

  it('drops a stored id outside the vocabulary instead of handing it to a renderer', async () => {
    const { provider, settings } = await setup()
    // A hand-edit, a partial restore, or a hub ahead of this one.
    await settings.writeAddonStore({ locationIcons: { kitchen: 'teapot', garage: 'car' } })

    expect(await provider.listLocationIcons()).toEqual([{ locationKey: 'garage', icon: 'car' }])
  })

  it('survives a case-only rename, which is what the folded key is FOR', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'kitchen' })
    await provider.setLocationIcon({ location: 'kitchen', icon: 'utensils' })

    await provider.renameLocation({ from: 'kitchen', to: 'Kitchen' })

    expect(await provider.listLocationIcons()).toEqual([
      { locationKey: 'kitchen', icon: 'utensils' },
    ])
  })

  it('moves the icon with a rename', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Kitchen' })
    await provider.setLocationIcon({ location: 'Kitchen', icon: 'utensils' })

    await provider.renameLocation({ from: 'Kitchen', to: 'Kitchen grande' })

    expect(await provider.listLocationIcons()).toEqual([
      { locationKey: 'kitchen grande', icon: 'utensils' },
    ])
  })

  it('moves the icon even when the room was never registered', async () => {
    const { provider } = await setup()
    await seedDevice(provider, 'cam-ghost', 'Ripostiglio')
    await provider.setLocationIcon({ location: 'Ripostiglio', icon: 'package' })

    // The registry edit is a no-op here (nothing to rewrite), and an early
    // return on that alone parks the icon on a key no location will carry
    // again — an orphan that reads as "the icon was lost".
    await provider.renameLocation({ from: 'Ripostiglio', to: 'Sgabuzzino' })

    expect(await provider.listLocationIcons()).toEqual([
      { locationKey: 'sgabuzzino', icon: 'package' },
    ])
  })

  it('keeps the TARGET icon when a rename merges two rooms', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Sala' })
    await provider.addLocation({ name: 'Hall' })
    await provider.setLocationIcon({ location: 'Sala', icon: 'car' })
    await provider.setLocationIcon({ location: 'Hall', icon: 'sofa' })

    // Renaming Sala into Hall moves DEVICES into Hall. It does not restyle
    // the room they are moving into.
    await provider.renameLocation({ from: 'Sala', to: 'Hall' })

    expect(await provider.listLocationIcons()).toEqual([{ locationKey: 'hall', icon: 'sofa' }])
  })

  it('drops the icon when the room is removed, so a re-created room does not inherit it', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Kitchen' })
    await provider.setLocationIcon({ location: 'Kitchen', icon: 'utensils' })

    await provider.removeLocation({ name: 'Kitchen', cascade: true })
    await provider.addLocation({ name: 'Kitchen' })

    expect(await provider.listLocationIcons()).toEqual([])
  })
})

describe('location descriptions', () => {
  // What a place LOOKS like, given to the vision model with the pictures. It
  // used to live in the post-analysis addon's own settings, keyed by a
  // hand-typed label matched exactly — so a rename here carried the icon and
  // silently orphaned the description. These tests pin the thing that fixed:
  // description and icon obey the SAME key and the SAME lifecycle.
  it('stores a description and returns it under the folded key', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Parking' })

    await provider.setLocationDescription({
      location: '  Parking ',
      description: 'Selciato fra un muro di mattoni e tre posti auto.',
    })

    expect(await provider.listLocationDescriptions()).toEqual([
      {
        locationKey: 'parking',
        description: 'Selciato fra un muro di mattoni e tre posti auto.',
      },
    ])
  })

  it('treats a blank description as no description', async () => {
    // An empty line sent to the model is worse than none: it spends attention
    // and says nothing. So "" and null are the same instruction.
    const { provider } = await setup()
    await provider.setLocationDescription({ location: 'Sala', description: 'Divano e camino.' })

    await provider.setLocationDescription({ location: 'Sala', description: '   ' })

    expect(await provider.listLocationDescriptions()).toEqual([])
  })

  it('clears a description with null', async () => {
    const { provider } = await setup()
    await provider.setLocationDescription({ location: 'Sala', description: 'Divano e camino.' })

    await provider.setLocationDescription({ location: 'sala', description: null })

    expect(await provider.listLocationDescriptions()).toEqual([])
  })

  it('refuses an empty label', async () => {
    const { provider } = await setup()
    await expect(
      provider.setLocationDescription({ location: '   ', description: 'x' }),
    ).rejects.toThrow()
  })

  it('carries the description through a rename, exactly like the icon', async () => {
    // THE defect this move exists to remove: before, the icon followed the
    // rename and the description stayed behind on a key no location carries.
    const { provider } = await setup()
    await provider.addLocation({ name: 'Sala' })
    await provider.setLocationIcon({ location: 'Sala', icon: 'sofa' })
    await provider.setLocationDescription({ location: 'Sala', description: 'Divano e camino.' })

    await provider.renameLocation({ from: 'Sala', to: 'Salotto' })

    expect(await provider.listLocationIcons()).toEqual([{ locationKey: 'salotto', icon: 'sofa' }])
    expect(await provider.listLocationDescriptions()).toEqual([
      { locationKey: 'salotto', description: 'Divano e camino.' },
    ])
  })

  it('keeps the TARGET description when a rename merges two rooms', async () => {
    const { provider } = await setup()
    await provider.setLocationDescription({ location: 'Sala', description: 'La vecchia.' })
    await provider.setLocationDescription({ location: 'Hall', description: 'Quella giusta.' })

    await provider.renameLocation({ from: 'Sala', to: 'Hall' })

    expect(await provider.listLocationDescriptions()).toEqual([
      { locationKey: 'hall', description: 'Quella giusta.' },
    ])
  })

  it('drops the description when the room is removed', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Kitchen' })
    await provider.setLocationDescription({ location: 'Kitchen', description: 'Piano in marmo.' })

    await provider.removeLocation({ name: 'Kitchen', cascade: true })
    await provider.addLocation({ name: 'Kitchen' })

    expect(await provider.listLocationDescriptions()).toEqual([])
  })
})

describe('site zones', () => {
  // A named part of the property that groups LOCATIONS — "Night zone" holds the
  // bedrooms. The rules worth pinning are all about what must NOT be destroyed
  // by an edit somewhere else: this repo has now lost an icon to a rename and a
  // description to a differently-keyed map, and a zone is one more thing hanging
  // off a location label.
  it('creates a zone and keeps the label as typed, keyed folded', async () => {
    const { provider } = await setup()
    await provider.setSiteZone({ name: '  Night zone ', icon: 'bed-double' })

    expect(await provider.listSiteZones()).toEqual([
      { zoneKey: 'night zone', label: 'Night zone', icon: 'bed-double', locationKeys: [] },
    ])
  })

  it('puts a location in a zone, and takes it out with null', async () => {
    const { provider } = await setup()
    await provider.setSiteZone({ name: 'Night zone' })
    await provider.setLocationZone({ location: 'Camera Carol', zone: 'night zone' })

    expect((await provider.listSiteZones())[0]?.locationKeys).toEqual(['camera carol'])

    await provider.setLocationZone({ location: 'Camera Carol', zone: null })
    expect((await provider.listSiteZones())[0]?.locationKeys).toEqual([])
  })

  it('holds a location in ONE zone — a second assignment MOVES it', async () => {
    const { provider } = await setup()
    await provider.setSiteZone({ name: 'Night zone' })
    await provider.setSiteZone({ name: 'Zona giorno' })
    await provider.setLocationZone({ location: 'Studio', zone: 'Night zone' })

    await provider.setLocationZone({ location: 'Studio', zone: 'Zona giorno' })

    const byKey = Object.fromEntries(
      (await provider.listSiteZones()).map((z) => [z.zoneKey, z.locationKeys]),
    )
    expect(byKey['night zone']).toEqual([])
    expect(byKey['zona giorno']).toEqual(['studio'])
  })

  it('deleting a zone does NOT delete its locations', async () => {
    // Deleting a grouping must never delete what was grouped.
    const { provider } = await setup()
    await provider.addLocation({ name: 'Camera Carol' })
    await provider.setSiteZone({ name: 'Night zone' })
    await provider.setLocationZone({ location: 'Camera Carol', zone: 'Night zone' })

    await provider.removeSiteZone({ name: 'Night zone' })

    expect(await provider.listSiteZones()).toEqual([])
    expect(await provider.listLocations()).toContain('Camera Carol')
  })

  it('renaming a zone carries its icon AND its membership', async () => {
    const { provider } = await setup()
    await provider.setSiteZone({ name: 'Night zone', icon: 'bed-double' })
    await provider.setLocationZone({ location: 'Camera Carol', zone: 'Night zone' })

    await provider.renameSiteZone({ from: 'Night zone', to: 'Piano superiore' })

    expect(await provider.listSiteZones()).toEqual([
      {
        zoneKey: 'piano superiore',
        label: 'Piano superiore',
        icon: 'bed-double',
        locationKeys: ['camera carol'],
      },
    ])
  })

  it('a zone rename that MERGES keeps the target icon and unions the rooms', async () => {
    const { provider } = await setup()
    await provider.setSiteZone({ name: 'Sopra', icon: 'car' })
    await provider.setSiteZone({ name: 'Night zone', icon: 'bed-double' })
    await provider.setLocationZone({ location: 'Camera Carol', zone: 'Sopra' })
    await provider.setLocationZone({ location: 'Camera Luca', zone: 'Night zone' })

    await provider.renameSiteZone({ from: 'Sopra', to: 'Night zone' })

    expect(await provider.listSiteZones()).toEqual([
      {
        zoneKey: 'night zone',
        label: 'Night zone',
        icon: 'bed-double',
        locationKeys: ['camera carol', 'camera luca'],
      },
    ])
  })

  it('RENAMING A LOCATION carries its zone membership', async () => {
    // The failure this repo keeps repeating: something hangs off a location key
    // and a rename leaves it behind on a key nothing will ever carry again.
    const { provider } = await setup()
    await provider.addLocation({ name: 'Camera' })
    await provider.setSiteZone({ name: 'Night zone' })
    await provider.setLocationZone({ location: 'Camera', zone: 'Night zone' })

    await provider.renameLocation({ from: 'Camera', to: 'Camera Carol' })

    expect((await provider.listSiteZones())[0]?.locationKeys).toEqual(['camera carol'])
  })

  it('REMOVING A LOCATION drops it from its zone', async () => {
    const { provider } = await setup()
    await provider.addLocation({ name: 'Camera' })
    await provider.setSiteZone({ name: 'Night zone' })
    await provider.setLocationZone({ location: 'Camera', zone: 'Night zone' })

    await provider.removeLocation({ name: 'Camera', cascade: true })

    expect((await provider.listSiteZones())[0]?.locationKeys).toEqual([])
  })

  it('clearing a zone icon KEEPS the zone and its rooms', async () => {
    const { provider } = await setup()
    await provider.setSiteZone({ name: 'Night zone', icon: 'bed-double' })
    await provider.setLocationZone({ location: 'Camera', zone: 'Night zone' })

    await provider.setSiteZone({ name: 'Night zone', icon: null })

    expect(await provider.listSiteZones()).toEqual([
      { zoneKey: 'night zone', label: 'Night zone', icon: null, locationKeys: ['camera'] },
    ])
  })

  it('refuses an empty zone name', async () => {
    const { provider } = await setup()
    await expect(provider.setSiteZone({ name: '   ' })).rejects.toThrow()
  })
})
