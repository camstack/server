/**
 * The bucket a "matched NO rule" / "notifications muted" report is rate-limited
 * in.
 *
 * 2026-09-07 18:29:18-24, camera 101. A person and a cat crossed the frame
 * together. The person's object-event was evaluated and rejected
 * (`Animale su Aiuola:classes`) and printed its line. The animal's own
 * object-event, 6 s later, was evaluated too and rejected on `:zones` — and
 * printed NOTHING, because the report window is keyed on the DEVICE alone and
 * the person had just consumed it.
 *
 * The absence was then read as "the rule never evaluated the animal", and an
 * investigation went looking for a missing event that had in fact been stored,
 * dispatched and rejected on a condition nobody could see. One subject must
 * never be able to silence another's verdict on the same camera (D390).
 */
import { describe, expect, it } from 'vitest'

import { noMatchReportKey } from '../no-match-report-key.js'

describe('noMatchReportKey', () => {
  it('separates two classes on the SAME camera — the 101 person/animal miss', () => {
    const person = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['person'] })
    const animal = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['animal'] })
    expect(person).not.toBe(animal)
  })

  it('keeps the bound it exists for: the same class on the same camera is ONE bucket', () => {
    const a = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['person'] })
    const b = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['person'] })
    expect(a).toBe(b)
  })

  it('separates cameras', () => {
    const a = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['person'] })
    const b = noMatchReportKey({ deviceId: 102, kind: 'object-event', classNames: ['person'] })
    expect(a).not.toBe(b)
  })

  it('separates subject KINDS — a track-end verdict is not an object-event verdict', () => {
    const evt = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['animal'] })
    const end = noMatchReportKey({ deviceId: 101, kind: 'track-end', classNames: ['animal'] })
    expect(evt).not.toBe(end)
  })

  it('is order- and duplicate-insensitive: one multi-class subject is one bucket', () => {
    const a = noMatchReportKey({
      deviceId: 101,
      kind: 'track-end',
      classNames: ['person', 'animal'],
    })
    const b = noMatchReportKey({
      deviceId: 101,
      kind: 'track-end',
      classNames: ['animal', 'person', 'animal'],
    })
    expect(a).toBe(b)
  })

  it('a multi-class subject is NOT the same bucket as either class alone', () => {
    const both = noMatchReportKey({
      deviceId: 101,
      kind: 'track-end',
      classNames: ['person', 'animal'],
    })
    const one = noMatchReportKey({ deviceId: 101, kind: 'track-end', classNames: ['animal'] })
    expect(both).not.toBe(one)
  })

  it('a class-less subject gets its own bucket, not a collision with every other', () => {
    const none = noMatchReportKey({ deviceId: 101, kind: 'system-event', classNames: [] })
    const some = noMatchReportKey({ deviceId: 101, kind: 'system-event', classNames: ['person'] })
    expect(none).not.toBe(some)
    expect(none).toBe(noMatchReportKey({ deviceId: 101, kind: 'system-event', classNames: [] }))
  })

  it('is case-insensitive — the detector casing must not fork the bucket', () => {
    const lower = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['animal'] })
    const upper = noMatchReportKey({ deviceId: 101, kind: 'object-event', classNames: ['Animal'] })
    expect(lower).toBe(upper)
  })
})
