/**
 * `SetPirInfo` payload building and the firmware's 400 refusal check.
 */

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

/** True for the firmware's `responseCode 400` refusal. */
export function isBaichuan400(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /responseCode\s*400/.test(message)
}
