/**
 * `SetPirInfo` payload building and the 400 fallback. Some firmwares answer
 * the full `{enable, sensitive, reduceAlarm, interval}` write with
 * `responseCode 400` and an empty body while `getPirInfo` works: the retry
 * sends only the fields that read reported for this model.
 */

import type { PirState } from '@apocaliss92/nodelink-js'

export interface PirWritePayload {
  enable: number
  sensitive?: number
  reduceAlarm?: number
  interval?: number
}

export interface PirConfigView {
  readonly sensitive: number | undefined
  readonly reduceAlarm: boolean | undefined
  readonly interval: number | undefined
}

/** Full payload; tuning fields are omitted when the config has no value. */
export function buildPirPayload(enable: boolean, cfg: PirConfigView): PirWritePayload {
  return {
    enable: enable ? 1 : 0,
    ...(typeof cfg.sensitive === 'number' ? { sensitive: 101 - cfg.sensitive } : {}),
    ...(typeof cfg.reduceAlarm === 'boolean' ? { reduceAlarm: cfg.reduceAlarm ? 1 : 0 } : {}),
    ...(typeof cfg.interval === 'number' ? { interval: cfg.interval } : {}),
  }
}

/** Keep `enable` plus only the tuning fields the firmware reported on read. */
export function reducePirPayload(
  payload: PirWritePayload,
  reported: PirState['state'],
): PirWritePayload {
  const has = (key: 'sensitive' | 'reduceAlarm' | 'interval'): boolean =>
    typeof reported?.[key] === 'number'
  return {
    enable: payload.enable,
    ...(has('sensitive') && payload.sensitive !== undefined
      ? { sensitive: payload.sensitive }
      : {}),
    ...(has('reduceAlarm') && payload.reduceAlarm !== undefined
      ? { reduceAlarm: payload.reduceAlarm }
      : {}),
    ...(has('interval') && payload.interval !== undefined ? { interval: payload.interval } : {}),
  }
}

/** True for the firmware's `responseCode 400` refusal. */
export function isBaichuan400(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /responseCode\s*400/.test(message)
}
