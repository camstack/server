/**
 * The BAND — the period the clip list is asked for, and what it costs.
 *
 * The clips section used to own a day picker. It now follows a period selected
 * on the recording timebar (D564), so the window it asks `listClips` for is no
 * longer a calendar day: it is whatever the operator has zoomed, panned or
 * bucket-clicked down to. Everything in this module exists because a period is
 * a different KIND of thing from a day in exactly two ways.
 *
 * ## The cost is counted in LOCAL days, because the camera's own search is
 *
 * A Reolink search is clamped to one camera-local day per call — measured
 * 2026-09-20 on hub child 3628: a two-day ask answered 39 windows all dated
 * the START day, silently, and `nodelink-js` now clamps and trace-logs it. The
 * provider therefore LOOPS local days
 * (`reolink-videoclips-provider.ts`), and a day listing is 4.3–6.0 s on 592
 * (209 clips in 6.0 s; 546 in 4.3 s). A band's width in ms says nothing about
 * what it costs; the number of local days it touches says everything. That is
 * the unit here, and the walk goes through `Date`'s own day arithmetic so a
 * DST week is seven days and not 6.96 (`clip-day-window.ts`).
 *
 * ## A band wider than the bound is REFUSED, never asked and partly shown
 *
 * The recording timebar cannot itself express more than a local day — its
 * widest zoom level is 24 h and `zoomWindowAnchoredRight` clamps to the day's
 * bounds — so {@link MAX_BAND_LOCAL_DAYS} is set at the one place a reachable
 * band can still exceed one day: a window that straddles local midnight. The
 * bound is enforced HERE rather than trusted to the control, because a control
 * that later grows a wider zoom must not silently hand the list a
 * recording-sized ask. Above it the query is not fired at all and the surface
 * says which band it refused and why. Trimming the band to the days it could
 * afford and rendering those is the defect this refusal exists to prevent — it
 * is an empty list reading as "no clips" with extra steps.
 */
import type { DayWindow } from '../cap-settings/recording-timeline-model.js'
import { formatDayLabel, shiftDay, toDayId } from './clip-day-window.js'

/** The half-open instant range `listClips` is asked for. */
export interface ClipBand {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * How many local days a band may touch and still be asked for.
 *
 * Two, which is every band the timebar can produce: its view window never
 * spans more than one calendar day, and the only way to reach a second is to
 * sit across local midnight. A third is not a gesture this control has, so it
 * is a bug or a future widening — either way the list refuses rather than
 * guesses.
 */
export const MAX_BAND_LOCAL_DAYS = 2

/** Defensive ceiling on the day walk so an inverted band can never loop. */
const MAX_WALK_DAYS = 366

/** What the surface may do with a band, decided once. */
export type ClipBandPlan =
  | { readonly kind: 'askable'; readonly band: ClipBand; readonly localDays: number }
  | {
      readonly kind: 'too-wide'
      readonly band: ClipBand
      readonly localDays: number
      readonly maxLocalDays: number
    }

/**
 * How many LOCAL calendar days the half-open band touches.
 *
 * The end instant is exclusive, so a band that ends exactly at the next local
 * midnight is one day, not two — otherwise every whole-day band would report
 * double what it costs.
 */
export function localDaysInBand(band: ClipBand): number {
  const lastInstant = Math.max(band.fromMs, band.toMs - 1)
  const endDay = toDayId(new Date(lastInstant))
  let cursor = toDayId(new Date(band.fromMs))
  let days = 0
  // `YYYY-MM-DD` orders lexicographically, so the walk terminates on an
  // inverted band with 0 rather than running away.
  while (cursor <= endDay && days < MAX_WALK_DAYS) {
    days += 1
    cursor = shiftDay(cursor, 1)
  }
  return days
}

/** Whether this band may be asked for, and what it costs, in one value. */
export function planClipBand(band: ClipBand): ClipBandPlan {
  const localDays = localDaysInBand(band)
  if (localDays > MAX_BAND_LOCAL_DAYS) {
    // The band travels UNMODIFIED into the refusal: the operator has to be
    // told what was refused, and a narrowed band would be the partial answer
    // this branch exists to avoid.
    return { kind: 'too-wide', band, localDays, maxLocalDays: MAX_BAND_LOCAL_DAYS }
  }
  return { kind: 'askable', band, localDays }
}

/** A density bucket's own window, as `EventHeatmap` hands it back. */
export interface ClipBandBucket {
  readonly startMs: number
  readonly endMs: number
}

/**
 * The band for the current selection: the picked bucket, or — when nothing is
 * picked — the whole visible window.
 *
 * "Nothing picked means everything visible" is safe here and only here,
 * because the visible window is itself bounded by the timebar. It is never
 * "everything the camera holds" (D382's unstated ask).
 */
export function bandForSelection(view: DayWindow, bucket: ClipBandBucket | null): ClipBand {
  if (bucket === null) return { fromMs: view.fromMs, toMs: view.toMs }
  return {
    fromMs: Math.max(bucket.startMs, view.fromMs),
    toMs: Math.min(bucket.endMs, view.toMs),
  }
}

function formatTime(instant: number): string {
  return new Date(instant).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The band, spelled out.
 *
 * Every state renders it — an empty list has to say WHICH period it is empty
 * for, the same rule the day label carried before the band replaced it.
 */
export function formatBandLabel(band: ClipBand): string {
  const fromDay = toDayId(new Date(band.fromMs))
  const toDay = toDayId(new Date(Math.max(band.fromMs, band.toMs - 1)))
  if (fromDay === toDay) {
    return `${formatDayLabel(fromDay)}, ${formatTime(band.fromMs)} – ${formatTime(band.toMs)}`
  }
  return `${formatDayLabel(fromDay)} ${formatTime(band.fromMs)} – ${formatDayLabel(toDay)} ${formatTime(band.toMs)}`
}
