import type { RawPoint, RollupRow } from '../../rollup/rollup-math.js'
import type { RollupTier } from '../../time/bucket-time.js'
import type { Harness } from './harness.js'

const FAR_FUTURE = Number.MAX_SAFE_INTEGER

export function seriesOf(h: Harness, key: string, deviceId: number, scope = '') {
  return h.runtime.registry.find(key, `d:${deviceId}`, scope)
}

export async function rawOf(
  h: Harness,
  key: string,
  deviceId: number,
  scope = '',
): Promise<readonly RawPoint[]> {
  const series = seriesOf(h, key, deviceId, scope)
  if (series === undefined) return []
  return h.runtime.store.readRaw(series.id, 0, FAR_FUTURE, 20_000)
}

export async function rollupOf(
  h: Harness,
  tier: RollupTier,
  key: string,
  deviceId: number,
  scope = '',
): Promise<readonly RollupRow[]> {
  const series = seriesOf(h, key, deviceId, scope)
  if (series === undefined) return []
  return h.runtime.store.readRollups(tier, series.id, 0, FAR_FUTURE, 20_000)
}

/** Dispatch one `DeviceStateChanged` the way the addon shell does. */
export function emitState(
  h: Harness,
  deviceId: number,
  capName: string,
  slice: Readonly<Record<string, unknown>>,
): void {
  h.runtime.capture.handleState(deviceId, capName, slice, h.now())
}
