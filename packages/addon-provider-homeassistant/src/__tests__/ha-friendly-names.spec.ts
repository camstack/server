/**
 * Discovery shows human names. The stored config value stays the service id;
 * only `suggestedName` (and so the service select's label) is friendly.
 */
import { describe, expect, it } from 'vitest'
import {
  createHaNotificationOutputProvider,
  HaTargetStore,
  mobileAppDeviceNames,
  parseNotifyServices,
} from '../ha-notification-output.js'
import { makeHaRecords } from './fake-records.js'

const REGISTRY = [
  {
    id: 'd1',
    name: 'Pixel 7',
    name_by_user: null,
    identifiers: [['mobile_app', 'abc']],
  },
  {
    id: 'd2',
    name: 'iPhone',
    name_by_user: "Gianluca's iPhone",
    identifiers: [['mobile_app', 'def']],
  },
  {
    id: 'd3',
    name: 'Hue Bridge',
    name_by_user: null,
    identifiers: [['hue', 'zzz']],
  },
]

describe('mobileAppDeviceNames', () => {
  it('maps mobile_app_<slug> to the device name, preferring the name the user gave', () => {
    const names = mobileAppDeviceNames(REGISTRY)
    expect(names.get('mobile_app_pixel_7')).toBe('Pixel 7')
    expect(names.get('mobile_app_gianluca_s_iphone')).toBe("Gianluca's iPhone")
  })
  it('ignores devices of other integrations and a malformed registry', () => {
    expect(mobileAppDeviceNames(REGISTRY).size).toBe(2)
    expect(mobileAppDeviceNames(null).size).toBe(0)
  })
})

describe('parseNotifyServices friendly names', () => {
  const services = {
    notify: {
      mobile_app_pixel_7: { name: null },
      alexa_media_echo_dot: {},
      smtp_relay: { name: 'Mail relay', description: 'Send e-mail' },
    },
  }
  const labels = (devices?: ReadonlyMap<string, string>): Record<string, string> =>
    Object.fromEntries(
      parseNotifyServices(services, 'b1', devices).map((c) => [
        String(c.config['service']),
        c.suggestedName,
      ]),
    )

  it('uses the service name HA gives', () => {
    expect(labels().smtp_relay).toBe('Mail relay')
  })
  it('uses the registry device name for a mobile app', () => {
    expect(labels(mobileAppDeviceNames(REGISTRY)).mobile_app_pixel_7).toBe('Pixel 7')
  })
  it('falls back to the prettified id, never notify.<id>', () => {
    const all = labels()
    expect(all.alexa_media_echo_dot).toBe('Alexa Media Echo Dot')
    expect(all.mobile_app_pixel_7).toBe('Mobile App Pixel 7')
    expect(Object.values(all).some((v) => v.startsWith('notify.'))).toBe(false)
  })
  it('keeps the service id as the stored value', () => {
    const c = parseNotifyServices(services, 'b1', mobileAppDeviceNames(REGISTRY))
    expect(c.map((x) => x.config['service'])).toContain('mobile_app_pixel_7')
  })
})

describe('provider discovery reads the device registry', () => {
  it('names a mobile app after its device', async () => {
    const store = HaTargetStore.of((await makeHaRecords()).records)
    const provider = createHaNotificationOutputProvider({
      addonId: 'provider-homeassistant',
      store,
      publish: async () => {},
      getServices: async () => ({ notify: { mobile_app_pixel_7: {} } }),
      listDevices: async () => REGISTRY,
      listBrokerIds: () => ['b1'],
    })
    const found = await provider.discoverTargets({
      kind: 'homeassistant',
      config: { brokerId: 'b1' },
    })
    expect(found[0]?.suggestedName).toBe('Pixel 7')
    expect(found[0]?.config['service']).toBe('mobile_app_pixel_7')
  })
  it('still answers when the registry read fails', async () => {
    const store = HaTargetStore.of((await makeHaRecords()).records)
    const provider = createHaNotificationOutputProvider({
      addonId: 'provider-homeassistant',
      store,
      publish: async () => {},
      getServices: async () => ({ notify: { mobile_app_pixel_7: {} } }),
      listDevices: async () => {
        throw new Error('ws closed')
      },
      listBrokerIds: () => ['b1'],
    })
    const found = await provider.discoverTargets({ kind: 'homeassistant' })
    expect(found[0]?.suggestedName).toBe('Mobile App Pixel 7')
  })
})
