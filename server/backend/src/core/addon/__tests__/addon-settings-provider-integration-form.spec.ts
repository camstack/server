/**
 * The integration form route: the addon's per-instance hook when it has one, its global
 * settings when it does not, and the forked path forwards the instance.
 */
import type { ICamstackAddon, IntegrationInstanceRef } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { AddonCallGateway } from '../addon-call-gateway.js'
import { createAddonSettingsProvider } from '../addon-settings-provider.js'

const INSTANCE: IntegrationInstanceRef = { integrationId: 'i1', mode: 'account' }

const schema = (key: string) => ({
  sections: [
    { id: key, title: key, fields: [{ type: 'text' as const, key, label: key, value: '' }] },
  ],
})
const firstKey = (r: { sections: readonly { fields: readonly unknown[] }[] } | null): unknown => {
  const f = r?.sections[0]?.fields[0]
  return f !== null && typeof f === 'object' && 'key' in f ? f.key : undefined
}

function build(addon: Partial<ICamstackAddon>, forked = vi.fn()) {
  const gateway = {
    isInProcess: () => forked.mock.calls.length === 0,
    callForked: forked,
  } as unknown as AddonCallGateway
  return createAddonSettingsProvider({ getAddon: () => addon as ICamstackAddon, gateway })
}

describe('getIntegrationFormSchema route', () => {
  it('uses the addon hook when present', async () => {
    const hook = vi.fn(async () => schema('scoped'))
    const global = vi.fn(async () => schema('global'))
    const p = build({ getIntegrationFormSchema: hook, getGlobalSettings: global })
    const out = await p.getIntegrationFormSchema({ addonId: 'a', instance: INSTANCE })
    expect(firstKey(out)).toBe('scoped')
    expect(hook).toHaveBeenCalledWith(INSTANCE, undefined)
    expect(global).not.toHaveBeenCalled()
  })

  it('falls back to getGlobalSettings when the addon has no hook', async () => {
    const global = vi.fn(async () => schema('global'))
    const p = build({ getGlobalSettings: global })
    const out = await p.getIntegrationFormSchema({ addonId: 'a', instance: INSTANCE })
    expect(firstKey(out)).toBe('global')
  })
})
