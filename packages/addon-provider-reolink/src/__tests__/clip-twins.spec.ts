/**
 * The sub file and the main file are the SAME recording under two names
 * (D549 14b): a search names one stream, the app runs both, and the two sets
 * are twins whose start seconds differ by 0–4 s (168 of 170 within 3 s on 592,
 * 20 September; main ≈ 33× the bytes). The catalog row is the SUB file with
 * its main twin matched BY START TIME, never by name — so changing quality
 * never re-searches the camera (D549 15).
 */
import { describe, expect, it } from 'vitest'
import {
  chooseClipTwin,
  pairTwins,
  TWIN_MATCH_TOLERANCE_MS,
  type TwinCandidate,
} from '../clips/clip-twins.js'

const t = (iso: string): Date => new Date(iso)

const sub = (name: string, start: string, bytes = 92_000) => ({
  fileName: name,
  startTime: t(start),
  endTime: t(start),
  sizeBytes: bytes,
})
const main = (name: string, start: string, bytes = 2_290_000) => ({
  fileName: name,
  startTime: t(start),
  endTime: t(start),
  sizeBytes: bytes,
})

describe('pairTwins', () => {
  it('matches a main twin whose start is 3 s later', () => {
    const pairs = pairTwins(
      [sub('RecS02_a', '2026-09-20T06:30:00Z')],
      [main('RecM02_a', '2026-09-20T06:30:03Z')],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.main?.fileName).toBe('RecM02_a')
    expect(pairs[0]?.sub.fileName).toBe('RecS02_a')
  })

  it('matches a main twin that starts EARLIER than the sub', () => {
    const pairs = pairTwins(
      [sub('RecS02_a', '2026-09-20T06:30:03Z')],
      [main('RecM02_a', '2026-09-20T06:30:00Z')],
    )
    expect(pairs[0]?.main?.fileName).toBe('RecM02_a')
  })

  it('leaves a sub file with NO main twin unpaired rather than borrowing one', () => {
    // A missing twin is never served silently as the other (D549 15).
    const pairs = pairTwins(
      [sub('RecS02_a', '2026-09-20T06:30:00Z')],
      [main('RecM02_b', '2026-09-20T09:00:00Z')],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.main).toBeUndefined()
  })

  it('refuses a candidate exactly past the tolerance', () => {
    const start = Date.parse('2026-09-20T06:30:00Z')
    const pairs = pairTwins(
      [{ fileName: 's', startTime: new Date(start), endTime: new Date(start) }],
      [
        {
          fileName: 'm',
          startTime: new Date(start + TWIN_MATCH_TOLERANCE_MS + 1),
          endTime: new Date(start + TWIN_MATCH_TOLERANCE_MS + 1),
        },
      ],
    )
    expect(pairs[0]?.main).toBeUndefined()
  })

  it('takes the CLOSEST main when two are inside the tolerance', () => {
    const pairs = pairTwins(
      [sub('RecS02_a', '2026-09-20T06:30:00Z')],
      [main('far', '2026-09-20T06:30:03Z'), main('near', '2026-09-20T06:30:01Z')],
    )
    expect(pairs[0]?.main?.fileName).toBe('near')
  })

  it('never hands one main file to two subs', () => {
    const pairs = pairTwins(
      [sub('s1', '2026-09-20T06:30:00Z'), sub('s2', '2026-09-20T06:30:01Z')],
      [main('m1', '2026-09-20T06:30:00Z')],
    )
    const claimed = pairs.filter((p) => p.main !== undefined)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.sub.fileName).toBe('s1')
  })

  it('drops a file the camera dated with nothing', () => {
    const pairs = pairTwins<TwinCandidate>(
      [{ fileName: 'nodate' }],
      [main('m', '2026-09-20T06:30:00Z')],
    )
    expect(pairs).toHaveLength(0)
  })

  it('answers the sub list verbatim when the main search returned nothing', () => {
    // Measured on 618 and on a hub child with a sparse day: the main search
    // can legitimately come back empty. That is a missing twin, not an error.
    const pairs = pairTwins([sub('s1', '2026-09-20T06:30:00Z')], [])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.main).toBeUndefined()
  })

  it('orders the pairs newest first', () => {
    const pairs = pairTwins(
      [sub('old', '2026-09-20T06:00:00Z'), sub('new', '2026-09-20T18:00:00Z')],
      [],
    )
    expect(pairs.map((p) => p.sub.fileName)).toEqual(['new', 'old'])
  })
})

describe('chooseClipTwin — the ONE mapping from a profile to a file (D599)', () => {
  const paired = { subFileName: 'RecS_0001', mainFileName: 'RecM_0001' }
  const lonely = { subFileName: 'RecS_0002' }

  it('`high` reaches for the main twin and reports what it reached', () => {
    expect(chooseClipTwin('high', paired)).toEqual({
      twin: 'main',
      fileName: 'RecM_0001',
      served: 'high',
      downgraded: false,
    })
  })

  it.each(['mid', 'low'] as const)('`%s` is the sub copy', (profile) => {
    expect(chooseClipTwin(profile, paired)).toEqual({
      twin: 'sub',
      fileName: 'RecS_0001',
      served: 'low',
      downgraded: false,
    })
  })

  it('an ABSENT profile is not `high`', () => {
    // All three call sites spelled this `profile === 'high'`, which is false
    // on undefined. A caller that stated no preference gets the cheap copy.
    expect(chooseClipTwin(undefined, paired)).toMatchObject({ twin: 'sub', downgraded: false })
  })

  it('`high` on a recording with no main twin serves the sub and SAYS SO', () => {
    // The pair this function exists to keep apart. Serving silently is the
    // 33x substitution D576 forbids; refusing made `high` look unsupported
    // rather than unavailable for this one recording. `served` plus
    // `downgraded` is neither.
    expect(chooseClipTwin('high', lonely)).toEqual({
      twin: 'sub',
      fileName: 'RecS_0002',
      served: 'low',
      downgraded: true,
    })
  })

  it('never claims `high` for a file it did not get from the main twin', () => {
    // The invariant behind the other cases: `served: 'high'` and `twin: 'sub'`
    // together would be the lie, whatever produced it.
    for (const profile of ['high', 'mid', 'low', undefined] as const) {
      for (const row of [paired, lonely, { subFileName: '' }]) {
        const chosen = chooseClipTwin(profile, row)
        expect(chosen.served === 'high').toBe(chosen.twin === 'main')
      }
    }
  })
})
