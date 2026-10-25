// @vitest-environment jsdom
/**
 * `<ClipsSection>` — the four states, ON SCREEN, after the rebuild.
 *
 * The section was rebuilt out of the library's own components (`EmptyState`,
 * `ErrorBox`, `DataTable`, `MultiSelectDropdown`, `Card`, `Badge`,
 * `Pagination`) because the operator rejected its bespoke chrome — *"La UI è
 * orribile, non segue la nostra UI affatto"* [The UI is horrible, it does not follow our UI at all]. What the chrome carries did NOT
 * change, and this file is the proof: every assertion below is on words an
 * operator would read, and each one names a real camera on this fleet.
 *
 * Queries are scoped to the `Clips` region or the `Clip sources` region on
 * purpose. A silent source says its piece in BOTH — once in the source table
 * (so the operator sees which of the camera's sources is in trouble) and once
 * beside the rows (so a degraded list is not read as a complete one) — and an
 * unscoped `getByText` would fail on that duplication rather than on the thing
 * under test.
 *
 * The pure decision is pinned in `clip-view-state.spec.ts`; this file pins
 * that each decision actually REACHES the operator, because "the four states
 * are distinguishable on screen" is the acceptance criterion of the whole
 * external-videoclips line (D549 § 7b) and a state that resolves correctly and
 * renders as the same grey box has met none of it.
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface QueryAnswer {
  readonly data?: unknown
  readonly status: 'pending' | 'error' | 'success'
  readonly error?: { readonly message: string }
}

let sourcesAnswer: QueryAnswer = { status: 'pending' }
let clipsAnswer: QueryAnswer = { status: 'pending' }
const listClipsInputs: unknown[] = []

vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'present',
}))

vi.mock('../../../generated/system-hooks', () => ({
  useVideoclipsListSources: () => sourcesAnswer,
  useVideoclipsListClips: (input: unknown) => {
    listClipsInputs.push(input)
    return clipsAnswer
  },
  usePipelineAnalyticsGetEventDensity: () => ({ status: 'success', data: [] }),
  useVideoclipsGetClipPlayback: () => ({ status: 'pending', data: undefined }),
}))

const { ClipsSection } = await import('../ClipsSection.js')

// Every row the dispatcher serves carries `addonId` — it STAMPS it from the
// registry (D554 decision 8 / D557), and the surface names that addon on every
// `listClips` call (D554 amended). A fixture without one is a row production cannot
// produce, and it would make this suite pass on a surface that asks nothing.
function source(id: string, label: string, state: string, reason?: string) {
  return {
    source: id,
    label,
    addonId: id === 'analytics' ? 'recorder' : 'provider-reolink',
    availability: { state, ...(reason ? { reason } : {}) },
  }
}

function clip(id: string, sourceId: string) {
  return {
    id,
    source: sourceId,
    kind: 'native',
    timeRange: {
      startMs: Date.parse('2026-09-20T10:00:00Z'),
      endMs: Date.parse('2026-09-20T10:01:00Z'),
    },
    thumbnailUnavailable: { reason: 'sleeping' },
  }
}

beforeEach(() => {
  sourcesAnswer = { status: 'pending' }
  clipsAnswer = { status: 'pending' }
  listClipsInputs.length = 0
})

describe('ClipsSection — loading', () => {
  it('says it is loading and never claims the day is empty', () => {
    render(<ClipsSection deviceId={107} />)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    expect(clips.getByRole('status').textContent ?? '').toMatch(/loading/i)
    expect(screen.queryByText(/no clips/i)).toBeNull()
  })
})

describe('ClipsSection — failed', () => {
  it('a read that FAILED says so and is not drawn as an empty day', () => {
    sourcesAnswer = { status: 'success', data: [source('analytics', 'CamStack', 'ok')] }
    clipsAnswer = { status: 'error', error: { message: 'PRECONDITION_FAILED' } }
    render(<ClipsSection deviceId={107} />)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    expect(clips.getByRole('alert').textContent ?? '').toContain('PRECONDITION_FAILED')
  })
})

describe('ClipsSection — empty with a cause', () => {
  it('names the DAY and which sources answered for it', () => {
    sourcesAnswer = {
      status: 'success',
      data: [source('analytics', 'CamStack recordings', 'ok')],
    }
    clipsAnswer = { status: 'success', data: [] }
    render(<ClipsSection deviceId={107} />)
    const empty = within(screen.getByRole('region', { name: 'Clips' })).getByRole('status')
    // The day is spelled out: "no clips" with no date is the ambiguity this
    // surface exists to remove.
    expect(empty.textContent ?? '').toMatch(/\d{4}/)
    expect(empty.textContent ?? '').toContain('CamStack recordings')
  })

  it('nobody answering is a DIFFERENT sentence from a quiet day', () => {
    sourcesAnswer = {
      status: 'success',
      data: [source('native:reolink:onboard', 'SD card', 'no-storage', 'HddInfo mount 0')],
    }
    clipsAnswer = { status: 'success', data: [] }
    render(<ClipsSection deviceId={106} />)
    const empty = within(screen.getByRole('region', { name: 'Clips' })).getByRole('status')
    expect(empty.textContent ?? '').toMatch(/no source could answer/i)
  })
})

describe('ClipsSection — degraded per source', () => {
  it('shows the rows that arrived AND the source that could not answer, verbatim', () => {
    sourcesAnswer = {
      status: 'success',
      data: [
        source('native:reolink:onboard', 'SD card', 'ok'),
        source(
          'native:reolink:hub',
          'Home Hub',
          'unreachable',
          'findEventLog parser is not landed',
        ),
      ],
    }
    clipsAnswer = {
      status: 'success',
      data: [clip('native:reolink:onboard:1', 'native:reolink:onboard')],
    }
    render(<ClipsSection deviceId={3628} />)

    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    // The rows that arrived.
    expect(clips.getAllByRole('button', { name: /native:reolink:onboard/ }).length).toBe(1)
    // AND, beside them, the source that did not — with its reason verbatim.
    expect(clips.getByText('findEventLog parser is not landed')).toBeTruthy()
    expect(clips.getAllByText(/Home Hub/).length).toBeGreaterThan(0)
  })
})

describe('ClipsSection — sleeping / no-storage / index-empty each get their own words', () => {
  it('no-storage is about the card, not about clips', () => {
    sourcesAnswer = {
      status: 'success',
      data: [source('native:reolink:onboard', 'SD card', 'no-storage', 'HddInfo mount 0')],
    }
    clipsAnswer = { status: 'success', data: [] }
    render(<ClipsSection deviceId={106} />)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    expect(clips.getByText(/no storage card/i)).toBeTruthy()
    expect(clips.getByText('HddInfo mount 0')).toBeTruthy()
  })

  it('index-empty is about the index disagreeing with the calendar', () => {
    sourcesAnswer = {
      status: 'success',
      data: [
        source(
          'native:reolink:onboard',
          'SD card',
          'index-empty',
          '6–20 September list zero files',
        ),
      ],
    }
    clipsAnswer = { status: 'success', data: [] }
    render(<ClipsSection deviceId={108} />)
    expect(
      within(screen.getByRole('region', { name: 'Clips' })).getByText(/calendar/i),
    ).toBeTruthy()
  })

  it('a sleeping source that CONTRIBUTED rows is not listed as silent', () => {
    // It did answer — from its persisted catalog — so naming it beside the
    // sources that answered nothing would be wrong.
    //
    // NOTE what left with the diagnostics table on 2026-09-21: the AGE of that
    // cached read. D549 decision 13 ("a cached list is never drawn as current")
    // now has no surface in this section. Recorded here rather than quietly
    // dropped; a one-line note above the list is the cheap way back if the
    // operator wants it.
    const asOf = Date.now() - 3 * 3_600_000
    sourcesAnswer = {
      status: 'success',
      data: [
        {
          source: 'native:reolink:onboard',
          label: 'SD card',
          availability: { state: 'sleeping', reason: 'a read would be a wake', catalogAsOf: asOf },
        },
      ],
    }
    clipsAnswer = {
      status: 'success',
      data: [clip('native:reolink:onboard:1', 'native:reolink:onboard')],
    }
    render(<ClipsSection deviceId={4263} />)
    expect(screen.queryByText(/a read would be a wake/)).toBeNull()
  })
})

describe('ClipsSection — a row the source says is not playable', () => {
  it('is SHOWN, disabled, with the source’s own reason', () => {
    sourcesAnswer = { status: 'success', data: [source('native:reolink:hub', 'Home Hub', 'ok')] }
    clipsAnswer = {
      status: 'success',
      data: [
        {
          ...clip('native:reolink:hub:1', 'native:reolink:hub'),
          playable: false,
          unplayableReason: 'event sits inside no file',
        },
      ],
    }
    render(<ClipsSection deviceId={3628} />)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    expect(clips.getByText(/event sits inside no file/)).toBeTruthy()
    const tile = clips.getAllByRole('button', { name: /native:reolink:hub/ })[0]
    expect(tile).toBeTruthy()
    expect((tile as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ClipsSection — the window it asks for', () => {
  // The section used to ask for a whole local calendar day, ending at the
  // NEXT local midnight — an instant in the future. It now asks for the
  // timebar's band, whose right edge is `now` (D564). What survives here is
  // the half that never changed: the window is half-open, local, and carries
  // the device. The band itself is pinned in `clips-section-band.test.tsx`,
  // against a frozen clock, because the default band's WIDTH depends on the
  // time of day the suite happens to run at.
  it('asks listClips for a half-open local window that never runs into the future', () => {
    sourcesAnswer = { status: 'success', data: [source('analytics', 'CamStack recordings', 'ok')] }
    clipsAnswer = { status: 'success', data: [] }
    const before = Date.now()
    render(<ClipsSection deviceId={107} />)
    const input = listClipsInputs.at(-1)
    expect(input).toMatchObject({ deviceId: 107 })
    const typed = input as { since: number; until: number }
    expect(new Date(typed.since).getHours()).toBe(0)
    expect(typed.since).toBeLessThanOrEqual(typed.until)
    expect(typed.until).toBeLessThanOrEqual(Date.now())
    expect(typed.until).toBeGreaterThanOrEqual(before - 1_000)
  })
})
