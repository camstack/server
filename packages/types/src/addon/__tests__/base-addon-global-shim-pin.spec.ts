import { describe, expect, it } from 'vitest'
import type { ConfigUISchema, ConfigUISchemaWithValues } from '../../interfaces/config-ui.js'
import { collectHydratedFieldEntries } from '../../interfaces/config-ui.js'
import { isSecretMarker } from '../../keychain/secret-marker.js'
import { BaseAddon } from '../base-addon.js'
import { newWorld, worldContext, type KeychainWorld } from './keychain-world.js'

/**
 * Pins `getGlobalSettings` / `updateGlobalSettings(AsOperator)` BEFORE the scoped value API
 * (D986 §7) is built beside them: the two old entry points keep answering exactly this.
 */

interface Config {
  host: string
  bind: string
  fps: number
}

const CAP = 'pin-cap'

const clusterSchema: ConfigUISchema = {
  sections: [
    {
      id: 'cluster',
      title: 'Cluster',
      fields: [
        { type: 'text', key: 'host', label: 'Host', default: 'h0' },
        { type: 'password', key: 'token', label: 'Token' },
      ],
    },
  ],
}
const nodeSchema: ConfigUISchema = {
  sections: [
    {
      id: 'node',
      title: 'Node',
      fields: [{ type: 'text', key: 'bind', label: 'Bind', default: 'eth0' }],
    },
  ],
}
const deviceSchema: ConfigUISchema = {
  sections: [
    {
      id: 'dev',
      title: 'Device',
      fields: [{ type: 'number', key: 'fps', label: 'FPS', default: 5 }],
    },
  ],
}

class PinAddon extends BaseAddon<Config> {
  constructor() {
    super({ host: 'h0', bind: 'eth0', fps: 5 })
  }
  protected override scopedSettingsCapabilities(): readonly string[] {
    return [CAP]
  }
  protected override async clusterSettingsSchema(cap: string) {
    return cap === CAP ? clusterSchema : null
  }
  protected override async nodeSettingsSchema(cap: string) {
    return cap === CAP ? nodeSchema : null
  }
  protected override async deviceDefaultsSchema(cap: string) {
    return cap === CAP ? deviceSchema : null
  }
  protected async onInitialize() {
    return []
  }
}

async function boot(world: KeychainWorld): Promise<PinAddon> {
  const addon = new PinAddon()
  const ctx = worldContext(world, 'pin')
  await addon.initialize({ ...ctx, kernel: { ...ctx.kernel, localNodeId: 'hub' } })
  return addon
}

function values(form: ConfigUISchemaWithValues | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of collectHydratedFieldEntries(form)) out[key] = entry.value ?? null
  return out
}

describe('getGlobalSettings / updateGlobalSettings — the shim pin', () => {
  it('serves every scope of the cap as one form, the schema defaults on an empty store', async () => {
    const addon = await boot(newWorld())
    const form = await addon.getGlobalSettings(undefined, CAP)
    expect(form?.sections.map((s) => s.id)).toEqual(['cluster', 'dev', 'node'])
    expect(values(form)).toEqual({ host: 'h0', token: null, bind: 'eth0', fps: 5 })
  })

  it('writes a node key under <key>@<node> and reads it back per node, never from a bare key', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.updateGlobalSettingsAsOperator(
      { host: 'cam.lan', bind: 'wlan0', fps: 12 },
      'agent-1',
    )
    expect(world.store['host']).toBe('cam.lan')
    expect(world.store['bind@agent-1']).toBe('wlan0')
    expect('bind' in world.store).toBe(false)
    expect(values(await addon.getGlobalSettings(undefined, CAP, 'agent-1'))).toMatchObject({
      host: 'cam.lan',
      bind: 'wlan0',
      fps: 12,
    })
    expect(values(await addon.getGlobalSettings(undefined, CAP, 'agent-2'))).toMatchObject({
      host: 'cam.lan',
      bind: 'eth0',
    })
  })

  it('shows a stored secret as a set view, never its value', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.updateGlobalSettingsAsOperator({ token: 'hunter2' })
    expect(isSecretMarker(world.store['token'])).toBe(true)
    const form = await addon.getGlobalSettings(undefined, CAP)
    expect(JSON.stringify(form)).not.toContain('hunter2')
    expect(values(form)['token']).toMatchObject({ set: true })
  })

  it('applies an overlay on top of the store without writing it', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.updateGlobalSettings({ host: 'stored' })
    const form = await addon.getGlobalSettings({ host: 'preview' }, CAP)
    expect(values(form)['host']).toBe('preview')
    expect(world.store['host']).toBe('stored')
  })

  it('answers an empty form for an unknown cap', async () => {
    const addon = await boot(newWorld())
    expect(await addon.getGlobalSettings(undefined, 'nope')).toEqual({ sections: [] })
  })
})
