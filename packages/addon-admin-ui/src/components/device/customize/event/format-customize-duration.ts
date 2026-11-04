/**
 * A duration on the Customize tab. Under a minute the count is a plural
 * second phrase; from a minute up it is {@link humanDuration} (days and
 * hours included). No second formatter.
 */
import i18n from '../../../../i18n/index'
import { humanDuration } from '../../../../pages/system/notification-rule-status'

const MINUTE_S = 60

export function formatCustomizeSeconds(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0
  if (whole < MINUTE_S) return i18n.t('customize.event.durationSeconds', { count: whole })
  return humanDuration(whole * 1000)
}
