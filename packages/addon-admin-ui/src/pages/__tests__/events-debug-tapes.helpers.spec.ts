/**
 * The Tapes section's narrowing layer and its two selection rules (spec
 * §4.5): "same subject" CHAINS the selection (a–b, b–c: n−1 writes, one
 * identity), "different subjects" is PAIRWISE (every pair is a statement).
 * A reply that is not the promised shape yields `null`, never `undefined`
 * in a badge.
 *
 * Disarm: make `sameSubjectPairs` return `differentSubjectPairs(selection)` —
 * "chains a same-subject selection" must fail.
 *
 * Fix round 1 (task-24-review.md): `GtMarks.truncated` must be surfaced, never
 * silently dropped (D315/D393 — an unread mark is not the same as an absent
 * one); disarm: make `truncatedMarksNotice` always return `null` — "says so
 * only when truncated" must fail. And the promotion camera picker must offer
 * every camera with stored segments regardless of its current switch state.
 */
import { describe, expect, it } from 'vitest'
import {
  differentSubjectPairs,
  laneMarks,
  parseGtMarks,
  parseLocalDateTime,
  parsePromote,
  parseTapeList,
  parseTapeStatus,
  promotableCameras,
  promoteRefusalText,
  sameSubjectPairs,
  statusLabel,
  tapeExportUrl,
  truncatedMarksNotice,
} from '../events-debug-tapes.helpers'

describe('selection rules', () => {
  it('chains a same-subject selection', () => {
    expect(sameSubjectPairs(['a', 'b', 'c'])).toEqual([
      { trackId: 'a', otherTrackId: 'b' },
      { trackId: 'b', otherTrackId: 'c' },
    ])
  })

  it('pairs every two tracks for different subjects', () => {
    expect(differentSubjectPairs(['a', 'b', 'c'])).toEqual([
      { trackId: 'a', otherTrackId: 'b' },
      { trackId: 'a', otherTrackId: 'c' },
      { trackId: 'b', otherTrackId: 'c' },
    ])
  })

  it('needs two tracks for either', () => {
    expect(sameSubjectPairs(['a'])).toEqual([])
    expect(differentSubjectPairs(['a'])).toEqual([])
  })
})

describe('narrowing', () => {
  it('reads a status reply and says off as off', () => {
    const rows = parseTapeStatus({
      cameras: [
        {
          deviceId: 101,
          state: 'recording',
          segmentOriginMs: 1,
          framesPerMin: 420,
          gapsSinceArmed: 0,
          segmentsHeld: 12,
          bytesLastHour: 2_400_000,
          bytesHeld: 20_000_000,
        },
        {
          deviceId: 104,
          state: 'off',
          gapsSinceArmed: 0,
          segmentsHeld: 0,
          bytesLastHour: 0,
          bytesHeld: 0,
        },
        {
          deviceId: 102,
          state: 'refused',
          reason: 'artifacts-elsewhere',
          gapsSinceArmed: 0,
          segmentsHeld: 0,
          bytesLastHour: 0,
          bytesHeld: 0,
        },
      ],
    })
    expect(rows?.map(statusLabel)).toEqual(['Recording', 'Off', 'Refused: artifacts-elsewhere'])
  })

  it('refuses a malformed reply', () => {
    expect(parseTapeStatus({ cameras: [{ deviceId: '101' }] })).toBeNull()
    expect(parseTapeList({ tapes: 'nope' })).toBeNull()
    expect(parsePromote({ ok: 'yes' })).toBeNull()
  })

  it('reads a promotion refusal as a sentence', () => {
    const r = parsePromote({ ok: false, reason: 'window-too-long', detail: '45 min' })
    expect(r).toEqual({ ok: false, reason: 'window-too-long', detail: '45 min' })
    expect(promoteRefusalText('window-too-long', '45 min')).toContain('30 minutes')
    expect(promoteRefusalText('something-new', 'x')).toContain('something-new')
  })
})

describe('lanes and inputs', () => {
  it('lists a lane’s marks', () => {
    const marks = {
      relations: [
        {
          leftTrackId: 'a',
          rightTrackId: 'b',
          relation: 'same-subject' as const,
          presence: 'continuous' as const,
        },
      ],
      purities: [{ sourceTrackId: 'a', purity: 'mixed' as const, switchAtMs: 5 }],
      truncated: false,
    }
    expect(laneMarks('a', marks)).toEqual(['same as b (continuous)', 'mixed at switch'])
    expect(laneMarks('b', marks)).toEqual(['same as a (continuous)'])
  })

  it('parses a datetime-local value and refuses garbage', () => {
    expect(parseLocalDateTime('2026-09-29T18:30')).toBe(new Date(2026, 8, 29, 18, 30).getTime())
    expect(parseLocalDateTime('')).toBeNull()
  })

  it('builds the export URL on the admin plane', () => {
    expect(tapeExportUrl('promo-0001')).toMatch(
      /\/addon\/pipeline-analytics\/tape-export\?tapeId=promo-0001$/,
    )
  })
})

describe('truncated ground truth (fix round 1)', () => {
  it('parses the truncated flag off a gt.list reply', () => {
    const marks = parseGtMarks({ relations: [], purities: [], truncated: true })
    expect(marks?.truncated).toBe(true)
    expect(parseGtMarks({ relations: [], purities: [] })).toBeNull()
  })

  it('says so only when truncated', () => {
    expect(truncatedMarksNotice({ relations: [], purities: [], truncated: false })).toBeNull()
    const notice = truncatedMarksNotice({
      relations: [
        { leftTrackId: 'a', rightTrackId: 'b', relation: 'same-subject', presence: null },
      ],
      purities: [],
      truncated: true,
    })
    expect(notice).not.toBeNull()
    expect(notice).toContain('1')
    expect(notice).toMatch(/more exist/i)
  })
})

describe('promotable cameras (fix round 1)', () => {
  it('offers every camera with stored segments, whatever its switch state', () => {
    const rows = parseTapeStatus({
      cameras: [
        {
          deviceId: 1,
          state: 'off',
          gapsSinceArmed: 0,
          segmentsHeld: 12,
          bytesLastHour: 0,
          bytesHeld: 0,
        },
        {
          deviceId: 2,
          state: 'recording',
          gapsSinceArmed: 0,
          segmentsHeld: 0,
          bytesLastHour: 0,
          bytesHeld: 0,
        },
        {
          deviceId: 3,
          state: 'refused',
          reason: 'artifacts-elsewhere',
          gapsSinceArmed: 0,
          segmentsHeld: null,
          bytesLastHour: null,
          bytesHeld: null,
        },
      ],
    })
    expect(rows).not.toBeNull()
    expect(promotableCameras(rows ?? [])).toEqual([
      { deviceId: 1, segmentsUnknown: false },
      { deviceId: 3, segmentsUnknown: true },
    ])
  })
})
