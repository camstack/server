/**
 * D783 — a device's DECLARED secret config paths reach every `DeviceInfo` the
 * device-manager answers with, so the non-admin redaction can withhold them
 * at any depth (nested `connection.password`, a `localKey` no keyword names).
 *
 * Forked-runner devices are answered from the persisted row, so the paths ride
 * `registerDevice` (re-published on every register, like `features`). A live
 * hub-registry device answers from its own schema.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { asDevice, FakeDevice, setup } from './device-manager-harness.js'

describe('secretConfigPaths on DeviceInfo', () => {
  it('a forked device reports its paths at registerDevice and every read carries them', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: 'provider-unifi', stableId: 'ctl' })
    await h.provider.registerDevice({
      addonId: 'provider-unifi',
      stableId: 'ctl',
      id,
      type: 'hub',
      name: 'Controller',
      parentDeviceId: null,
      config: {},
      secretConfigPaths: ['connection.password', 'connection.apiKey'],
    })
    await h.provider.persistConfig({
      deviceId: id,
      data: { connection: { host: '10.0.0.2', password: 'p', apiKey: 'k' } },
    })

    const one = await h.provider.getDevice({ deviceId: id })
    expect(one?.secretConfigPaths).toEqual(['connection.password', 'connection.apiKey'])
    const all = await h.provider.listAll({})
    expect(all.find((d) => d.id === id)?.secretConfigPaths).toEqual([
      'connection.password',
      'connection.apiKey',
    ])
  })

  it('a later register replaces the paths; a register without them clears nothing it never had', async () => {
    const h = await setup()
    const { id } = await h.provider.allocateDeviceId({ addonId: 'provider-tuya', stableId: 'plug' })
    const base = {
      addonId: 'provider-tuya',
      stableId: 'plug',
      id,
      type: 'switch',
      name: 'Plug',
      parentDeviceId: null,
      config: {},
    }
    await h.provider.registerDevice({ ...base, secretConfigPaths: ['localKey'] })
    await h.provider.registerDevice({ ...base, secretConfigPaths: ['localKey', 'extra'] })
    expect((await h.provider.getDevice({ deviceId: id }))?.secretConfigPaths).toEqual([
      'localKey',
      'extra',
    ])
  })

  it('a live hub-registry device answers from its own schema declaration', async () => {
    const h = await setup()
    const dev = new FakeDevice('live-1')
    const schema = z.object({
      host: z.string(),
      localKey: z.string().meta({ secret: true }),
    })
    Object.assign(dev.config, { schema })
    h.registry.register('provider-tuya', asDevice(dev))
    await h.provider.allocateDeviceId({ addonId: 'provider-tuya', stableId: 'live-1' })
    await h.provider.registerDevice({
      addonId: 'provider-tuya',
      stableId: 'live-1',
      id: dev.id,
      type: 'switch',
      name: 'live',
      parentDeviceId: null,
      config: {},
    })
    expect((await h.provider.getDevice({ deviceId: dev.id }))?.secretConfigPaths).toEqual([
      'localKey',
    ])
  })
})
