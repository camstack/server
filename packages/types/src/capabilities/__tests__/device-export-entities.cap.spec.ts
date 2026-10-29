import { describe, expect, it } from 'vitest'
import {
  deviceExportCapability,
  ExportEntityKindSchema,
  ExportEntityRefSchema,
  ExposeEntityInputSchema,
} from '../device-export.cap.js'

describe('device-export entity references', () => {
  it('accepts the three entity kinds and keeps the discriminator', () => {
    expect(ExportEntityRefSchema.parse({ kind: 'device', deviceId: '7' })).toEqual({
      kind: 'device',
      deviceId: '7',
    })
    expect(ExportEntityRefSchema.parse({ kind: 'action', actionId: 'a1' })).toEqual({
      kind: 'action',
      actionId: 'a1',
    })
    expect(ExportEntityRefSchema.parse({ kind: 'notifier', targetId: 't1' })).toEqual({
      kind: 'notifier',
      targetId: 't1',
    })
  })

  it('refuses a ref whose id field does not match its kind', () => {
    expect(ExportEntityRefSchema.safeParse({ kind: 'action', deviceId: '7' }).success).toBe(false)
    expect(ExportEntityRefSchema.safeParse({ kind: 'scene', actionId: 'a' }).success).toBe(false)
  })

  it('lists the kinds an exporter may answer', () => {
    expect(ExportEntityKindSchema.options).toEqual(['device', 'action', 'notifier'])
    expect(
      ExposeEntityInputSchema.parse({ entity: { kind: 'action', actionId: 'a' } }).entity.kind,
    ).toBe('action')
  })

  it('declares the entity methods; the mutations are admin-only, the device methods stay', () => {
    const m = deviceExportCapability.methods
    expect(m.exposeEntity.auth).toBe('admin')
    expect(m.unexposeEntity.auth).toBe('admin')
    expect(m.exposeEntity.kind).toBe('mutation')
    expect(Object.keys(m)).toEqual(
      expect.arrayContaining([
        'exposeDevice',
        'unexposeDevice',
        'listExposedDevices',
        'listSupportedDeviceKinds',
        'listSupportedEntityKinds',
        'listExposedEntities',
      ]),
    )
  })
})
