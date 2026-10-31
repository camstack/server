import { describe, expect, it } from 'vitest'
import { addDeviceUrl, computeAddDeviceTargets, setupIntegrationUrl } from '../add-device-targets'

const types = [
  { addonId: 'provider-reolink', name: 'Reolink', canAdd: true },
  { addonId: 'provider-hue', name: 'Hue', canAdd: true },
  { addonId: 'notification-center', name: 'Alarm', canAdd: true },
  { addonId: 'viewer', name: 'Viewer', canAdd: false },
]
const inst = (id: string, addonId: string, extra: object = {}) => ({
  id,
  addonId,
  name: id,
  enabled: true,
  ...extra,
})

describe('computeAddDeviceTargets', () => {
  it('lists each installed integration type, sorted, with its enabled instances', () => {
    const out = computeAddDeviceTargets(types, [
      inst('a', 'provider-reolink'),
      inst('b', 'provider-reolink', { enabled: false }),
    ])
    expect(out.map((t) => t.name)).toEqual(['Alarm', 'Hue', 'Reolink'])
    expect(out.find((t) => t.addonId === 'provider-reolink')?.instances.map((i) => i.id)).toEqual([
      'a',
    ])
    expect(out.find((t) => t.addonId === 'provider-hue')?.instances).toEqual([])
  })

  it('skips a type that cannot add devices', () => {
    expect(computeAddDeviceTargets(types, []).map((t) => t.addonId)).not.toContain('viewer')
  })

  it('drops an addon whose only integration is fixed', () => {
    const out = computeAddDeviceTargets(types, [
      inst('nc', 'notification-center', { info: { fixed: true } }),
    ])
    expect(out.map((t) => t.addonId)).not.toContain('notification-center')
  })

  it('is empty when no integration type is installed', () => {
    expect(computeAddDeviceTargets([], [inst('a', 'x')])).toEqual([])
  })
})

describe('urls', () => {
  it('opens the add flow on the instance', () => {
    expect(addDeviceUrl('provider-reolink', 'int 1')).toBe(
      '/integrations/provider-reolink?instance=int%201&add=1',
    )
  })
  it('opens the wizard on the addon', () => {
    expect(setupIntegrationUrl('provider-hue')).toBe('/integrations?setup=provider-hue')
  })
})
