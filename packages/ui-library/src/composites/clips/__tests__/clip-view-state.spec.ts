/**
 * The four on-screen states of the clips browser, decided in ONE pure place.
 *
 * They are the point of the feature (D549 § 7b) and each of them used to
 * render as "no clips":
 *
 *  1. **loading** — never drawn as empty.
 *  2. **empty with a cause** — a band with no rows names the BAND and which
 *     sources answered for it.
 *  3. **degraded per source** — one source unreachable while another answers
 *     shows BOTH: the rows that arrived, and a line saying who could not
 *     answer and why, verbatim. That is a hub child today.
 *  4. **silent with a reason** — `sleeping` / `no-storage` / `index-empty`,
 *     each in its own words.
 *
 * Pinned without a React tree so "a list is never drawn while a query is still
 * pending" is a fact about the decision, not about a render order.
 */
import { describe, expect, it } from 'vitest'
import type { Clip, ClipSource } from '@camstack/types'
import type { ClipBandPlan } from '../clip-band.js'
import { resolveClipsView } from '../clip-view-state.js'

const BAND = {
  fromMs: new Date(2026, 8, 20, 14, 0, 0, 0).getTime(),
  toMs: new Date(2026, 8, 20, 18, 0, 0, 0).getTime(),
}
/** The plan a band inside one local day produces — the ordinary case. */
const ASKABLE: ClipBandPlan = { kind: 'askable', band: BAND, localDays: 1 }

function clip(id: string, source: string): Clip {
  return {
    id,
    source,
    kind: 'native',
    timeRange: { startMs: 1_758_300_000_000, endMs: 1_758_300_100_000 },
  }
}

function src(
  source: string,
  state: ClipSource['availability']['state'],
  reason?: string,
): ClipSource {
  return {
    source,
    label: source,
    availability: { state, ...(reason === undefined ? {} : { reason }) },
  }
}

describe('resolveClipsView — loading', () => {
  it('is loading while the clips query has not answered, even with sources in hand', () => {
    const view = resolveClipsView({
      plan: ASKABLE,
      provider: 'recorder',
      clipsStatus: 'pending',
      clips: [],
      sourcesStatus: 'success',
      sources: [src('analytics', 'ok')],
    })
    expect(view.kind).toBe('loading')
  })

  it('is loading while the SOURCES query has not answered — an empty day with no source list has no cause to give', () => {
    const view = resolveClipsView({
      plan: ASKABLE,
      provider: 'recorder',
      clipsStatus: 'success',
      clips: [],
      sourcesStatus: 'pending',
      sources: [],
    })
    expect(view.kind).toBe('loading')
  })
})

describe('resolveClipsView — empty with a cause', () => {
  it('names the band and the sources that DID answer', () => {
    const view = resolveClipsView({
      plan: ASKABLE,
      provider: 'recorder',
      clipsStatus: 'success',
      clips: [],
      sourcesStatus: 'success',
      sources: [src('analytics', 'ok'), src('native:reolink:onboard', 'no-storage')],
    })
    expect(view.kind).toBe('empty')
    if (view.kind !== 'empty') return
    expect(view.band).toEqual(BAND)
    expect(view.answered.map((n) => n.source)).toEqual(['analytics'])
    expect(view.silent.map((n) => n.source)).toEqual(['native:reolink:onboard'])
  })

  it('an empty band where NOTHING could answer is not the same state as a quiet one', () => {
    const view = resolveClipsView({
      plan: ASKABLE,
      provider: 'recorder',
      clipsStatus: 'success',
      clips: [],
      sourcesStatus: 'success',
      sources: [src('native:reolink:onboard', 'no-storage')],
    })
    expect(view.kind).toBe('empty')
    if (view.kind !== 'empty') return
    expect(view.answered).toHaveLength(0)
    expect(view.nobodyAnswered).toBe(true)
  })
})

describe('resolveClipsView — degraded per source', () => {
  it('shows the rows that arrived AND the source that could not answer, verbatim', () => {
    const view = resolveClipsView({
      plan: ASKABLE,
      provider: 'recorder',
      clipsStatus: 'success',
      clips: [clip('native:reolink:onboard:1', 'native:reolink:onboard')],
      sourcesStatus: 'success',
      sources: [
        src('native:reolink:onboard', 'ok'),
        src('native:reolink:hub', 'unreachable', 'findEventLog parser not landed'),
      ],
    })
    expect(view.kind).toBe('listed')
    if (view.kind !== 'listed') return
    expect(view.clips).toHaveLength(1)
    expect(view.silent).toHaveLength(1)
    expect(view.silent[0]?.detail).toBe('findEventLog parser not landed')
  })
})

describe('resolveClipsView — a failed read is not an empty one', () => {
  it('says the read failed rather than claiming the band is empty', () => {
    const view = resolveClipsView({
      plan: ASKABLE,
      provider: 'recorder',
      clipsStatus: 'error',
      clips: [],
      sourcesStatus: 'success',
      sources: [src('analytics', 'ok')],
      clipsError: 'PRECONDITION_FAILED',
    })
    expect(view.kind).toBe('failed')
    if (view.kind !== 'failed') return
    expect(view.message).toBe('PRECONDITION_FAILED')
  })
})

describe('resolveClipsView — every source the camera HAS is described', () => {
  it('describes both sources even when only one of them contributed rows', () => {
    // `listClips` is asked of ONE provider, so the rows on screen come from
    // one of these; the OTHER is still the camera's and is still described,
    // with its availability. The client-side `selected` filter this case used
    // to pin is gone with the fan-out it assumed (D557, amended).
    const view = resolveClipsView({
      plan: ASKABLE,
      provider: 'recorder',
      clipsStatus: 'success',
      clips: [clip('a', 'analytics')],
      sourcesStatus: 'success',
      sources: [src('analytics', 'ok'), src('native:reolink:onboard', 'ok')],
    })
    expect(view.kind).toBe('listed')
    if (view.kind !== 'listed') return
    expect(view.clips.map((c) => c.id)).toEqual(['a'])
    expect(view.answered).toHaveLength(2)
  })
})

describe('resolveClipsView — a band too wide to ask is refused BEFORE loading', () => {
  // The query is disabled when the plan refuses, so its status stays
  // `pending` forever. If `loading` won this ordering the surface would spin
  // a skeleton for a request nobody ever sent — the honest-looking version of
  // a silent drop.
  const WIDE = {
    fromMs: new Date(2026, 8, 14).getTime(),
    toMs: new Date(2026, 8, 21).getTime(),
  }
  const REFUSED: ClipBandPlan = {
    kind: 'too-wide',
    band: WIDE,
    localDays: 7,
    maxLocalDays: 2,
  }

  it('refuses rather than loading, and carries both numbers and the band', () => {
    const view = resolveClipsView({
      plan: REFUSED,
      provider: 'recorder',
      clipsStatus: 'pending',
      clips: [],
      sourcesStatus: 'success',
      sources: [src('analytics', 'ok')],
    })
    expect(view.kind).toBe('refused')
    if (view.kind !== 'refused') return
    expect(view.band).toEqual(WIDE)
    expect(view.localDays).toBe(7)
    expect(view.maxLocalDays).toBe(2)
  })

  it('refuses even when a STALE list from a narrower band is still in hand', () => {
    // React Query keeps the previous answer while a new input is disabled.
    // Rendering it under the wider band would be the partial answer shown as
    // if it were the range.
    const view = resolveClipsView({
      plan: REFUSED,
      provider: 'recorder',
      clipsStatus: 'success',
      clips: [clip('a', 'analytics')],
      sourcesStatus: 'success',
      sources: [src('analytics', 'ok')],
    })
    expect(view.kind).toBe('refused')
  })
})
