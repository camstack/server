import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import { mapHaEntityToCamStack, inferParentDeviceType } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — WAVE A domains', () => {
  it('update.* → DeviceType.Update, capabilities: [update]', () => {
    const m = mapHaEntityToCamStack({ domain: 'update', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Update)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['update'])
  })

  it('siren.* → DeviceType.Siren, capabilities: [switch]', () => {
    const m = mapHaEntityToCamStack({ domain: 'siren', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Siren)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['switch'])
  })

  it('remote.* → DeviceType.Switch, capabilities: [switch]', () => {
    const m = mapHaEntityToCamStack({ domain: 'remote', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Switch)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['switch'])
  })

  it('scene.* → DeviceType.Button, capabilities: [button] (no longer null)', () => {
    const m = mapHaEntityToCamStack({ domain: 'scene', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Button)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['button'])
  })

  it.each([
    'date',
    'time',
    'datetime',
  ] as const)('%s.* → DeviceType.Control role DateTimeControl, capabilities: [control]', (domain) => {
    const m = mapHaEntityToCamStack({ domain, deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Control)
    expect(m?.role).toBe(DeviceRole.DateTimeControl)
    expect(m?.capabilities).toEqual(['control'])
  })

  it('input_datetime.* stays Control / DateTimeControl', () => {
    const m = mapHaEntityToCamStack({ domain: 'input_datetime', deviceClass: null, attributes: {} })
    expect(m?.deviceType).toBe(DeviceType.Control)
    expect(m?.role).toBe(DeviceRole.DateTimeControl)
    expect(m?.capabilities).toEqual(['control'])
  })

  it('inferParentDeviceType picks Siren for a lone siren entity', () => {
    // Siren is now in PARENT_TYPE_PRIORITY (switch-family actuator), so a
    // device owning only a siren entity renders as Siren, not Generic.
    const parent = inferParentDeviceType([{ deviceType: DeviceType.Siren }])
    expect(parent).toBe(DeviceType.Siren)
  })

  it('inferParentDeviceType picks Update for an update-only device', () => {
    // A device whose only entity is an `update.*` should render as Update
    // (weak parent signal but better than Generic).
    const parent = inferParentDeviceType([{ deviceType: DeviceType.Update }])
    expect(parent).toBe(DeviceType.Update)
  })

  it('inferParentDeviceType yields Generic for a domain with no mapping', () => {
    // An unmapped/future domain maps to null — a device with only unmapped
    // entities still falls through to Generic, confirming that path is intact.
    const m = mapHaEntityToCamStack({
      domain: 'climate_remote_control',
      deviceClass: null,
      attributes: {},
    })
    expect(m).toBeNull()
    const parent = inferParentDeviceType([m])
    expect(parent).toBe(DeviceType.Generic)
  })

  it('inferParentDeviceType picks Image for a lone camera entity', () => {
    // camera.* is modelled as a read-only Image (the entity_picture still), so
    // a device owning only a camera entity infers Image — not a streamable
    // Camera. Keeps the stream broker out for snapshot-only sources.
    const m = mapHaEntityToCamStack({ domain: 'camera', deviceClass: null, attributes: {} })
    expect(m?.deviceType).toBe(DeviceType.Image)
    expect(inferParentDeviceType([m])).toBe(DeviceType.Image)
  })

  it('inferParentDeviceType prefers a stronger actuator over Siren/Update', () => {
    // Switch outranks Siren; both outrank Update. Confirms ordering intact.
    expect(
      inferParentDeviceType([
        { deviceType: DeviceType.Update },
        { deviceType: DeviceType.Siren },
        { deviceType: DeviceType.Switch },
      ]),
    ).toBe(DeviceType.Switch)
  })

  it('inferParentDeviceType picks Switch over Sensor for remote + sensor set', () => {
    const parent = inferParentDeviceType([
      { deviceType: DeviceType.Sensor },
      { deviceType: DeviceType.Switch },
    ])
    expect(parent).toBe(DeviceType.Switch)
  })
})
