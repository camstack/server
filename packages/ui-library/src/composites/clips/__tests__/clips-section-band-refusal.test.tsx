// @vitest-environment jsdom
/**
 * A band too wide to ask is REFUSED on screen, and the query is never fired.
 *
 * The bound (`MAX_BAND_LOCAL_DAYS`) is deliberately above everything the
 * timebar can currently produce — its widest zoom is one calendar day — so
 * this branch is not reachable by clicking, and a test that tried to reach it
 * through the controls would be asserting the controls, not the refusal. What
 * is under test here is the WIRING: that a refusing plan disables the query
 * and produces words, rather than a skeleton spinning on a request nobody
 * sent. `planClipBand` is stubbed for exactly that reason; its own decision is
 * pinned in `clip-band.spec.ts` and the state it produces in
 * `clip-view-state.spec.ts`.
 *
 * It matters because the bound exists to survive a future widening of the
 * control. A guard that is only ever exercised by its own unit test is the
 * leftover this repo treats as worse than nothing — this file is the half that
 * says the surface honours it.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ClipBand, ClipBandPlan } from '../clip-band.js'

const WIDE: ClipBand = {
  fromMs: new Date(2026, 8, 14).getTime(),
  toMs: new Date(2026, 8, 21).getTime(),
}

interface RecordedCall {
  readonly enabled: boolean
}
const clipCalls: RecordedCall[] = []

vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'present',
}))

vi.mock('../clip-band.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clip-band.js')>()
  const plan: ClipBandPlan = {
    kind: 'too-wide',
    band: WIDE,
    localDays: 7,
    maxLocalDays: actual.MAX_BAND_LOCAL_DAYS,
  }
  return { ...actual, planClipBand: () => plan }
})

vi.mock('../../../generated/system-hooks', () => ({
  useVideoclipsListSources: () => ({
    status: 'success',
    data: [{ source: 'analytics', label: 'CamStack recordings', availability: { state: 'ok' } }],
  }),
  useVideoclipsListClips: (_input: unknown, options?: { enabled?: boolean }) => {
    clipCalls.push({ enabled: options?.enabled ?? true })
    return { status: 'pending', data: undefined }
  },
  useVideoclipsGetClipPlayback: () => ({ status: 'pending', data: undefined }),
  usePipelineAnalyticsGetEventDensity: () => ({ status: 'success', data: [] }),
}))

const { ClipsSection } = await import('../ClipsSection.js')

describe('ClipsSection — a band wider than the bound', () => {
  it('never fires the clip query', () => {
    clipCalls.length = 0
    render(<ClipsSection deviceId={107} />)
    expect(clipCalls.length).toBeGreaterThan(0)
    expect(clipCalls.every((call) => !call.enabled)).toBe(true)
  })

  it('says how wide the band is and what the bound is — never a skeleton', () => {
    render(<ClipsSection deviceId={107} />)
    const clips = within(screen.getByRole('region', { name: 'Clips' }))
    const text = clips.getByRole('alert').textContent ?? ''
    expect(text).toMatch(/7/)
    expect(text).toMatch(/2/)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
