import { describe, it, expect } from 'vitest'
import { DeviceInfoSchema, DeviceMetaSchema } from '../device-manager.cap.js'

const minimalMeta = {
  id: 1,
  stableId: 'dev-1',
  addonId: 'addon-rtsp',
  type: 'camera',
  name: 'Test Camera',
  location: null,
  disabled: false,
  parentDeviceId: null,
}

const minimalInfo = {
  id: 1,
  stableId: 'dev-1',
  addonId: 'addon-rtsp',
  type: 'camera' as const,
  name: 'Test Camera',
  location: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  probed: true,
  features: [],
  isCamera: true,
  config: {},
}

describe('device meta integrationId', () => {
  it('DeviceMetaSchema accepts + round-trips integrationId', () => {
    const m = DeviceMetaSchema.parse({ ...minimalMeta, integrationId: 'int-1' })
    expect(m.integrationId).toBe('int-1')
  })

  it('integrationId is optional (absent ok)', () => {
    const m = DeviceMetaSchema.parse(minimalMeta)
    expect(m.integrationId).toBeUndefined()
  })

  it('DeviceInfoSchema carries integrationId', () => {
    const d = DeviceInfoSchema.parse({ ...minimalInfo, integrationId: 'int-1' })
    expect(d.integrationId).toBe('int-1')
  })

  it('DeviceInfoSchema integrationId is optional (absent ok)', () => {
    const d = DeviceInfoSchema.parse(minimalInfo)
    expect(d.integrationId).toBeUndefined()
  })
})
