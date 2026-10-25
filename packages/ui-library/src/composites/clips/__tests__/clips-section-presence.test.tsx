// @vitest-environment jsdom
/**
 * The browser asks the REGISTRY whether `videoclips` is there, and renders
 * all four answers — never a boolean (D315).
 *
 * `pending` and `unknown` are the two an operator sees first and the two a
 * boolean cannot carry: collapsed into `false` they say, in words, that a
 * component is NOT INSTALLED while it is installed and running, and the
 * operator goes hunting a fault that does not exist.
 *
 * `unknown` here means the registry read FAILED. It is not an answer, so it
 * is not "absent" either.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let presence = 'pending'

vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => presence,
}))
vi.mock('../../../generated/system-hooks', () => ({
  useVideoclipsListSources: () => ({
    status: 'success',
    data: [{ source: 'analytics', label: 'CamStack recordings', availability: { state: 'ok' } }],
  }),
  useVideoclipsListClips: () => ({ status: 'success', data: [] }),
  usePipelineAnalyticsGetEventDensity: () => ({ status: 'success', data: [] }),
  useVideoclipsGetClipPlayback: () => ({ status: 'pending', data: undefined }),
}))

const { ClipsSection } = await import('../ClipsSection.js')

beforeEach(() => {
  presence = 'pending'
})

describe('ClipsSection — capability presence', () => {
  it('pending renders progress, never absence', () => {
    render(<ClipsSection deviceId={107} />)
    expect(screen.getByRole('status').textContent ?? '').toMatch(/asking|checking|loading/i)
    expect(screen.queryByText(/not installed/i)).toBeNull()
  })

  it('unknown says the registry could not be reached — it is not "absent"', () => {
    presence = 'unknown'
    render(<ClipsSection deviceId={107} />)
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toMatch(/could not be reached|registry/i)
    expect(text).not.toMatch(/not installed/i)
  })

  it('absent says so, in those words', () => {
    presence = 'absent'
    render(<ClipsSection deviceId={107} />)
    expect(screen.getByRole('status').textContent ?? '').toMatch(/not installed|no provider/i)
  })

  it('present renders the browser', () => {
    presence = 'present'
    render(<ClipsSection deviceId={107} />)
    // The per-source diagnostics table was removed on 2026-09-21 (it restated
    // in four columns what the body says in context). The browser IS the clip
    // list now, so that is what presence renders.
    expect(screen.getByRole('region', { name: 'Clips' })).toBeTruthy()
  })
})
