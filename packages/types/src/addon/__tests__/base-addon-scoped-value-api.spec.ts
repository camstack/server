import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { collectHydratedFieldEntries } from '../../interfaces/config-ui.js'
import { isSecretMarker } from '../../keychain/secret-marker.js'
import { BaseAddon } from '../base-addon.js'
import type { ScopedSettings, ScopedSettingsScope } from '../scoped-settings.js'
import { newWorld, worldContext, type KeychainWorld } from './keychain-world.js'

/**
 * D986 §7: the typed scoped value API — `clusterSettings`, `deviceDefaults`, `nodeSettings`,
 * `nodeState` — over the same rows `scopedFormSchema` and `this.config` already use.
 */

const CAP = 'value-cap'

const ClusterZ = z.object({ host: z.string().default('h0'), token: z.string().default('') })
const NodeZ = z.object({ bind: z.string().default('eth0') })
const DeviceZ = z.object({ fps: z.number().default(5) })
const StateZ = z.object({ n: z.number() })
type ClusterValue = z.infer<typeof ClusterZ>

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

interface ChangeRecord {
  readonly scope: ScopedSettingsScope
  readonly cap: string
  readonly keys: readonly string[]
}

class ValueAddon extends BaseAddon<{ host: string }> {
  readonly changes: ChangeRecord[] = []
  overlay: Record<string, unknown> | null = null
  constructor() {
    super({ host: 'h0' })
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
  protected override async scopedSettingsOverlay(scope: ScopedSettingsScope) {
    return scope === 'cluster' ? this.overlay : null
  }
  protected override async onScopedSettingsChanged(
    scope: ScopedSettingsScope,
    cap: string,
    keys: readonly string[],
  ): Promise<void> {
    this.changes.push({ scope, cap, keys })
  }
  protected async onInitialize() {
    return []
  }
  cluster(): ScopedSettings<ClusterValue> {
    return this.clusterSettings(CAP, ClusterZ)
  }
  node(nodeId?: string) {
    return this.nodeSettings(CAP, NodeZ, nodeId)
  }
  devices() {
    return this.deviceDefaults(CAP, DeviceZ)
  }
  lastSeen(nodeId?: string) {
    return this.nodeState('last', StateZ, { n: 0 }, nodeId)
  }
}

async function boot(world: KeychainWorld): Promise<ValueAddon> {
  const addon = new ValueAddon()
  const ctx = worldContext(world, 'value')
  await addon.initialize({ ...ctx, kernel: { ...ctx.kernel, localNodeId: 'hub' } })
  return addon
}

describe('cluster scope', () => {
  it('reads the schema default on an absent row, then the patched value, then the default after unset', async () => {
    const addon = await boot(newWorld())
    expect(await addon.cluster().get()).toEqual({ host: 'h0', token: '' })
    await addon.cluster().patch({ host: 'cam.lan' })
    expect(await addon.cluster().get()).toEqual({ host: 'cam.lan', token: '' })
    await addon.cluster().unset(['host'])
    expect((await addon.cluster().get()).host).toBe('h0')
  })

  it('stores a bare key and refuses a key the scope did not declare', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.cluster().patch({ host: 'cam.lan' })
    expect(world.store['host']).toBe('cam.lan')
    await expect(addon.cluster().patch({ bind: 'x' } as Partial<ClusterValue>)).rejects.toThrow(
      /not declared for this scope/,
    )
    expect('bind' in world.store).toBe(false)
  })

  it('ignores a stored key outside the declared ones', async () => {
    const world = newWorld()
    world.store['legacy'] = 'old'
    const addon = await boot(world)
    expect(await addon.cluster().get()).toEqual({ host: 'h0', token: '' })
  })
})

describe('node scope', () => {
  it('writes <key>@<node> for the given node and reads each node on its own', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.node('agent-1').patch({ bind: 'wlan0' })
    expect(world.store['bind@agent-1']).toBe('wlan0')
    expect('bind' in world.store).toBe(false)
    expect(await addon.node('agent-1').get()).toEqual({ bind: 'wlan0' })
  })

  it('defaults to the local node, and an absent row is the schema default, never a bare value', async () => {
    const world = newWorld()
    world.store['bind'] = 'stray-bare'
    const addon = await boot(world)
    expect(await addon.node().get()).toEqual({ bind: 'eth0' })
    await addon.node().patch({ bind: 'eth1' })
    expect(world.store['bind@hub']).toBe('eth1')
    expect(await addon.node('agent-2').get()).toEqual({ bind: 'eth0' })
  })

  it('unset removes that node row only', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.node('a').patch({ bind: 'x' })
    await addon.node('b').patch({ bind: 'y' })
    await addon.node('a').unset(['bind'])
    expect(await addon.node('a').get()).toEqual({ bind: 'eth0' })
    expect(await addon.node('b').get()).toEqual({ bind: 'y' })
  })
})

describe('device-defaults scope', () => {
  it('round-trips the fleet default on a bare key', async () => {
    const world = newWorld()
    const addon = await boot(world)
    expect(await addon.devices().get()).toEqual({ fps: 5 })
    await addon.devices().patch({ fps: 12 })
    expect(world.store['fps']).toBe(12)
    expect(await addon.devices().get()).toEqual({ fps: 12 })
    await addon.devices().unset(['fps'])
    expect(await addon.devices().get()).toEqual({ fps: 5 })
  })
})

describe('secrets', () => {
  it('an addon write stores a marker, get() resolves the value, the form shows a set view', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.cluster().patch({ token: 'hunter2' })
    expect(isSecretMarker(world.store['token'])).toBe(true)
    expect(JSON.stringify(world.store)).not.toContain('hunter2')
    expect((await addon.cluster().get()).token).toBe('hunter2')
    const form = await addon.getScopedSettings('cluster', CAP)
    expect(JSON.stringify(form)).not.toContain('hunter2')
    const token = collectHydratedFieldEntries(form).get('token')
    expect(token?.value).toMatchObject({ set: true })
  })

  it('unset of a secret releases its keychain ref and removes the row; a plain unset is unchanged', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.cluster().patch({ token: 'hunter2', host: 'cam.lan' })
    expect(world.kc.size).toBe(1)
    await addon.cluster().unset(['token'])
    expect(world.kc.size).toBe(0)
    expect(world.store['token']).toBeUndefined()
    expect((await addon.cluster().get()).token).toBe('')
    expect(world.store['host']).toBe('cam.lan')
    await addon.cluster().unset(['host'])
    expect(world.store['host']).toBeUndefined()
  })

  it('readScopedValues never carries the secret value', async () => {
    const addon = await boot(newWorld())
    await addon.cluster().patch({ token: 'hunter2', host: 'cam.lan' })
    const values = await addon.readScopedValues('cluster', CAP)
    expect(JSON.stringify(values)).not.toContain('hunter2')
    expect(values).toMatchObject({ host: 'cam.lan', token: { set: true } })
  })

  it('operator write re-entering an inline value stores a marker; an addon write-back does not', async () => {
    const asAddon = newWorld()
    asAddon.store['token'] = 'inline-1'
    const a = await boot(asAddon)
    await a.cluster().patch({ token: 'inline-1' })
    expect(asAddon.store['token']).toBe('inline-1')

    const asOperator = newWorld()
    asOperator.store['token'] = 'inline-1'
    const b = await boot(asOperator)
    await b.updateScopedSettings('cluster', CAP, { token: 'inline-1' })
    expect(isSecretMarker(asOperator.store['token'])).toBe(true)
  })
})

describe('the cap-facing methods', () => {
  it('answers null for a scope the cap did not declare and refuses an undeclared write', async () => {
    const addon = await boot(newWorld())
    expect(await addon.getScopedSettings('cluster', 'other-cap')).toBeNull()
    expect(await addon.readScopedValues('node', 'other-cap')).toBeNull()
    await expect(addon.updateScopedSettings('cluster', CAP, { bind: 'x' })).rejects.toThrow(
      /not declared for this scope/,
    )
  })

  it('applies the overlay to the form only, not to what is stored or read', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.cluster().patch({ host: 'stored' })
    addon.overlay = { host: 'preview' }
    const form = await addon.getScopedSettings('cluster', CAP)
    expect(collectHydratedFieldEntries(form).get('host')?.value).toBe('preview')
    expect(world.store['host']).toBe('stored')
    expect((await addon.cluster().get()).host).toBe('stored')
  })

  it('updateScopedSettings on the node scope writes the target node row', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.updateScopedSettings('node', CAP, { bind: 'wlan9' }, 'agent-7')
    expect(world.store['bind@agent-7']).toBe('wlan9')
    expect(await addon.readScopedValues('node', CAP, 'agent-7')).toEqual({ bind: 'wlan9' })
  })
})

describe('onScopedSettingsChanged', () => {
  it('fires with scope, cap and keys on a change, and not on the write-back of a stored secret', async () => {
    const world = newWorld()
    world.store['token'] = 'inline-1'
    const addon = await boot(world)
    await addon.cluster().patch({ token: 'inline-1' })
    expect(addon.changes).toEqual([])
    await addon.cluster().patch({ host: 'cam.lan' })
    expect(addon.changes).toEqual([{ scope: 'cluster', cap: CAP, keys: ['host'] }])
    await addon.node('a').unset(['bind'])
    expect(addon.changes.at(-1)).toEqual({ scope: 'node', cap: CAP, keys: ['bind'] })
  })
})

describe('nodeState', () => {
  it('persists under <key>@<node>, per node, the fallback when absent', async () => {
    const world = newWorld()
    const addon = await boot(world)
    expect(await addon.lastSeen().get()).toEqual({ n: 0 })
    await addon.lastSeen('agent-1').set({ n: 3 })
    expect(world.store['last@agent-1']).toEqual({ n: 3 })
    expect('last' in world.store).toBe(false)
    expect(await addon.lastSeen('agent-1').get()).toEqual({ n: 3 })
    expect(await addon.lastSeen('agent-2').get()).toEqual({ n: 0 })
    await addon.lastSeen().set({ n: 1 })
    expect(world.store['last@hub']).toEqual({ n: 1 })
  })
})

// ── One key, two capabilities ───────────────────────────────────────────

const CAP_A = 'cap-a'
const CAP_B = 'cap-b'
const XSchema: ConfigUISchema = {
  sections: [
    { id: 'x', title: 'X', fields: [{ type: 'text', key: 'x', label: 'X', default: 'dx' }] },
  ],
}
const XZ = z.object({ x: z.string().default('dx') })

class TwoCapAddon extends BaseAddon<{ host: string }> {
  constructor() {
    super({ host: '' })
  }
  protected override scopedSettingsCapabilities(): readonly string[] {
    return [CAP_A, CAP_B]
  }
  protected override async clusterSettingsSchema(cap: string) {
    return cap === CAP_A ? XSchema : null
  }
  protected override async nodeSettingsSchema(cap: string) {
    return cap === CAP_B ? XSchema : null
  }
  protected async onInitialize() {
    return []
  }
  a() {
    return this.clusterSettings(CAP_A, XZ)
  }
  b(nodeId?: string) {
    return this.nodeSettings(CAP_B, XZ, nodeId)
  }
}

describe('a key that is cluster in one cap and per node in another', () => {
  it('each cap writes and reads its own row', async () => {
    const world = newWorld()
    const addon = new TwoCapAddon()
    const ctx = worldContext(world, 'two')
    await addon.initialize({ ...ctx, kernel: { ...ctx.kernel, localNodeId: 'hub' } })
    await addon.a().patch({ x: 'cluster-x' })
    await addon.b('agent-1').patch({ x: 'node-x' })
    expect(world.store['x']).toBe('cluster-x')
    expect(world.store['x@agent-1']).toBe('node-x')
    expect('x@hub' in world.store).toBe(false)
    expect(await addon.a().get()).toEqual({ x: 'cluster-x' })
    expect(await addon.b('agent-1').get()).toEqual({ x: 'node-x' })
    await addon.a().unset(['x'])
    expect(world.store['x']).toBeUndefined()
    expect(world.store['x@agent-1']).toBe('node-x')
  })
})
