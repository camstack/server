import type { UiTextFn } from '../../../contexts/ui-text'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "6 min", "2 h", "3 d": how long ago, in the one unit a card corner has room for. */
export function coarseDuration(ms: number, t: UiTextFn): string {
  if (ms >= DAY_MS) {
    return t('uiLibrary.deviceCard.days', '{{n}} d', { n: Math.floor(ms / DAY_MS) })
  }
  if (ms >= HOUR_MS) {
    return t('uiLibrary.deviceCard.hours', '{{n}} h', { n: Math.floor(ms / HOUR_MS) })
  }
  return t('uiLibrary.deviceCard.minutes', '{{n}} min', {
    n: Math.max(1, Math.floor(ms / MINUTE_MS)),
  })
}
