/**
 * The integration form route: the addon's per-instance hook when it has one, null when it has
 * none, and the forked path forwards the instance.
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
    const p = build({ getIntegrationFormSchema: hook })
    const out = await p.getIntegrationFormSchema({ addonId: 'a', instance: INSTANCE })
    expect(firstKey(out)).toBe('scoped')
    expect(hook).toHaveBeenCalledWith(INSTANCE, undefined)
  })

  it('answers null when the addon has no hook', async () => {
    const p = build({})
    const out = await p.getIntegrationFormSchema({ addonId: 'a', instance: INSTANCE })
    expect(out).toBeNull()
  })

  it('an addon with integration-instances answers with its instanceFormSchema for that id', async () => {
    const hook = vi.fn(async () => schema('scoped'))
    const instanceFormSchema = vi.fn(async () => schema('instance'))
    const gateway = {
      isInProcess: () => true,
      callForked: vi.fn(),
    } as unknown as AddonCallGateway
    const p = createAddonSettingsProvider({
      getAddon: () => ({ getIntegrationFormSchema: hook }) as unknown as ICamstackAddon,
      gateway,
      instancesFor: () => ({ instanceFormSchema }) as never,
    })
    const out = await p.getIntegrationFormSchema({ addonId: 'a', instance: INSTANCE })
    expect(firstKey(out)).toBe('instance')
    expect(instanceFormSchema).toHaveBeenCalledWith({ id: 'i1', mode: 'account' })
    expect(hook).not.toHaveBeenCalled()
  })

  it('hands the wizard mode and the discovery candidate to instanceFormSchema', async () => {
    const instanceFormSchema = vi.fn(async () => schema('instance'))
    const gateway = { isInProcess: () => true, callForked: vi.fn() } as unknown as AddonCallGateway
    const p = createAddonSettingsProvider({
      getAddon: () => ({}) as unknown as ICamstackAddon,
      gateway,
      instancesFor: () => ({ instanceFormSchema }) as never,
    })
    await p.getIntegrationFormSchema({
      addonId: 'a',
      instance: { integrationId: null, mode: 'broker', candidateStableId: 'mac-aabbcc' },
    })
    expect(instanceFormSchema).toHaveBeenCalledWith({
      id: null,
      mode: 'broker',
      candidateStableId: 'mac-aabbcc',
    })
  })
})
