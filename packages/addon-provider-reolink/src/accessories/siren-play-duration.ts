/**
 * The duration argument for `setSiren(channel, on, duration)`.
 *
 * The library's Baichuan path picks the "times" mode for ANY defined duration
 * (`duration !== undefined`), so a 0 sent as "until switched off" asked the
 * camera to play the alarm zero times: it acknowledged and stayed silent. Only
 * a positive count is a duration; everything else is the manual mode, where
 * `on` alone starts and stops the siren.
 */
export function sirenPlayDuration(
  on: boolean,
  configuredTimes: number | undefined,
): number | undefined {
  if (!on) return undefined
  return configuredTimes !== undefined && configuredTimes > 0 ? configuredTimes : undefined
}
