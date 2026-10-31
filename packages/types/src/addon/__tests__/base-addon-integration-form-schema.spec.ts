/**
 * `BaseAddon.getIntegrationFormSchema` — the form one integration INSTANCE renders. The addon's
 * `integrationSettingsSchema(instance)` hook wins when it returns a schema; `null` (the default)
 * falls back to the global schema, which is what the wizard and the edit page always showed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import type { IntegrationInstanceRef } from '../integration-instance-ref.js'
import { BaseAddon } from '../base-addon.js'

function ctx(): Parameters<BaseAddon['initialize']>[0] {
  return {
    id: 'test-addon',
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    kernel: { localNodeId: 'hub' },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => {},
    },
  } as unknown as Parameters<BaseAddon['initialize']>[0]
}

const GLOBAL: ConfigUISchema = {
  sections: [
    { id: 'g', title: 'Global', fields: [{ type: 'text', key: 'globalKey', label: 'G' }] },
  ],
}
const SCOPED: ConfigUISchema = {
  sections: [
    { id: 's', title: 'Scoped', fields: [{ type: 'text', key: 'scopedKey', label: 'S' }] },
  ],
}

class Plain extends BaseAddon<{ globalKey: string }> {
  constructor() {
    super({ globalKey: '' })
  }
  protected override async onInitialize() {
    return []
  }
  protected override globalSettingsSchema() {
    return GLOBAL
  }
}

class Scoping extends Plain {
  readonly seen: IntegrationInstanceRef[] = []
  protected override async integrationSettingsSchema(instance: IntegrationInstanceRef) {
    this.seen.push(instance)
    return instance.integrationId === 'hub-1' ? SCOPED : null
  }
}

function keys(s: Awaited<ReturnType<BaseAddon['getIntegrationFormSchema']>>): string[] {
  return (s?.sections ?? []).flatMap((sec) =>
    sec.fields.flatMap((f) => ('key' in f ? [f.key] : [])),
  )
}

describe('BaseAddon.getIntegrationFormSchema', () => {
  it('uses the per-instance schema when the hook returns one', async () => {
    const addon = new Scoping()
    await addon.initialize(ctx())
    const instance: IntegrationInstanceRef = { integrationId: 'hub-1', mode: 'account' }
    expect(keys(await addon.getIntegrationFormSchema(instance))).toEqual(['scopedKey'])
    expect(addon.seen).toEqual([instance])
  })

  it('falls back to the global schema when the hook returns null', async () => {
    const addon = new Scoping()
    await addon.initialize(ctx())
    expect(
      keys(await addon.getIntegrationFormSchema({ integrationId: 'other', mode: 'account' })),
    ).toEqual(['globalKey'])
  })

  it('an addon with no hook shows its global schema', async () => {
    const addon = new Plain()
    await addon.initialize(ctx())
    expect(
      keys(await addon.getIntegrationFormSchema({ integrationId: null, mode: 'standalone' })),
    ).toEqual(['globalKey'])
  })
})
