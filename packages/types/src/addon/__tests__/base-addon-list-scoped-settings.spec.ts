import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { BaseAddon } from '../base-addon.js'
import type { ScopedSettingsScope } from '../scoped-settings.js'
import { newWorld, worldContext } from './keychain-world.js'

/** `listScopedSettings`: what the addon actually serves, one entry per loaded (cap, scope). */

function schemaOf(...ids: string[]): ConfigUISchema {
  return {
    sections: ids.map((id) => ({
      id,
      title: id,
      fields: [{ type: 'text' as const, key: `${id}-key`, label: id }],
    })),
  }
}

class TwoCapAddon extends BaseAddon<{ x: string }> {
  constructor() {
    super({ x: 'x' })
  }
  protected override scopedSettingsCapabilities(): readonly string[] {
    return ['cap-a', 'cap-b']
  }
  protected override async clusterSettingsSchema(cap: string) {
    return cap === 'cap-a' ? schemaOf('shared', 'only-a') : schemaOf('shared')
  }
  protected override async nodeSettingsSchema(cap: string) {
    return cap === 'cap-b' ? schemaOf('per-node') : null
  }
  protected async onInitialize() {
    return []
  }
}

class EmptyAddon extends BaseAddon<{ x: string }> {
  constructor() {
    super({ x: 'x' })
  }
  protected async onInitialize() {
    return []
  }
}

async function boot<T extends BaseAddon<{ x: string }>>(addon: T): Promise<T> {
  const ctx = worldContext(newWorld(), 'list')
  await addon.initialize({ ...ctx, kernel: { ...ctx.kernel, localNodeId: 'hub' } })
  return addon
}

describe('BaseAddon.listScopedSettings', () => {
  it('lists one entry per loaded (cap, scope) with its section ids, caps in declaration order', async () => {
    const addon = await boot(new TwoCapAddon())
    const scopes: ScopedSettingsScope[] = ['cluster', 'node']
    expect(await addon.listScopedSettings()).toEqual([
      { cap: 'cap-a', scope: scopes[0], sectionIds: ['shared', 'only-a'] },
      { cap: 'cap-b', scope: scopes[0], sectionIds: ['shared'] },
      { cap: 'cap-b', scope: scopes[1], sectionIds: ['per-node'] },
    ])
  })

  it('answers [] for an addon that declares nothing', async () => {
    const addon = await boot(new EmptyAddon())
    expect(await addon.listScopedSettings()).toEqual([])
  })
})
