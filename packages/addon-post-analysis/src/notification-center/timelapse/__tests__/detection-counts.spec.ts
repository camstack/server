/**
 * What the window CONTAINED, counted per class.
 *
 * The operator's ask: the timelapse notification should say how many people,
 * vehicles and animals the night held, for the classes he selects. The counts
 * come from the tracks the render already fetched for its dense-range plan —
 * this module is the pure aggregation over that same array, so a count can
 * never disagree with the ranges the video was cut from.
 */

import { describe, expect, it } from 'vitest'
import { NcTextCatalog } from '../../text-catalog.js'
import type { TimelapseTrackInterval } from '../dense-ranges.js'
import {
  countDetections,
  type DetectionCounts,
  detectionSummary,
  detectionTemplateVars,
} from '../detection-counts.js'

function track(className: string | undefined, at = 1_000): TimelapseTrackInterval {
  return { firstSeen: at, lastSeen: at + 5_000, ...(className !== undefined ? { className } : {}) }
}

const NIGHT: readonly TimelapseTrackInterval[] = [
  track('person'),
  track('person'),
  track('vehicle'),
  track('person'),
  track('animal'),
  track('vehicle'),
]

describe('countDetections', () => {
  it('counts every class the window contained when no classes are selected', () => {
    const counts = countDetections({ tracks: NIGHT })
    expect(counts.total).toBe(6)
    expect(counts.byClass).toEqual({ person: 3, vehicle: 2, animal: 1 })
  })

  it('orders classes by count, so the summary leads with what mattered', () => {
    expect(countDetections({ tracks: NIGHT }).classes).toEqual(['person', 'vehicle', 'animal'])
  })

  it('breaks a count tie by NAME, so the same night always reads the same', () => {
    const counts = countDetections({ tracks: [track('vehicle'), track('animal')] })
    expect(counts.classes).toEqual(['animal', 'vehicle'])
  })

  it('reports only the selected classes — and the total follows the selection', () => {
    const counts = countDetections({ tracks: NIGHT, reportClasses: ['person'] })
    expect(counts.byClass).toEqual({ person: 3 })
    // A total that still said 6 would contradict the very line it prints.
    expect(counts.total).toBe(3)
  })

  it('treats an EMPTY selection as "every class", never as "none"', () => {
    // The wire cannot distinguish "he cleared the field" from "he never opened
    // it", and reporting nothing is the answer no operator wants.
    expect(countDetections({ tracks: NIGHT, reportClasses: [] }).total).toBe(6)
  })

  it('reports zero for a selected class this camera never emitted', () => {
    const counts = countDetections({ tracks: NIGHT, reportClasses: ['person', 'boat'] })
    expect(counts.byClass).toEqual({ person: 3, boat: 0 })
    expect(counts.total).toBe(3)
  })

  it('ignores a track with no class rather than inventing one', () => {
    // Legacy rows and synthetic sensor tracks exist; counting them as a class
    // called "undefined" would put that word in a notification.
    const counts = countDetections({ tracks: [track('person'), track(undefined)] })
    expect(counts.total).toBe(1)
    expect(counts.byClass).toEqual({ person: 1 })
  })

  it('is case-insensitive on both sides of the match', () => {
    const counts = countDetections({ tracks: [track('Person')], reportClasses: ['PERSON'] })
    expect(counts.byClass).toEqual({ person: 1 })
  })

  it('answers an empty, zero result for a night with no tracks', () => {
    const counts = countDetections({ tracks: [] })
    expect(counts.total).toBe(0)
    expect(counts.classes).toEqual([])
  })
})

describe('detectionSummary', () => {
  const italian = new NcTextCatalog({ language: 'it' })
  const english = new NcTextCatalog()

  function summaryOf(
    tracks: readonly TimelapseTrackInterval[],
    texts: NcTextCatalog = italian,
  ): string {
    return detectionSummary(texts, countDetections({ tracks }))
  }

  it('reads as prose, in the hub language, with the language own conjunction', () => {
    // The list join is `Intl.ListFormat`, not `', '` — an Italian list ends in
    // "e", an English one in "and", and neither is the other's punctuation.
    expect(summaryOf(NIGHT)).toBe('3 persone, 2 veicoli e 1 animale')
    expect(summaryOf(NIGHT, english)).toBe('3 people, 2 vehicles, and 1 animal')
  })

  it('uses the SINGULAR for one, in both languages', () => {
    expect(summaryOf([track('person')])).toBe('1 persona')
    expect(summaryOf([track('vehicle')])).toBe('1 veicolo')
    expect(summaryOf([track('person')], english)).toBe('1 person')
  })

  it('falls back to the raw class name for a class no locale names', () => {
    // A custom model's class must not silently vanish from the count.
    expect(summaryOf([track('drone'), track('drone')])).toBe('2 drone')
    expect(summaryOf([track('drone'), track('drone')], english)).toBe('2 drone')
  })

  it('is empty for a night with nothing in it — the caller omits the line', () => {
    expect(summaryOf([])).toBe('')
  })
})

describe('detectionTemplateVars', () => {
  const vars = detectionTemplateVars(
    new NcTextCatalog({ language: 'it' }),
    countDetections({ tracks: NIGHT }),
  )

  it('exposes the total and the summary', () => {
    expect(vars['detections']).toBe('6')
    expect(vars['detectionSummary']).toBe('3 persone, 2 veicoli e 1 animale')
  })

  it('exposes one count_<class> per reported class', () => {
    expect(vars['count_person']).toBe('3')
    expect(vars['count_vehicle']).toBe('2')
    expect(vars['count_animal']).toBe('1')
  })

  it('emits keys the template engine can actually match', () => {
    // `renderTemplate` matches `\\w+` only: a key with a hyphen or a space would
    // be a placeholder that silently renders as itself, forever.
    for (const key of Object.keys(vars)) expect(key).toMatch(/^\w+$/)
  })

  it('answers zero — not an absent key — for a class selected but never seen', () => {
    const counts: DetectionCounts = countDetections({
      tracks: NIGHT,
      reportClasses: ['person', 'boat'],
    })
    expect(detectionTemplateVars(new NcTextCatalog(), counts)['count_boat']).toBe('0')
  })
})
