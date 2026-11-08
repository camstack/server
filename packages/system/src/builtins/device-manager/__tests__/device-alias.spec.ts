/**
 * The template alias (D1021): generated once at first registration, unique
 * cluster-wide, editable through `setAlias` with a typed refusal, NOT changed by
 * a rename, and back-filled once onto rows that predate it.
 */
import { describe, expect, it } from 'vitest'
import { DEVICE_ALIAS_BACKFILL_MARKER_KEY, planAliasBackfill } from '../device-alias-actions.js'
import { registerCamera, setup } from './device-manager-harness.js'
import { readDeviceRow } from './settings-store-api.js'

async function register(
  h: Awaited<ReturnType<typeof setup>>,
  stableId: string,
  name: string,
): Promise<number> {
  const id = await registerCamera(h, 'provider-x', stableId)
  await h.provider.setName({ deviceId: id, name })
  return id
}

describe('alias generation at registration', () => {
  it('slugs the name, dedupes _2 across devices, and a rename does not move it', async () => {
    const h = await setup()
    const a = await register(h, 'c1', 'Stufa Veranda')
    // registered under the placeholder name first, so the alias comes from what was known then
    const rowA = await readDeviceRow(h.settingsStore, a)
    expect(typeof rowA['alias']).toBe('string')

    const b = await registerCamera(h, 'provider-x', 'Stufa Veranda')
    const c = await registerCamera(h, 'provider-y', 'Stufa Veranda')
    const aliases = [b, c].map(async (id) => (await readDeviceRow(h.settingsStore, id))['alias'])
    expect(await Promise.all(aliases)).toEqual(['stufa_veranda', 'stufa_veranda_2'])

    await h.provider.setName({ deviceId: b, name: 'Completely Different' })
    expect((await readDeviceRow(h.settingsStore, b))['alias']).toBe('stufa_veranda')
    const info = await h.provider.getDevice({ deviceId: b })
    expect(info?.alias).toBe('stufa_veranda')
  })
})

describe('setAlias', () => {
  it('refuses by typed reason and never writes a refused alias', async () => {
    const h = await setup()
    const a = await registerCamera(h, 'provider-x', 'Garage')
    const b = await registerCamera(h, 'provider-x', 'Cantina')
    expect(await h.provider.setAlias({ deviceId: b, alias: 'garage' })).toEqual({
      ok: false,
      reason: 'taken',
      takenBy: a,
    })
    expect(await h.provider.setAlias({ deviceId: b, alias: 'Bad Name' })).toEqual({
      ok: false,
      reason: 'grammar',
    })
    expect(await h.provider.setAlias({ deviceId: b, alias: 'range' })).toEqual({
      ok: false,
      reason: 'reserved',
    })
    expect((await readDeviceRow(h.settingsStore, b))['alias']).toBe('cantina')
  })

  it('accepts a free alias, and the device own alias again', async () => {
    const h = await setup()
    const a = await registerCamera(h, 'provider-x', 'Garage')
    expect(await h.provider.setAlias({ deviceId: a, alias: 'box_auto' })).toEqual({
      ok: true,
      alias: 'box_auto',
    })
    expect(await h.provider.setAlias({ deviceId: a, alias: 'box_auto' })).toEqual({
      ok: true,
      alias: 'box_auto',
    })
    // the old alias is free again
    const b = await registerCamera(h, 'provider-x', 'Garage')
    expect((await readDeviceRow(h.settingsStore, b))['alias']).toBe('garage')
  })
})

describe('planAliasBackfill', () => {
  it('gives each alias-less row a unique slug in id order and leaves an existing alias alone', () => {
    const plan = planAliasBackfill([
      { id: 1, name: 'Luce', alias: 'luce_operator' },
      { id: 2, name: 'Luce' },
      { id: 3, name: 'Luce' },
      { id: 4, name: 'Prise' },
    ])
    expect(plan).toEqual([
      { id: 2, alias: 'luce' },
      { id: 3, alias: 'luce_2' },
      { id: 4, alias: 'prise' },
    ])
  })
})

describe('the boot backfill', () => {
  it('stamps rows that predate aliases once, keeps an operator alias, and stays quiet after', async () => {
    const first = await setup()
    const keep = await registerCamera(first, 'provider-x', 'Keep')
    const old1 = await registerCamera(first, 'provider-x', 'Old One')
    const old2 = await registerCamera(first, 'provider-y', 'Old One')
    await first.provider.setAlias({ deviceId: keep, alias: 'operator_chose_this' })
    // age the two rows: they predate the column
    await first.settingsStore.backend.updateWhere({
      collection: 'device-manager:devices',
      filter: { whereIn: { deviceId: [old1, old2] } },
      data: { alias: null },
    })
    // a hub that predates the feature has never run the backfill (the empty first boot above stamped the marker)
    await first.settings.writeAddonStore({ [DEVICE_ALIAS_BACKFILL_MARKER_KEY]: 0 })

    const second = await setup({
      persisted: {
        settings: first.settings,
        settingsStore: first.settingsStore,
        addonStoreUnreadable: first.addonStoreUnreadable,
      },
    })
    expect((await readDeviceRow(second.settingsStore, keep))['alias']).toBe('operator_chose_this')
    expect((await readDeviceRow(second.settingsStore, old1))['alias']).toBe('old_one')
    expect((await readDeviceRow(second.settingsStore, old2))['alias']).toBe('old_one_2')
    expect((await second.settings.readAddonStore())[DEVICE_ALIAS_BACKFILL_MARKER_KEY]).toBe(1)
  })
})

describe('a removed device keeps its alias reserved', () => {
  it('a new device of the same name slugs to _2, and an explicit setAlias reclaims it', async () => {
    const h = await setup()
    const a = await registerCamera(h, 'provider-x', 'Garage')
    expect((await readDeviceRow(h.settingsStore, a))['alias']).toBe('garage')
    await h.provider.removeDevice({ deviceId: a })

    const b = await registerCamera(h, 'provider-y', 'Garage')
    expect((await readDeviceRow(h.settingsStore, b))['alias']).toBe('garage_2')

    // the admin may take the reserved name on purpose, then it is theirs
    expect(await h.provider.setAlias({ deviceId: b, alias: 'garage' })).toEqual({
      ok: true,
      alias: 'garage',
    })
    const c = await registerCamera(h, 'provider-z', 'Garage')
    expect((await readDeviceRow(h.settingsStore, c))['alias']).toBe('garage_2')
  })
})

describe('alias reaches readers of a device with no live instance (D1021)', () => {
  it('getDevice and listAll answer the alias of a forked-worker device', async () => {
    const h = await setup()
    const id = await register(h, 'forked-1', 'Stufa Veranda')
    expect((await h.provider.setAlias({ deviceId: id, alias: 'stufa_x' })).ok).toBe(true)
    // the owning worker lives in another process: the hub registry has no instance
    h.registry.remove(id)

    const one = await h.provider.getDevice({ deviceId: id })
    expect(one?.alias).toBe('stufa_x')
    const all = await h.provider.listAll({})
    expect(all.find((d) => d.id === id)?.alias).toBe('stufa_x')
  })
})
