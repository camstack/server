import type { ExposureMode } from '@camstack/types'

/**
 * Reolink's `InputAdvanceCfg.Exposure.mode` (Baichuan cmdId 25/26, via
 * `setIsp`/`getIsp`) uses the same two values as the `image-settings`
 * cap's `ExposureMode` (`'auto' | 'manual'`), modulo case — firmwares
 * report it in varying case. Returns `undefined` for any other/missing
 * value so the caller can omit the field rather than report a lie.
 */
export function reolinkExposureModeToCap(raw: string | undefined): ExposureMode | undefined {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.toLowerCase()
  return normalized === 'auto' || normalized === 'manual' ? normalized : undefined
}
