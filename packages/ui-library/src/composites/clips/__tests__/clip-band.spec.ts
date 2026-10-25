/**
 * The BAND — what the clip list is asked for once the day picker is gone.
 *
 * The clips section used to own a day. It now follows a period selected on the
 * recording timebar, and a period is not a day: it can be four minutes or it
 * can straddle midnight. Two things have to be true of it and neither is
 * visible until it is wrong:
 *
 *  - **The cost is counted in LOCAL days, because the camera's own search is
 *    clamped to one.** Measured 2026-09-20 on hub child 3628: a two-day ask
 *    answered 39 windows all dated the START day, silently. So the provider
 *    loops local days, a Reolink day listing is 4.3–6.0 s on 592, and the
 *    honest unit of "how much does this band cost" is how many local days it
 *    touches — never its width in ms, which says nothing about how many
 *    listings it becomes.
 *  - **A band wider than the bound is REFUSED by name, never asked and
 *    partially shown.** Returning the days that answered as if they were the
 *    range is the same defect class as an empty list reading as "no clips".
 */
import { describe, expect, it } from 'vitest'

import {
  MAX_BAND_LOCAL_DAYS,
  bandForSelection,
  formatBandLabel,
  localDaysInBand,
  planClipBand,
} from '../clip-band.js'

/** Local-midnight instant of a local calendar date. */
function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('localDaysInBand — the unit the camera clamps to', () => {
  it('counts one for a band inside a single local day', () => {
    expect(localDaysInBand({ fromMs: local(2026, 9, 20, 14), toMs: local(2026, 9, 20, 18) })).toBe(
      1,
    )
  })

  it('counts one for a whole local day, half-open at the next midnight', () => {
    expect(localDaysInBand({ fromMs: local(2026, 9, 20), toMs: local(2026, 9, 21) })).toBe(1)
  })

  it('counts two for a band that straddles local midnight', () => {
    expect(localDaysInBand({ fromMs: local(2026, 9, 20, 22), toMs: local(2026, 9, 21, 2) })).toBe(2)
  })

  it('walks calendar days, not 86 400 000 ms — a DST week is still seven', () => {
    // Europe/Rome springs forward on 2026-03-29; adding 7 × 86 400 000 ms to
    // local midnight on the 25th lands at 23:00 on the 31st, not midnight.
    expect(localDaysInBand({ fromMs: local(2026, 3, 25), toMs: local(2026, 4, 1) })).toBe(7)
  })

  it('a zero-width band is one day, not zero', () => {
    const at = local(2026, 9, 20, 9, 30)
    expect(localDaysInBand({ fromMs: at, toMs: at })).toBe(1)
  })
})

describe('planClipBand — a band is askable, or refused by name', () => {
  it('a band inside one local day is askable and says how many days it is', () => {
    const band = { fromMs: local(2026, 9, 20, 14), toMs: local(2026, 9, 20, 18) }
    expect(planClipBand(band)).toEqual({ kind: 'askable', band, localDays: 1 })
  })

  it('a band at the bound is still askable', () => {
    const band = {
      fromMs: local(2026, 9, 20, 22),
      toMs: local(2026, 9, 20 + MAX_BAND_LOCAL_DAYS - 1, 2),
    }
    expect(planClipBand(band).kind).toBe('askable')
  })

  it('a band one day past the bound is refused, carrying both numbers', () => {
    const band = {
      fromMs: local(2026, 9, 20, 22),
      toMs: local(2026, 9, 20 + MAX_BAND_LOCAL_DAYS, 2),
    }
    const plan = planClipBand(band)
    expect(plan.kind).toBe('too-wide')
    if (plan.kind !== 'too-wide') throw new Error('expected a refusal')
    expect(plan.localDays).toBe(MAX_BAND_LOCAL_DAYS + 1)
    expect(plan.maxLocalDays).toBe(MAX_BAND_LOCAL_DAYS)
  })

  it('a week-wide band is refused, never trimmed to the days it could afford', () => {
    const plan = planClipBand({ fromMs: local(2026, 9, 14), toMs: local(2026, 9, 21) })
    expect(plan.kind).toBe('too-wide')
    // The band it reports is the one that was ASKED for, unmodified: a plan
    // that narrowed the band would be the silent partial answer this refusal
    // exists to prevent.
    if (plan.kind !== 'too-wide') throw new Error('expected a refusal')
    expect(plan.band).toEqual({ fromMs: local(2026, 9, 14), toMs: local(2026, 9, 21) })
  })
})

describe('bandForSelection — the bucket narrows, its absence is the visible window', () => {
  const view = { fromMs: local(2026, 9, 20), toMs: local(2026, 9, 20, 12) }

  it('is the whole visible window when no bucket is selected', () => {
    expect(bandForSelection(view, null)).toEqual(view)
  })

  it('is the selected bucket when there is one', () => {
    const bucket = { startMs: local(2026, 9, 20, 3), endMs: local(2026, 9, 20, 3, 15) }
    expect(bandForSelection(view, bucket)).toEqual({
      fromMs: bucket.startMs,
      toMs: bucket.endMs,
    })
  })

  it('clamps a bucket that runs past the visible window', () => {
    const bucket = { startMs: local(2026, 9, 20, 11, 50), endMs: local(2026, 9, 20, 12, 30) }
    expect(bandForSelection(view, bucket)).toEqual({
      fromMs: bucket.startMs,
      toMs: view.toMs,
    })
  })
})

describe('formatBandLabel — every state names the band it is about', () => {
  it('names the day once when the band stays inside it', () => {
    const label = formatBandLabel({
      fromMs: local(2026, 9, 20, 14),
      toMs: local(2026, 9, 20, 18),
    })
    expect(label).toContain('Sep')
    expect(label).toContain('20')
    // One day, named once — not repeated on both sides of the dash.
    expect(label.match(/Sep/g)?.length).toBe(1)
  })

  it('names both days when the band straddles midnight', () => {
    const label = formatBandLabel({
      fromMs: local(2026, 9, 20, 22),
      toMs: local(2026, 9, 21, 2),
    })
    expect(label.match(/Sep/g)?.length).toBe(2)
  })
})
