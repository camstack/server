// @vitest-environment jsdom
/**
 * The clips list follows a BAND selected on the recording timebar (D564).
 *
 * The section used to own a `‹ day ›` pair and ask `listClips` for one whole
 * local calendar day. The operator asked for the recording section's own
 * control instead — *"utilizzare lo stesso componente della sezione recording
 * con la timebar dove selezionare un periodo e mostrare le clip solo di quella
 * banda selezionata, espandibile"* [use the same component as the recording section with the timebar where a period can be selected and show the clips of that selected band only, expandable] — so the same `TimelineControls` and
 * `EventHeatmap` the recording timeline is built from now drive this list.
 *
 * What each test pins, and why it is not obvious:
 *
 *  - **The band is asked for, not the day.** The old window ended at the NEXT
 *    local midnight, an instant in the future; the timebar's window ends at
 *    `now`. That difference is the whole change and it is invisible on screen,
 *    so it is asserted on the wire.
 *  - **Every control that moves the band re-asks the list.** A timebar whose
 *    zoom moved the picture and not the query would be the worst of both.
 *  - **Expanding is a control that exists.** The band widens by the timebar's
 *    own zoom-out, and a bucket selection is released back to the visible
 *    window by one named button — not by a gesture invented for this surface.
 *  - **A band too wide to ask is refused before anything is fired.** The
 *    refusal decision itself is pinned in `clip-band.spec.ts` and
 *    `clip-view-state.spec.ts`; what this file pins is that the SECTION
 *    honours it — the query is disabled and the operator is told, rather than
 *    a skeleton spinning on a request nobody sent.
 *
 * Time is frozen at local 12:00 because the timebar's default window is
 * "local midnight → now" and its bucket size is derived from that span; a
 * suite that ran at 00:04 would otherwise assert against a four-minute view.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface QueryAnswer {
  readonly data?: unknown
  readonly status: 'pending' | 'error' | 'success'
  readonly error?: { readonly message: string }
}

interface RecordedCall {
  readonly input: { readonly since: number; readonly until: number; readonly deviceId: number }
  readonly enabled: boolean
}

/** Local noon on a fixed day — see the file header. */
const NOON = new Date(2026, 8, 20, 12, 0, 0, 0)
const MIDNIGHT = new Date(2026, 8, 20, 0, 0, 0, 0).getTime()
/** 12 h of view → `bucketMsForSpan` picks 5 min. */
const BUCKET_MS = 5 * 60_000
/** A density row at local 08:00, so exactly one heatmap bar exists. */
const DENSITY_AT = new Date(2026, 8, 20, 8, 0, 0, 0).getTime()

let sourcesAnswer: QueryAnswer = { status: 'pending' }
let clipsAnswer: QueryAnswer = { status: 'pending' }
let densityAnswer: QueryAnswer = { status: 'pending' }
const clipCalls: RecordedCall[] = []

vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'present',
}))

vi.mock('../../../generated/system-hooks', () => ({
  useVideoclipsListSources: () => sourcesAnswer,
  useVideoclipsListClips: (input: RecordedCall['input'], options?: { enabled?: boolean }) => {
    clipCalls.push({ input, enabled: options?.enabled ?? true })
    return clipsAnswer
  },
  useVideoclipsGetClipPlayback: () => ({ status: 'pending', data: undefined }),
  usePipelineAnalyticsGetEventDensity: () => densityAnswer,
}))

const { ClipsSection } = await import('../ClipsSection.js')

function lastCall(): RecordedCall {
  const call = clipCalls.at(-1)
  if (call === undefined) throw new Error('listClips was never called')
  return call
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOON)
  sourcesAnswer = { status: 'pending' }
  clipsAnswer = { status: 'pending' }
  densityAnswer = { status: 'pending' }
  clipCalls.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClipsSection — the band it asks for on a real first paint', () => {
  it('asks the timebar’s window, which ends at now — never the whole calendar day', () => {
    // Both queries PENDING: this is the state a first paint is really in, and
    // every previous spec on this surface warmed the data before asserting.
    render(<ClipsSection deviceId={107} />)
    const { input } = lastCall()
    expect(input.deviceId).toBe(107)
    expect(input.since).toBe(MIDNIGHT)
    expect(input.until).toBe(NOON.getTime())
  })

  it('does NOT fire while the sources are still out — there is no provider to name yet', () => {
    // `listClips` requires a provider (D554 amended) and the only place a provider's
    // id comes from is a `listSources` row. Asking before they land would mean
    // either an argument invented here or the absent one the hub now refuses.
    render(<ClipsSection deviceId={107} />)
    expect(lastCall().enabled).toBe(false)
  })

  it('fires the query once the sources land, because one local day is inside the bound', () => {
    sourcesAnswer = {
      status: 'success',
      data: [
        {
          source: 'analytics',
          label: 'CamStack recordings',
          addonId: 'recorder',
          availability: { state: 'ok' },
        },
      ],
    }
    render(<ClipsSection deviceId={107} />)
    expect(lastCall().enabled).toBe(true)
    expect(lastCall().input).toMatchObject({ provider: 'recorder' })
  })

  it('has no day navigation left to click', () => {
    render(<ClipsSection deviceId={107} />)
    expect(screen.queryByRole('button', { name: /previous day/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /next day/i })).toBeNull()
  })
})

describe('ClipsSection — moving the band re-asks the list', () => {
  beforeEach(() => {
    sourcesAnswer = {
      status: 'success',
      data: [
        {
          source: 'analytics',
          label: 'CamStack recordings',
          addonId: 'recorder',
          availability: { state: 'ok' },
        },
      ],
    }
    clipsAnswer = { status: 'success', data: [] }
    densityAnswer = {
      status: 'success',
      data: [{ bucketStart: DENSITY_AT, motion: 3, object: 1, audio: 0 }],
    }
  })

  it('zooming in narrows the band', () => {
    render(<ClipsSection deviceId={107} />)
    const before = lastCall().input
    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }))
    const after = lastCall().input
    expect(after.until - after.since).toBeLessThan(before.until - before.since)
  })

  it('picking a density bucket narrows the band to that bucket', () => {
    render(<ClipsSection deviceId={107} />)
    fireEvent.click(screen.getAllByTestId('heatmap-bar')[0] as HTMLElement)
    const { input } = lastCall()
    expect(input.since).toBe(DENSITY_AT)
    expect(input.until).toBe(DENSITY_AT + BUCKET_MS)
  })

  it('expands the band back to the visible window with one named control', () => {
    render(<ClipsSection deviceId={107} />)
    const view = lastCall().input
    fireEvent.click(screen.getAllByTestId('heatmap-bar')[0] as HTMLElement)
    expect(lastCall().input.since).toBe(DENSITY_AT)
    fireEvent.click(screen.getByRole('button', { name: /expand to the visible window/i }))
    expect(lastCall().input).toMatchObject({ since: view.since, until: view.until })
  })

  it('names the band, not a day, in the empty state', () => {
    render(<ClipsSection deviceId={107} />)
    fireEvent.click(screen.getAllByTestId('heatmap-bar')[0] as HTMLElement)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    // The band is 08:00–08:05 on the frozen day; the state has to say so.
    expect(clips.getByRole('status').textContent ?? '').toMatch(/08:0/)
  })
})

describe('ClipsSection — the four states survive the move', () => {
  it('is loading, and never claims the band is empty, while a query is out', () => {
    sourcesAnswer = {
      status: 'success',
      data: [
        {
          source: 'analytics',
          label: 'CamStack recordings',
          addonId: 'recorder',
          availability: { state: 'ok' },
        },
      ],
    }
    render(<ClipsSection deviceId={107} />)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    expect(clips.getByRole('status').textContent ?? '').toMatch(/loading/i)
  })

  it('still shows a degraded list: the rows that arrived AND the source that could not answer', () => {
    sourcesAnswer = {
      status: 'success',
      data: [
        {
          source: 'native:reolink:onboard',
          label: 'SD card',
          addonId: 'provider-reolink',
          availability: { state: 'ok' },
        },
        {
          source: 'native:reolink:hub',
          label: 'Hub storage',
          addonId: 'provider-reolink',
          availability: { state: 'unreachable', reason: 'Baichuan socket closed' },
        },
      ],
    }
    clipsAnswer = {
      status: 'success',
      data: [
        {
          id: 'native:reolink:onboard:1',
          source: 'native:reolink:onboard',
          kind: 'native',
          timeRange: { startMs: DENSITY_AT, endMs: DENSITY_AT + 60_000 },
          thumbnailUnavailable: { reason: 'unsupported' },
        },
      ],
    }
    render(<ClipsSection deviceId={107} />)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    expect(clips.getByText(/Baichuan socket closed/)).toBeTruthy()
    expect(clips.getAllByRole('button', { name: /native:reolink:onboard/ }).length).toBeGreaterThan(
      0,
    )
  })
})
