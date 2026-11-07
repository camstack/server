/**
 * The scoped settings methods (D986 §7): an in-process addon is called directly with
 * `(scope, cap, …)`; a forked one is routed through the gateway's `settings` target with the
 * same arguments.
 */
import type { ICamstackAddon } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { AddonCallGateway } from '../addon-call-gateway.js'
import { createAddonSettingsProvider } from '../addon-settings-provider.js'

const form = {
  sections: [
    { id: 's', title: 's', fields: [{ type: 'text' as const, key: 'k', label: 'k', value: 'v' }] },
  ],
}

function build(addon: Partial<ICamstackAddon>, forked = vi.fn()) {
  const gateway = {
    isInProcess: () => forked.mock.calls.length === 0 && !forkedMode.on,
    callForked: forked,
  } as unknown as AddonCallGateway
  return createAddonSettingsProvider({ getAddon: () => addon as ICamstackAddon, gateway })
}
const forkedMode = { on: false }

describe('scoped settings provider methods', () => {
  it('calls an in-process addon with scope, cap and node', async () => {
    forkedMode.on = false
    const get = vi.fn(async () => form)
    const update = vi.fn(async () => undefined)
    const read = vi.fn(async () => ({ k: 'v' }))
    const p = build({
      getScopedSettings: get,
      updateScopedSettings: update,
      readScopedValues: read,
    })
    const input = { addonId: 'a', cap: 'c', scope: 'node' as const, nodeId: 'n1' }
    expect((await p.getScopedSettings(input))?.sections[0]?.id).toBe('s')
    await p.updateScopedSettings({ ...input, patch: { k: 'x' } })
    expect(await p.readScopedValues(input)).toEqual({ k: 'v' })
    expect(get).toHaveBeenCalledWith('node', 'c', 'n1')
    expect(update).toHaveBeenCalledWith('node', 'c', { k: 'x' }, 'n1')
    expect(read).toHaveBeenCalledWith('node', 'c', 'n1')
  })

  it('answers null for an addon without the methods', async () => {
    forkedMode.on = false
    const p = build({})
    const input = { addonId: 'a', cap: 'c', scope: 'cluster' as const }
    expect(await p.getScopedSettings(input)).toBeNull()
    expect(await p.readScopedValues(input)).toBeNull()
    await expect(p.updateScopedSettings({ ...input, patch: {} })).rejects.toThrow(
      /does not implement updateScopedSettings/,
    )
  })

  it('routes a forked addon through the gateway settings target', async () => {
    forkedMode.on = true
    const callForked = vi.fn(async (_id: string, call: { method: string }) =>
      call.method === 'readScopedValues' ? { k: 'v' } : form,
    )
    const p = build({}, callForked)
    const input = { addonId: 'a', cap: 'c', scope: 'device-defaults' as const }
    await p.getScopedSettings(input)
    await p.updateScopedSettings({ ...input, patch: { k: 1 } })
    expect(await p.readScopedValues(input)).toEqual({ k: 'v' })
    expect(callForked.mock.calls.map(([, call]) => call)).toEqual([
      {
        target: 'settings',
        method: 'getScopedSettings',
        args: { scope: 'device-defaults', cap: 'c' },
      },
      {
        target: 'settings',
        method: 'updateScopedSettings',
        args: { scope: 'device-defaults', cap: 'c', patch: { k: 1 } },
      },
      {
        target: 'settings',
        method: 'readScopedValues',
        args: { scope: 'device-defaults', cap: 'c' },
      },
    ])
    forkedMode.on = false
  })
})
