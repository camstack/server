/**
 * Hero cards for the public "Supported devices" pages: a light (601), a switch
 * (602), a cover (603), a thermostat (604), a lock (605), a gateway (606) and a climate sensor (607),
 * with invented names. Every other device id falls through to `appliances`
 * (dishwasher 501, vacuum 502, pet feeder 5064, pet fountain 5065, air
 * conditioner 521, sensor 511), so `--fixtures docs-device-types` shoots all
 * of them. Also answers the two reads a device page always makes
 * (`powerSource.getStatus`, `preferences.get`).
 */
import appliancesArea from './appliances'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const HA = 'provider-homeassistant'

const device = (id: number, name: string, type: string, addonId: string, location: string) => ({
  id,
  stableId: `docs-${id}`,
  addonId,
  type,
  name,
  location,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: type === 'light' ? ['light-color-mired'] : [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: { manufacturer: 'Example', model: `${type}-1` },
})

const DEVICES: Readonly<Record<number, ReturnType<typeof device>>> = {
  601: device(601, 'Hall lamp', 'light', HA, 'Hall'),
  602: device(602, 'Garden pump', 'switch', HA, 'Garden'),
  603: device(603, 'Living room blinds', 'cover', HA, 'Living room'),
  604: device(604, 'Hall thermostat', 'thermostat', HA, 'Hall'),
  605: device(605, 'Front door', 'lock', HA, 'Front of house'),
  606: device(606, 'Window gateway', 'gateway', 'provider-velux', 'Hall'),
  607: device(607, 'Hall climate sensor', 'sensor', HA, 'Hall'),
}

const BINDING_CAPS: Readonly<Record<number, readonly string[]>> = {
  601: ['switch', 'brightness', 'color', 'device-status'],
  602: ['switch', 'device-status'],
  603: ['cover', 'battery', 'device-status'],
  604: ['climate-control', 'temperature-sensor', 'humidity-sensor', 'battery', 'device-status'],
  605: ['lock-control', 'battery', 'device-status'],
  606: ['device-status'],
  607: ['temperature-sensor', 'humidity-sensor', 'battery', 'device-status'],
}

const SLICES: Readonly<Record<string, unknown>> = {
  '601/switch': { on: true, lastChangedAt: NOW },
  '601/brightness': { level: 70, lastChangedAt: NOW },
  '601/color': { mode: 'mired', colorTemperature: 370, lastChangedAt: NOW },
  '602/switch': { on: false, lastChangedAt: NOW },
  '603/cover': { state: 'open', position: 60, tiltPosition: null, lastChangedAt: NOW },
  '603/battery': { level: 88, lastChangedAt: NOW },
  '604/climate-control': {
    mode: 'heat',
    availableModes: ['off', 'heat', 'auto'],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: 21,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: 19.6,
    currentHumidity: 48,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: 5,
    maxTemp: 30,
    tempStep: 0.5,
    lastFetchedAt: NOW,
  },
  '604/temperature-sensor': { temperature: 19.6 },
  '604/humidity-sensor': { humidity: 48 },
  '604/battery': { level: 74, lastChangedAt: NOW },
  '607/temperature-sensor': { temperature: 21.4 },
  '607/humidity-sensor': { humidity: 52 },
  '607/battery': { level: 93, lastChangedAt: NOW },
  '605/lock-control': { state: 'locked', lastChangedAt: NOW },
  '605/battery': { level: 61, lastChangedAt: NOW },
}

const slice = (id: number, cap: string): unknown =>
  cap === 'device-status' ? { online: true, lastChangedAt: NOW } : (SLICES[`${id}/${cap}`] ?? null)

const base = (path: string): ((i: unknown) => unknown) => {
  const h = appliancesArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}

export default defineFixtures({
  area: 'docs-device-types',
  description:
    'Hero cards of a light, switch, cover, thermostat, lock and gateway, plus appliances',
  handlers: {
    ...appliancesArea.handlers,
    'powerSource.getStatus': {
      linked: false,
      switchDeviceId: null,
      switchName: null,
      switchOn: null,
      switchOnline: null,
      restartInProgress: false,
      offSeconds: 0,
    },
    'preferences.get': { rows: [] },
    'deviceManager.listAll': (i: unknown) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      ...Object.values(DEVICES),
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      DEVICES[i.deviceId ?? -1] ?? base('deviceManager.getDevice')(i),
    'deviceManager.getBindings': (i: { deviceId?: number }) => {
      const caps = BINDING_CAPS[i.deviceId ?? -1]
      if (caps === undefined) return base('deviceManager.getBindings')(i)
      const addonId = DEVICES[i.deviceId ?? -1]?.addonId ?? HA
      return {
        deviceId: i.deviceId ?? 0,
        entries: caps.map((capName) => ({
          capName,
          kind: 'native' as const,
          providerAddonId: addonId,
          providerNodeId: 'hub',
          nativeAddonId: addonId,
        })),
      }
    },
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      DEVICES[i.deviceId ?? -1] === undefined
        ? base('deviceState.getCapSlice')(i)
        : slice(i.deviceId ?? 0, i.capName ?? ''),
    'deviceState.getSnapshot': (i: { deviceId?: number }) => {
      const caps = BINDING_CAPS[i.deviceId ?? -1]
      if (caps === undefined) return base('deviceState.getSnapshot')(i)
      return Object.fromEntries(caps.map((c) => [c, slice(i.deviceId ?? 0, c)]))
    },
  },
})
