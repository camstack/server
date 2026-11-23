/**
 * An accessory child never outlives its parent: a Reolink siren row survived
 * its camera with a dangling `parentDeviceId`. Removing a device removes what
 * it owns, through the same tombstoned removal, recursively; a row that only
 * LINKS to it (an operator-picked link) is a device of its own and stays.
 */
import { describe, expect, it } from 'vitest'
import {
  asDevice,
  FakeDevice,
  type Harness,
  registerCamera,
  setup,
} from './device-manager-harness.js'
import { orphansOf } from '../migrations/orphan-children.js'
import { readDeviceRow, readDeviceRows } from './settings-store-api.js'

async function registerChild(
  h: Harness,
  stableId: string,
  parentDeviceId: number,
  linkDeviceId?: number,
): Promise<number> {
  const dev = new FakeDevice(stableId)
  dev.parentDeviceId = parentDeviceId
  dev.type = 'switch'
  h.registry.register('provider-reolink', asDevice(dev))
  await h.provider.allocateDeviceId({ addonId: 'provider-reolink', stableId })
  await h.provider.registerDevice({
    addonId: 'provider-reolink',
    stableId,
    id: dev.id,
    type: 'switch',
    name: stableId,
    parentDeviceId,
    config: {},
  })
  if (linkDeviceId !== undefined) {
    await h.provider.setLinkDeviceId({ deviceId: dev.id, linkDeviceId })
  }
  return dev.id
}

async function exists(h: Harness, id: number): Promise<boolean> {
  return Object.keys(await readDeviceRow(h.settingsStore, id)).length > 0
}

describe('removeDevice cascades to what the device owns', () => {
  it('removes children and grandchildren, announces each; leaves unrelated rows', async () => {
    const h = await setup({})
    const parent = await registerCamera(h, 'provider-reolink', 'cam-a')
    const other = await registerCamera(h, 'provider-reolink', 'cam-b')
    const siren = await registerChild(h, 'cam-a-siren', parent)
    const nested = await registerChild(h, 'cam-a-siren-x', siren)
    const otherChild = await registerChild(h, 'cam-b-siren', other)

    await h.provider.removeDevice({ deviceId: parent })

    expect(await exists(h, parent)).toBe(false)
    expect(await exists(h, siren)).toBe(false)
    expect(await exists(h, nested)).toBe(false)
    expect(await exists(h, other)).toBe(true)
    expect(await exists(h, otherChild)).toBe(true)
    // the invariant: no persisted row names a parent that no row answers to
    const rows = (await readDeviceRows(h.settingsStore)).map((r) => ({
      id: Number(r['deviceId']),
      parentDeviceId: typeof r['parentDeviceId'] === 'number' ? r['parentDeviceId'] : null,
    }))
    expect(orphansOf(rows)).toEqual([])
    const unregistered = h.events
      .filter((e) => e.category === 'device.unregistered')
      .map((e) => e.data['deviceId'])
    expect(unregistered).toEqual(expect.arrayContaining([parent, siren, nested]))
  })

  it('removes a linked accessory under a parent, keeps a pure link', async () => {
    const h = await setup({})
    const parent = await registerCamera(h, 'provider-reolink', 'cam-a')
    const scratch = await registerCamera(h, 'provider-reolink', 'cam-s')
    const accessory = await registerChild(h, 'cam-a-spot', scratch, parent)
    const picked = await registerCamera(h, 'provider-reolink', 'lamp')
    await h.provider.setLinkDeviceId({ deviceId: picked, linkDeviceId: parent })

    await h.provider.removeDevice({ deviceId: parent })

    expect(await exists(h, accessory)).toBe(false)
    expect(await exists(h, picked)).toBe(true)
  })

  it('refuses a registration of a removed child (the identity fence)', async () => {
    const h = await setup({})
    const parent = await registerCamera(h, 'provider-reolink', 'cam-a')
    const siren = await registerChild(h, 'cam-a-siren', parent)
    await h.provider.removeDevice({ deviceId: parent })
    await h.provider
      .registerDevice({
        addonId: 'provider-reolink',
        stableId: 'cam-a-siren',
        id: siren,
        type: 'switch',
        name: 'cam-a-siren',
        parentDeviceId: parent,
        config: {},
      })
      .catch(() => undefined)
    expect(await exists(h, siren)).toBe(false)
  })
})
