/**
 * The devices table with inline state labels and controls in the trailing cell: a contact
 * sensor reading, a number / choice control, and two heaters with the timed run (idle,
 * and armed). Names are long on purpose, to show the name column truncating on the right
 * on a phone. `--fixtures devices-inline-controls --route /devices`. Invented.
 */
import { defineFixtures } from './_define'
import sensorCard from './sensor-card'

const h: Readonly<Record<string, unknown>> = sensorCard.handlers
const ARMED_UNTIL = Date.now() + 23 * 60_000
const HEATER_SLICES: Record<number, Record<string, unknown>> = {
  910: {
    switch: { on: true, lastChangedAt: 1_700_000_000_000 },
    'timed-run': { activeUntil: null, quickRun: { duration: 30, unit: 'min' } },
  },
  911: {
    switch: { on: true, lastChangedAt: 1_700_000_000_000 },
    'timed-run': { activeUntil: ARMED_UNTIL, quickRun: { duration: 30, unit: 'min' } },
  },
}

const SHOWN: ReadonlySet<string> = new Set([
  'Kitchen window',
  'Hot water temperature',
  'Heating curve offset',
  'Hot water boost',
])

/** The window row reads "Closed" in the success tone (the sensor-card one is open). */
function closed(row: unknown): unknown {
  if (typeof row !== 'object' || row === null || !('measurement' in row)) return row
  const word = { en: 'Closed', it: 'Chiuso' }
  return {
    ...row,
    measurement: { ...(row.measurement as object), value: word, word, tone: 'success', level: 0 },
  }
}

const heater = (id: number, name: string) => ({
  id,
  stableId: `heater-${id}`,
  addonId: 'provider-homeassistant',
  type: 'switch',
  name,
  location: 'Living room',
  disabled: false,
  parentDeviceId: null,
  role: 'switch-heater',
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})
const HEATERS = [
  heater(910, 'Stufa soggiorno principale piano terra'),
  heater(911, 'Stufa cameretta Matthias'),
]
const heaterOf = (id: number | undefined) => HEATERS.find((d) => d.id === id)

const call = (path: string, i: unknown): unknown => {
  const handler = h[path]
  return typeof handler === 'function' ? Reflect.apply(handler, undefined, [i]) : handler
}

export default defineFixtures({
  area: 'devices-inline-controls',
  description: 'Devices table rows with inline state labels, controls and a timed run',
  handlers: {
    ...sensorCard.handlers,
    'integrations.list': [
      {
        id: 'int_ha',
        addonId: 'provider-homeassistant',
        name: 'MQTT Discovery',
        enabled: true,
        processState: 'running',
      },
    ],
    'deviceManager.listAll': (i: unknown) => [
      ...(call('deviceManager.listAll', i) as { name: string }[]).filter((d) => SHOWN.has(d.name)),
      ...HEATERS,
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      heaterOf(i.deviceId) ?? call('deviceManager.getDevice', i),
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      heaterOf(i.deviceId) === undefined
        ? call('deviceManager.getBindings', i)
        : {
            deviceId: i.deviceId ?? 0,
            entries: ['switch', 'timed-run', 'device-status'].map((capName) => ({
              capName,
              kind: 'native' as const,
              providerAddonId: 'provider-homeassistant',
              providerNodeId: 'hub',
              nativeAddonId: 'provider-homeassistant',
            })),
          },
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      HEATER_SLICES[i.deviceId ?? 0] ?? call('deviceState.getSnapshot', i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      HEATER_SLICES[i.deviceId ?? 0]?.[i.capName ?? ''] ?? call('deviceState.getCapSlice', i),
    'heroLayout.getRowModels': (i: { deviceIds?: readonly number[] }) =>
      (i.deviceIds ?? []).map((id) =>
        heaterOf(id) === undefined
          ? id === 1504
            ? closed((call('heroLayout.getRowModels', { ...i, deviceIds: [id] }) as unknown[])[0])
            : (call('heroLayout.getRowModels', { ...i, deviceIds: [id] }) as unknown[])[0]
          : null,
      ),
  },
})
