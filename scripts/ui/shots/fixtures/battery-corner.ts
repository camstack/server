/**
 * The device-card battery corner in its states (planning#709), on the battery
 * camera `/devices/102` of the camera-card fixture. Pick the state with the
 * `BATTERY_CASE` environment variable: `ok` (binary ok + voltage), `low`
 * (binary low + voltage), `level` (percentage + voltage), `voltage` (a voltage
 * and no level), `plain` (percentage only, today's look).
 * Load after `camera`, `history` and `camera-card`.
 */
import cameraCard from './camera-card'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const CASES: Readonly<Record<string, Record<string, unknown>>> = {
  ok: { level: 100, binary: true, voltage: 2.9 },
  low: { level: 15, binary: true, voltage: 2.1 },
  level: { level: 64, voltage: 3.7 },
  voltage: { level: null, voltage: 3.1 },
  plain: { level: 82 },
}

const BATTERY = {
  ...(CASES[process.env['BATTERY_CASE'] ?? 'ok'] ?? CASES['ok']),
  charging: 'none',
  sleeping: false,
  lastUpdated: NOW,
}

function inherited(path: string, input: unknown): unknown {
  const handler = cameraCard.handlers[path]
  return typeof handler === 'function' ? handler(input) : handler
}

export default defineFixtures({
  area: 'battery-corner',
  description: 'Camera 102 with the BATTERY_CASE battery slice',
  handlers: {
    'deviceState.getSnapshot': (i: { deviceId?: number }) => {
      const snapshot = inherited('deviceState.getSnapshot', i)
      return i.deviceId === 102 && typeof snapshot === 'object' && snapshot !== null
        ? { ...snapshot, battery: BATTERY }
        : snapshot
    },
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      i.deviceId === 102 && i.capName === 'battery'
        ? BATTERY
        : inherited('deviceState.getCapSlice', i),
  },
})
