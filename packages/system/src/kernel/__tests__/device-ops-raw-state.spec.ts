import { describe, it, expect } from 'vitest'
import { buildDeviceOpsProvider } from '../moleculer/device-cap-proxy.js'

function fakeDevice(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    config: { entries: () => [] },
    removeDevice: async () => {},
    applySettingsPatch: async () => {},
    getSettingsUISchema: () => null,
    ...extra,
  } as unknown as Parameters<typeof buildDeviceOpsProvider>[0]
}

describe('buildDeviceOpsProvider.getRawState', () => {
  it('returns null when the device does not implement getRawState', async () => {
    const provider = buildDeviceOpsProvider(fakeDevice(7))
    expect(await provider.getRawState({ deviceId: 7 })).toBeNull()
  })

  it('forwards to device.getRawState when present', async () => {
    const provider = buildDeviceOpsProvider(
      fakeDevice(7, {
        getRawState: async () => ({ source: 'homeassistant', data: { state: 'on' } }),
      }),
    )
    expect(await provider.getRawState({ deviceId: 7 })).toEqual({
      source: 'homeassistant',
      data: { state: 'on' },
    })
  })

  it('rejects a deviceId mismatch', async () => {
    const provider = buildDeviceOpsProvider(fakeDevice(7))
    await expect(provider.getRawState({ deviceId: 9 })).rejects.toThrow(/mismatch/)
  })
})
