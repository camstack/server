/**
 * Presentation helpers for the `event-emitter` cap — pure, so the rendering
 * decisions can be asserted without a DOM.
 *
 * The cap carries the source's vocabulary VERBATIM (`PRESS_SHORT`,
 * `press_long`, `zha_event`, …) and an OPTIONAL free-form `data` bag. The only
 * key this file interprets is `channel` — the button index a multi-key remote
 * reports — and it interprets it DEFENSIVELY: a device that omits it (every
 * single-button emitter, and every HA bus event) must still render, showing
 * just the event type. Nothing here is vendor-specific; the cap is the
 * contract, not the provider.
 */

import i18n from '../../../i18n/index'

/** The `lastEvent` shape this module reads (a structural subset of `EventFire`). */
export interface EventFireLike {
  readonly eventType: string
  readonly data: Record<string, unknown> | null
  readonly timestamp: number
  readonly seq: number
}

/**
 * The button index carried in `data.channel`, or `null` when the device does
 * not report one. Non-integer / negative values are rejected rather than
 * rendered — a bogus index reads as a real button and would be worse than
 * showing none.
 */
export function channelIndexOf(data: Record<string, unknown> | null | undefined): number | null {
  if (!data) return null
  const raw = data.channel
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null
  return raw
}

/**
 * Headline for the last press: `"Button 1 · PRESS_SHORT"` when the device
 * reports a channel, `"PRESS_SHORT"` when it doesn't. `null` for "never fired"
 * so the caller can render the empty state instead of an empty string.
 */
export function formatEventHeadline(fire: EventFireLike | null | undefined): string | null {
  if (!fire) return null
  const channel = channelIndexOf(fire.data)
  return channel === null
    ? fire.eventType
    : i18n.t('helpers.eventEmitterFormat.buttonHeadline', {
        channel: String(channel),
        eventType: fire.eventType,
      })
}

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Second-granular relative age — a press is an instant, and the hero's whole
 * job is to say how long ago it happened. The shared `formatRelativeTime`
 * collapses everything under 30 s to "just now", which erases exactly the
 * window an operator is watching while they press the button.
 *
 * `now` is injected so the formatting is testable without faking the clock.
 */
export function formatEventAge(timestampMs: number | null | undefined, now: number): string {
  if (timestampMs === null || timestampMs === undefined || timestampMs <= 0) return '—'
  const delta = now - timestampMs
  if (delta < SECOND_MS) return i18n.t('helpers.relativeTime.justNow')
  if (delta < MINUTE_MS)
    return i18n.t('helpers.relativeTime.secondsAgo', { count: Math.floor(delta / SECOND_MS) })
  if (delta < HOUR_MS)
    return i18n.t('helpers.relativeTime.minutesAgo', { count: Math.floor(delta / MINUTE_MS) })
  if (delta < DAY_MS)
    return i18n.t('helpers.relativeTime.hoursAgo', { count: Math.floor(delta / HOUR_MS) })
  return i18n.t('helpers.relativeTime.daysAgo', { count: Math.floor(delta / DAY_MS) })
}
