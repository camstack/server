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

import type { EventVocabularyEntry, EventVocabularySource } from '@camstack/types'
import { findVocabularyEntry } from '@camstack/types'
import i18n from '../../../i18n/index'

/** The `lastEvent` shape this module reads (a structural subset of `EventFire`). */
export interface EventFireLike {
  readonly eventType: string
  /** The part of the device that fired (a button), when the fire names one. */
  readonly sourceId?: string
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

/**
 * One notice every described entry agrees on. Entries with no description are
 * ignored. Disagreeing descriptions return null so the hero does not pick one.
 */
export function sharedVocabularyNotice(vocabulary: readonly EventVocabularyEntry[]): string | null {
  let notice: string | null = null
  for (const entry of vocabulary) {
    const description = entry.description
    if (description === undefined || description.length === 0) continue
    if (notice === null) {
      notice = description
      continue
    }
    if (notice !== description) return null
  }
  return notice
}

/** The events one part of the device fires; `source: null` holds the ones that name no part. */
export interface VocabularyGroup {
  readonly source: EventVocabularySource | null
  readonly entries: readonly EventVocabularyEntry[]
}

/** The declared vocabulary under the part that fires each event, in declared order, sourceless last. */
export function groupVocabulary(
  vocabulary: readonly EventVocabularyEntry[],
): readonly VocabularyGroup[] {
  const bySource = new Map<string, VocabularyGroup>()
  const loose: EventVocabularyEntry[] = []
  for (const entry of vocabulary) {
    if (entry.source === undefined) {
      loose.push(entry)
      continue
    }
    const group = bySource.get(entry.source.id)
    bySource.set(entry.source.id, {
      source: entry.source,
      entries: [...(group?.entries ?? []), entry],
    })
  }
  return [...bySource.values(), ...(loose.length === 0 ? [] : [{ source: null, entries: loose }])]
}

/** A fire in the device's own words: the part that fired and what it did. */
export interface FireDescription {
  readonly source: string | null
  readonly label: string
}

/**
 * Names a fire from the vocabulary: the entry of that token and source gives
 * the label, the source gives the button. A token the device does not declare
 * keeps its verbatim name. A fire that names no source falls back to the
 * numeric `data.channel` older providers sent.
 */
export function describeFire(
  fire: EventFireLike | null | undefined,
  vocabulary: readonly EventVocabularyEntry[],
): FireDescription | null {
  if (!fire) return null
  const entry =
    findVocabularyEntry(vocabulary, fire.eventType, fire.sourceId) ??
    findVocabularyEntry(vocabulary, fire.eventType)
  const label = entry?.label ?? fire.eventType
  if (fire.sourceId !== undefined) {
    const source = vocabulary.find((e) => e.source?.id === fire.sourceId)?.source
    return { source: source?.label ?? null, label }
  }
  const channel = channelIndexOf(fire.data)
  return {
    source:
      channel === null ? null : i18n.t('hero.eventEmitterHero.button', { value1: String(channel) }),
    label,
  }
}
