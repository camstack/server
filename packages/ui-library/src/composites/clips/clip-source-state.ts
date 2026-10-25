/**
 * What a clip SOURCE is saying right now, in words an operator can act on.
 *
 * `ClipSourceAvailability.state` has five values and four of them used to
 * render identically — as an empty list, which reads "this camera has no
 * recordings". That is the defect the whole external-videoclips line exists to
 * fix ([D549](../../../../../docs/decisions/adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
 * § 7b), measured on real cameras:
 *
 *  - 640 has **no SD card** (`HddInfo mount 0`). It is not quiet; it stores
 *    nothing.
 *  - 618's own calendar marks 6–20 September present and its own index then
 *    lists **zero files** for those days, with 177 GB free. That is a defect
 *    ON THE CAMERA, and the only honest thing to say is which days were asked
 *    for and came back empty.
 *  - A standalone battery camera is **asleep**; a read would be a wake, so
 *    what you are looking at is a CACHE with an age.
 *  - `native:reolink:hub` is **unreachable** today because the library parser
 *    for the events view has not landed — so the degraded case is not
 *    hypothetical, it is what every hub child looks like right now.
 *
 * This module is the one place those five become words, kept pure so the
 * distinctness can be pinned without a React tree (a rendering test that only
 * checked colour would pass with all five saying "no clips").
 *
 * The provider's own `reason` travels VERBATIM. It is the camera's refusal in
 * the camera's words; re-writing it here would lose the only detail that tells
 * an operator whether to look at the card, the network or the firmware.
 */
import type { ClipSource } from '@camstack/types'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text.js'

/** How loudly a source's state should read. Never the whole message. */
export type ClipSourceTone = 'ok' | 'warn' | 'error'

/** A source's state, rendered. */
export interface ClipSourceNotice {
  /** The source's own id (`analytics`, `native:reolink:hub`, …). */
  readonly source: string
  /** The operator-facing source name the provider gave it. */
  readonly label: string
  /** One line, unique per state. Never "no clips". */
  readonly headline: string
  /** The provider's reason, verbatim, or null when it gave none. */
  readonly detail: string | null
  readonly tone: ClipSourceTone
  /**
   * Did this source contribute rows to the list on screen?
   *
   * `sleeping` answers TRUE: a sleeping camera serves its persisted catalog
   * (D549 decision 4), so its clips ARE in the list — only their age is
   * different. The other three contribute nothing, and an empty day must name
   * them as the reason rather than claim the camera was quiet.
   */
  readonly answered: boolean
}

interface StateCopy {
  readonly headlineKey: string
  readonly headlineFallback: string
  readonly tone: ClipSourceTone
  readonly answered: boolean
}

const STATE_COPY: Readonly<Record<ClipSource['availability']['state'], StateCopy>> = {
  ok: {
    headlineKey: 'uiLibrary.clipSource.state.ok',
    headlineFallback: 'Answering',
    tone: 'ok',
    answered: true,
  },
  sleeping: {
    headlineKey: 'uiLibrary.clipSource.state.sleeping',
    headlineFallback: 'Asleep — showing the catalog read while it was awake',
    tone: 'warn',
    answered: true,
  },
  unreachable: {
    headlineKey: 'uiLibrary.clipSource.state.unreachable',
    headlineFallback: 'Could not be reached — its clips are missing from this list',
    tone: 'error',
    answered: false,
  },
  'no-storage': {
    headlineKey: 'uiLibrary.clipSource.state.no_storage',
    headlineFallback: 'No storage card — this camera keeps nothing of its own',
    tone: 'warn',
    answered: false,
  },
  'index-empty': {
    headlineKey: 'uiLibrary.clipSource.state.index_empty',
    headlineFallback: "The camera's calendar marks these days, and its own index lists nothing",
    tone: 'warn',
    answered: false,
  },
}

/** Turn one source row into the line the picker and the list show. */
export function describeSource(source: ClipSource, t: UiTextFn = defaultUiText): ClipSourceNotice {
  const copy = STATE_COPY[source.availability.state]
  return {
    source: source.source,
    label: source.label,
    headline: t(copy.headlineKey, copy.headlineFallback),
    detail: source.availability.reason ?? null,
    tone: copy.tone,
    answered: copy.answered,
  }
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * How old a source's catalog is, or null when it did not say.
 *
 * Null is NOT "now". A source that omits `catalogAsOf` was read live and has
 * no age to show; inventing "just now" for a source that never told us would
 * be the same lie as drawing a cached list as current (D549 decision 13).
 */
export function formatCatalogAge(
  catalogAsOf: number | undefined,
  now: number,
  t: UiTextFn = defaultUiText,
): string | null {
  if (catalogAsOf === undefined) return null
  const age = Math.max(0, now - catalogAsOf)
  if (age < MINUTE_MS) return t('uiLibrary.clipSource.age.underMinute', 'under a minute ago')
  if (age < HOUR_MS)
    return t('uiLibrary.clipSource.age.minutes', '{{count}} min ago', {
      count: Math.floor(age / MINUTE_MS),
    })
  if (age < DAY_MS)
    return t('uiLibrary.clipSource.age.hours', '{{count}} h ago', {
      count: Math.floor(age / HOUR_MS),
    })
  return t('uiLibrary.clipSource.age.days', '{{count}} d ago', { count: Math.floor(age / DAY_MS) })
}
