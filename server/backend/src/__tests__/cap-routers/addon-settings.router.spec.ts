/**
 * Spec for the codegen'd `addon-settings` capability router.
 *
 * Exercises:
 *  - All 4 methods (get/update × global/device) — `getAddonSettings` /
 *    `updateAddonSettings` were collapsed into the global pair when the
 *    three-level settings API was simplified.
 *  - Auth enforcement (getters=protected, updaters=admin)
 *  - Missing provider → PRECONDITION_FAILED
 *  - Device settings routing with deviceId
 */
import { describe, it, expect, vi } from 'vitest'
import type { IAddonSettingsProvider } from '@camstack/types'
import { makeCtx, invokeProcedure, checkAuthMatrix, buildCapRouterForTest } from './harness.js'

function makeMockProvider(): IAddonSettingsProvider {
  return {
    getGlobalSettings: vi.fn(async () => ({
      sections: [{ id: 'g', title: 'Global', fields: [] }],
    })),
    updateGlobalSettings: vi.fn(async () => ({ success: true as const })),
    getDeviceSettings: vi.fn(async () => ({
      sections: [{ id: 'd', title: 'Device', fields: [] }],
    })),
    updateDeviceSettings: vi.fn(async () => ({ success: true as const })),
  } as unknown as IAddonSettingsProvider
}

describe('addon-settings cap router', () => {
  it('getGlobalSettings returns schema', async () => {
    const provider = makeMockProvider()
    const router = buildCapRouterForTest('addon-settings', () => provider)
    const result = await invokeProcedure(router, 'getGlobalSettings', makeCtx('admin'), {
      addonId: 'test',
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.value).toEqual({ sections: [{ id: 'g', title: 'Global', fields: [] }] })
    expect(provider.getGlobalSettings).toHaveBeenCalledWith({ addonId: 'test' })
  })

  it('updateGlobalSettings returns success', async () => {
    const provider = makeMockProvider()
    const router = buildCapRouterForTest('addon-settings', () => provider)
    const result = await invokeProcedure(router, 'updateGlobalSettings', makeCtx('admin'), {
      addonId: 'test',
      patch: { volume: 50 },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ success: true })
  })

  it('getDeviceSettings passes deviceId', async () => {
    const provider = makeMockProvider()
    const router = buildCapRouterForTest('addon-settings', () => provider)
    await invokeProcedure(router, 'getDeviceSettings', makeCtx('admin'), {
      addonId: 'test',
      deviceId: 1,
    })
    expect(provider.getDeviceSettings).toHaveBeenCalledWith({ addonId: 'test', deviceId: 1 })
  })

  it('updateDeviceSettings passes deviceId + patch', async () => {
    const provider = makeMockProvider()
    const router = buildCapRouterForTest('addon-settings', () => provider)
    await invokeProcedure(router, 'updateDeviceSettings', makeCtx('admin'), {
      addonId: 'test',
      deviceId: 1,
      patch: { enabled: false },
    })
    expect(provider.updateDeviceSettings).toHaveBeenCalledWith({
      addonId: 'test',
      deviceId: 1,
      patch: { enabled: false },
    })
  })

  it('returns PRECONDITION_FAILED when provider is null', async () => {
    const router = buildCapRouterForTest('addon-settings', () => null)
    const result = await invokeProcedure(router, 'getGlobalSettings', makeCtx('admin'), {
      addonId: 'x',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PRECONDITION_FAILED')
  })

  it('getters enforce protected auth', async () => {
    const provider = makeMockProvider()
    const router = buildCapRouterForTest('addon-settings', () => provider)
    for (const method of ['getGlobalSettings', 'getDeviceSettings']) {
      const input = method.includes('Device') ? { addonId: 'x', deviceId: 1 } : { addonId: 'x' }
      const results = await checkAuthMatrix(router, method, 'protected', input)
      for (const r of results) {
        if (r.allowed) expect(r.outcome.ok).toBe(true)
        else expect(r.outcome.ok).toBe(false)
      }
    }
  })

  it('updaters enforce admin auth', async () => {
    const provider = makeMockProvider()
    const router = buildCapRouterForTest('addon-settings', () => provider)
    for (const method of ['updateGlobalSettings', 'updateDeviceSettings']) {
      const input = method.includes('Device')
        ? { addonId: 'x', deviceId: 1, patch: {} }
        : { addonId: 'x', patch: {} }
      const results = await checkAuthMatrix(router, method, 'admin', input)
      for (const r of results) {
        if (r.allowed) expect(r.outcome.ok).toBe(true)
        else expect(r.outcome.ok).toBe(false)
      }
    }
  })
})
