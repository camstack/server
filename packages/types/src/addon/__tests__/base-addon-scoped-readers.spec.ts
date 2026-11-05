import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it, vi } from 'vitest'
import type { AppRouter } from '../../generated/addon-api.js'
import type { AddonContext } from '../../interfaces/addon.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { isSecretMarker } from '../../keychain/secret-marker.js'
import { createSecretsAccess, type KeychainTransport } from '../../keychain/secrets-access.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from './fake-addon-context.js'

/**
 * D986 M4: the three readers of the addon-level schema (`perNodeKeys`, the secret tree, the
 * restart check) see the SCOPED schemas, so an addon can drop `globalSettingsSchema` without
 * losing a node key, a secret or a restart.
 */

interface Config {
  interfaceName: string
  clusterToken: string
  mode: string
}

const CAP = 'device-export'

const nodeSchema: ConfigUISchema = {
  sections: [
    {
      id: 'node',
      title: 'Node',
      fields: [{ type: 'text', key: 'interfaceName', label: 'Interface' }],
    },
  ],
}

const clusterSchema: ConfigUISchema = {
  sections: [
    {
      id: 'cluster',
      title: 'Cluster',
      fields: [
        { type: 'password', key: 'clusterToken', label: 'Token' },
        { type: 'text', key: 'mode', label: 'Mode', requiresRestart: true },
      ],
    },
  ],
}

/** HAP-shaped: the old hook is null, the scoped hooks carry everything. */
class ScopedOnlyAddon extends BaseAddon<Config> {
  constructor() {
    super({ interfaceName: '', clusterToken: '', mode: 'a' })
  }
  protected override scopedSettingsCapabilities(): readonly string[] {
    return [CAP]
  }
  protected override async nodeSettingsSchema(cap: string): Promise<ConfigUISchema | null> {
    return cap === CAP ? nodeSchema : null
  }
  protected override async clusterSettingsSchema(cap: string): Promise<ConfigUISchema | null> {
    return cap === CAP ? clusterSchema : null
  }
  protected async onInitialize() {
    return []
  }
}

interface Handle {
  readonly ctx: AddonContext
  readonly store: () => Record<string, unknown>
  readonly calls: readonly string[]
}

function makeCtx(localNodeId: string, withKeychain = false): Handle {
  let store: Record<string, unknown> = {}
  const calls: string[] = []
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls.push(op.path)
        observer.next({ result: { data: undefined } })
        observer.complete()
      })
  const base = fakeAddonContext({ id: 'scoped-readers' })
  const vault = new Map<string, string>()
  const transport: KeychainTransport = {
    async put({ ref, value }) {
      vault.set(ref, value)
      return { ref, version: 1 }
    },
    async resolve({ refs }) {
      return Object.fromEntries(
        refs.map((ref) => {
          const value = vault.get(ref)
          return [
            ref,
            value === undefined
              ? { kind: 'missing' as const }
              : { kind: 'value' as const, value, version: 1 },
          ]
        }),
      )
    },
    async delete({ refs }) {
      for (const ref of refs) vault.delete(ref)
      return { deleted: refs.length }
    },
    async getState() {
      return { state: 'ready' as const }
    },
  }
  const settings: NonNullable<AddonContext['settings']> = {
    ...(base.settings ?? fakeAddonContext().settings!),
    readAddonStore: async () => structuredClone(store),
    readAddonStoreResult: async () => ({
      kind: 'value',
      value: structuredClone(store),
    }),
    writeAddonStore: async (patch) => {
      store = { ...store, ...structuredClone(patch) }
    },
  }
  const ctx: AddonContext = {
    ...base,
    kernel: { ...base.kernel, localNodeId },
    settings,
    api: createTRPCClient<AppRouter>({ links: [link] }),
    ...(withKeychain
      ? {
          secrets: createSecretsAccess({
            owner: 'scoped-readers',
            transport,
            eventBus: base.eventBus,
          }),
        }
      : {}),
  }
  return { ctx, store: () => store, calls }
}

describe('BaseAddon readers of the scoped schemas', () => {
  it('a field of the node hook is stored under its node, with no legacy perNode flag', async () => {
    const h = makeCtx('node-b')
    const addon = new ScopedOnlyAddon()
    await addon.initialize(h.ctx)
    await addon.updateGlobalSettings({ interfaceName: 'eth9' })
    expect(h.store()['interfaceName@node-b']).toBe('eth9')
    expect(h.store()['interfaceName']).toBeUndefined()
  })

  it('a bare node key written for a sibling node is stored under that node', async () => {
    const h = makeCtx('node-b')
    const addon = new ScopedOnlyAddon()
    await addon.initialize(h.ctx)
    await addon.updateGlobalSettings({ interfaceName: 'eth1' }, 'node-c')
    expect(h.store()['interfaceName@node-c']).toBe('eth1')
    expect(h.store()['interfaceName']).toBeUndefined()
  })

  it('a node field resolves from this node at boot, not from the bare key', async () => {
    const h = makeCtx('node-b')
    await h.ctx.settings?.writeAddonStore({
      interfaceName: 'bare',
      'interfaceName@node-b': 'eth9',
    })
    const addon = new ScopedOnlyAddon()
    await addon.initialize(h.ctx)
    expect(addon.config.interfaceName).toBe('eth9')
  })

  it('a password on a scoped hook goes to the keychain', async () => {
    const h = makeCtx('node-b', true)
    const addon = new ScopedOnlyAddon()
    await addon.initialize(h.ctx)
    await addon.updateGlobalSettings({ clusterToken: 'super-secret-123' })
    expect(isSecretMarker(h.store()['clusterToken'])).toBe(true)
    expect(JSON.stringify(h.store())).not.toContain('super-secret-123')
  })

  it('a requiresRestart field of a scoped hook restarts the addon', async () => {
    vi.useFakeTimers()
    try {
      const h = makeCtx('node-b')
      const addon = new ScopedOnlyAddon()
      await addon.initialize(h.ctx)
      await addon.updateGlobalSettings({ mode: 'b' })
      await vi.runAllTimersAsync()
      expect(h.calls).toEqual(['addons.restartAddon'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('getGlobalSettings serves the scoped sections when no global schema is declared', async () => {
    const h = makeCtx('node-b')
    await h.ctx.settings?.writeAddonStore({ 'interfaceName@node-b': 'eth9' })
    const addon = new ScopedOnlyAddon()
    await addon.initialize(h.ctx)
    const form = await addon.getGlobalSettings()
    const field = form?.sections
      .flatMap((section) => section.fields)
      .find((f) => 'key' in f && f.key === 'interfaceName')
    expect(field && 'value' in field ? field.value : undefined).toBe('eth9')
  })

  it('a section declared under two capabilities is served once', async () => {
    class TwoCaps extends ScopedOnlyAddon {
      protected override scopedSettingsCapabilities(): readonly string[] {
        return [CAP, 'other-cap']
      }
      protected override async nodeSettingsSchema(): Promise<ConfigUISchema | null> {
        return nodeSchema
      }
    }
    const addon = new TwoCaps()
    await addon.initialize(makeCtx('node-b').ctx)
    const form = await addon.getGlobalSettings()
    expect(form?.sections.filter((section) => section.id === 'node')).toHaveLength(1)
  })

  it('getDeclaredSettingsKeys lists the scoped fields', async () => {
    const addon = new ScopedOnlyAddon()
    await addon.initialize(makeCtx('node-b').ctx)
    const { keys } = await addon.getDeclaredSettingsKeys()
    expect(keys).toEqual(expect.arrayContaining(['interfaceName', 'clusterToken', 'mode']))
  })
})
