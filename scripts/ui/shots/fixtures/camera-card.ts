/**
 * The camera device card: `/devices/102` "Garden" is a battery camera (charge,
 * power source, sleeping, last motion), `/devices/101` "Driveway" a mains
 * camera that only reports motion. Load after `camera` and `history`
 * (`--fixtures camera,history,camera-card`): the history series are 101's.
 */
import cameraArea from './camera'
import historyArea from './history'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const MINUTE_MS = 60_000

// Zones are fractions of the IMAGE. 102 (portrait) has one covering exactly the
// synthetic subject of `stubs/snapshot-frames`; 101 (4:3) has none.
const SUBJECT_ZONE = {
  id: 'zone-subject',
  name: 'Subject',
  kind: 'polygon',
  color: '#ec4899',
  polygon: [
    { x: 0.2, y: 0.3 },
    { x: 0.8, y: 0.3 },
    { x: 0.8, y: 0.7 },
    { x: 0.2, y: 0.7 },
  ],
}

const SLICES: Readonly<Record<number, Readonly<Record<string, unknown>>>> = {
  101: {
    zones: { zones: [] },
    motion: { detected: false, lastDetectedAt: NOW - 2 * MINUTE_MS, autoClearAfterMs: null },
  },
  102: {
    zones: { zones: [SUBJECT_ZONE] },
    battery: { level: 82, charging: 'none', sleeping: true, lastUpdated: NOW },
    'low-power-sleep': { sleeping: true, lastUpdated: NOW },
    motion: { detected: false, lastDetectedAt: NOW - 14 * MINUTE_MS, autoClearAfterMs: null },
  },
}

const run = (area: typeof cameraArea, path: string, input: unknown): unknown => {
  const h = area.handlers[path]
  return typeof h === 'function' ? (h as (x: unknown) => unknown)(input) : h
}

const slicesOf = (id: number | undefined): Readonly<Record<string, unknown>> =>
  SLICES[id ?? 0] ?? {}

export default defineFixtures({
  area: 'camera-card',
  description:
    'Camera card: battery / sleep / motion state, synthetic stills (101 4:3 with no zones, 102 portrait with a zone)',
  handlers: {
    'deviceManager.getDevice': (i: unknown) => run(cameraArea, 'deviceManager.getDevice', i),
    'deviceManager.getDeviceAggregate': (i: unknown) =>
      run(cameraArea, 'deviceManager.getDeviceAggregate', i),
    'deviceManager.getChildren': [],
    'deviceManager.getBindings': (i: { deviceId?: number }) => {
      const base = run(historyArea, 'deviceManager.getBindings', i) as {
        deviceId: number
        entries: readonly unknown[]
      }
      return {
        ...base,
        entries: [
          ...base.entries,
          ...Object.keys(slicesOf(i.deviceId)).map((capName) => ({
            capName,
            kind: 'native' as const,
            providerAddonId: 'provider-reolink',
            providerNodeId: 'hub',
            nativeAddonId: 'provider-reolink',
          })),
        ],
      }
    },
    'deviceState.getSnapshot': (i: { deviceId?: number }) => ({
      'device-status': { online: true, lastChangedAt: NOW - 3_600_000 },
      ...slicesOf(i.deviceId),
    }),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      slicesOf(i.deviceId)[i.capName ?? ''] ?? null,
    'deviceHistory.listSeries': (i: { deviceId?: number }) =>
      run(historyArea, 'deviceHistory.listSeries', { ...i, deviceId: 101 }),
    'deviceHistory.queryMany': (i: { items?: readonly { deviceId?: number }[] }) =>
      run(historyArea, 'deviceHistory.queryMany', {
        ...i,
        items: (i.items ?? []).map((item) => ({ ...item, deviceId: 101 })),
      }),
  },
})
