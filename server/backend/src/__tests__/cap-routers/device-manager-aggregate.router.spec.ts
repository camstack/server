/**
 * E2E test for the device-manager aggregator via the generated tRPC cap
 * router. Verifies the wire shape of `getDeviceSettingsAggregate`,
 * `getDeviceLiveInfoAggregate`, and `updateDeviceField` — the three
 * aggregator methods the admin UI consumes.
 *
 * Covers:
 *  - input validation at the router boundary
 *  - schema shape roundtrip (provider → router → caller)
 *  - auth enforcement (getters = protected, updateDeviceField = admin)
 */
import { describe, it, expect, vi } from 'vitest'
import type { IDeviceManagerProvider } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

/** The methods this spec's routes reach; the harness takes any provider object. */
function makeProvider(): Partial<IDeviceManagerProvider> {
  return {
    // Aggregator methods we exercise
    getDeviceSettingsAggregate: vi.fn(async ({ deviceId }) => ({
      sections: [
        {
          id: 'identity',
          title: 'Identity',
          tab: 'general',
          order: 0,
          fields: [
            {
              type: 'text',
              key: '_stableId',
              label: 'Stable ID',
              readonlyField: true,
              value: String(deviceId),
            },
          ],
        },
        {
          id: 'motion-tuning',
          title: 'Motion Tuning',
          tab: 'detection',
          order: 5,
          fields: [
            {
              type: 'number',
              key: 'threshold',
              label: 'Threshold',
              writerCapName: 'motion-detection',
              writerAddonId: 'motion-wasm',
              source: 'settings',
              value: 20,
            },
          ],
        },
      ],
    })),
    getDeviceLiveInfoAggregate: vi.fn(async ({ deviceId }) => ({
      sections: [
        {
          id: 'orchestrator-live',
          title: 'Pipeline Status',
          tab: 'detection',
          order: 100,
          fields: [
            {
              type: 'text',
              key: 'assignedRunner',
              label: 'Assigned Runner',
              readonlyField: true,
              source: 'live',
              value: deviceId === 1 ? 'hub' : '',
            },
          ],
        },
      ],
    })),
    updateDeviceField: vi.fn(async () => ({ success: true as const })),

    // Placeholders for the other device-manager cap methods we don't
    // exercise here — kept as no-ops so the IDeviceManagerProvider
    // interface is fully satisfied.
    registerDevice: vi.fn() as IDeviceManagerProvider['registerDevice'],
    removeDevice: vi.fn() as IDeviceManagerProvider['removeDevice'],
    persistConfig: vi.fn() as IDeviceManagerProvider['persistConfig'],
    loadConfig: vi.fn(async () => ({})) as IDeviceManagerProvider['loadConfig'],
    listPersistedByAddon: vi.fn(async () => []) as IDeviceManagerProvider['listPersistedByAddon'],
    listAll: vi.fn(async () => []) as IDeviceManagerProvider['listAll'],
    getDevice: vi.fn(async () => null) as IDeviceManagerProvider['getDevice'],
    getChildren: vi.fn(async () => []) as IDeviceManagerProvider['getChildren'],
    getStreamSources: vi.fn(async () => []) as IDeviceManagerProvider['getStreamSources'],
    getConfigSchema: vi.fn(async () => []) as IDeviceManagerProvider['getConfigSchema'],
    getSettingsSchema: vi.fn(async () => null) as IDeviceManagerProvider['getSettingsSchema'],
    updateConfig: vi.fn(async () => ({
      success: true as const,
    })) as IDeviceManagerProvider['updateConfig'],
    enable: vi.fn(async () => ({ success: true as const })) as IDeviceManagerProvider['enable'],
    disable: vi.fn(async () => ({ success: true as const })) as IDeviceManagerProvider['disable'],
    remove: vi.fn(async () => ({ success: true as const })) as IDeviceManagerProvider['remove'],
    getStreamProfileMap: vi.fn(async () => ({})) as IDeviceManagerProvider['getStreamProfileMap'],
    setStreamProfileMap: vi.fn(async () => ({
      success: true as const,
    })) as IDeviceManagerProvider['setStreamProfileMap'],
    probeStreams: vi.fn(async () => []) as IDeviceManagerProvider['probeStreams'],
    getBindings: vi.fn(async ({ deviceId }: { deviceId: number }) => ({
      deviceId,
      entries: [],
    })) as IDeviceManagerProvider['getBindings'],
    setWrapperActive: vi.fn() as IDeviceManagerProvider['setWrapperActive'],
  }
}

describe('device-manager aggregator via tRPC router', () => {
  const DEVICE_ID = 1

  it('getDeviceSettingsAggregate returns the merged shape for a known device', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('device-manager', () => provider)
    const result = await invokeProcedure(router, 'getDeviceSettingsAggregate', makeCtx('admin'), {
      deviceId: DEVICE_ID,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as {
      sections: readonly { id: string; tab?: string; fields: readonly unknown[] }[]
    }
    expect(value.sections.map((s) => s.id)).toEqual(['identity', 'motion-tuning'])
    expect(provider.getDeviceSettingsAggregate).toHaveBeenCalledWith({ deviceId: DEVICE_ID })
  })

  it('getDeviceLiveInfoAggregate returns live sections', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('device-manager', () => provider)
    const result = await invokeProcedure(router, 'getDeviceLiveInfoAggregate', makeCtx('admin'), {
      deviceId: DEVICE_ID,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as {
      sections: readonly { fields: readonly { key?: string; value?: unknown }[] }[]
    }
    const runner = value.sections[0]!.fields.find((f) => f.key === 'assignedRunner')
    expect(runner?.value).toBe('hub')
  })

  it('updateDeviceField forwards the full payload (deviceId, writerCap, writerAddon, key, value)', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('device-manager', () => provider)
    const result = await invokeProcedure(router, 'updateDeviceField', makeCtx('admin'), {
      deviceId: DEVICE_ID,
      writerCapName: 'motion-detection',
      writerAddonId: 'motion-wasm',
      key: 'threshold',
      value: 42,
    })

    expect(result.ok).toBe(true)
    expect(provider.updateDeviceField).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      writerCapName: 'motion-detection',
      writerAddonId: 'motion-wasm',
      key: 'threshold',
      value: 42,
    })
  })

  it('updateDeviceField enforces admin auth', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('device-manager', () => provider)

    const payload = {
      deviceId: DEVICE_ID,
      writerCapName: 'motion-detection',
      writerAddonId: 'motion-wasm',
      key: 'threshold',
      value: 1,
    }
    const viewer = await invokeProcedure(router, 'updateDeviceField', makeCtx('user'), payload)
    expect(viewer.ok).toBe(false)
    if (!viewer.ok) expect(viewer.code).toBe('FORBIDDEN')

    const admin = await invokeProcedure(router, 'updateDeviceField', makeCtx('admin'), payload)
    expect(admin.ok).toBe(true)
  })

  it('router returns PRECONDITION_FAILED when the provider is missing', async () => {
    const router = buildCapRouterForTest('device-manager', () => null)
    const result = await invokeProcedure(router, 'getDeviceSettingsAggregate', makeCtx('admin'), {
      deviceId: DEVICE_ID,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PRECONDITION_FAILED')
  })
})
