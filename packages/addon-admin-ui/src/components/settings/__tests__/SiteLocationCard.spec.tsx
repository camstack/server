/**
 * Site location card.
 *
 * The long explanatory paragraph under the heading was removed on 2026-08-28
 * ("la descrizione di Site location è estremamente lunga, rimuovila
 * completamente"). Everything that reports STATE stays: the provenance badge,
 * the detected-label line and the failed-derivation warning — those are the
 * reason this card is hand-written instead of a `ConfigUISchema` section, and
 * losing them would make the guess indistinguishable from the operator's own
 * value.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const locationState = vi.hoisted(() => ({
  data: null as unknown,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystemGetSiteLocation: () => ({ data: locationState.data, isLoading: false }),
    useSystemSetSiteLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSystemDetectSiteLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})

import { SiteLocationCard } from '../SiteLocationCard'

describe('SiteLocationCard', () => {
  it('renders NO description paragraph', () => {
    locationState.data = {
      location: { latitude: 45.1, longitude: 9.2, source: 'operator-set', label: 'Pavia' },
      derivationAttemptedAt: null,
      timeZone: 'Europe/Rome',
      derivationError: null,
    }
    render(<SiteLocationCard />)

    // The exact phrases of the removed prose. Asserted individually so a
    // partial re-add is caught too.
    expect(screen.queryByText(/Where this installation physically is/i)).toBeNull()
    expect(screen.queryByText(/sunrise and sunset/i)).toBeNull()
    expect(screen.queryByText(/coarse UTC clock split/i)).toBeNull()
  })

  it('keeps the heading, the provenance badge and the detected label', () => {
    locationState.data = {
      location: { latitude: 45.1, longitude: 9.2, source: 'operator-set', label: 'Pavia' },
      derivationAttemptedAt: null,
      timeZone: 'Europe/Rome',
      derivationError: null,
    }
    render(<SiteLocationCard />)

    expect(screen.getByText('Site location')).toBeTruthy()
    expect(screen.getByText('Set by you')).toBeTruthy()
    expect(screen.getByText(/Detected near Pavia/)).toBeTruthy()
  })

  it('still distinguishes a derived value from an operator-set one', () => {
    locationState.data = {
      location: { latitude: 45.1, longitude: 9.2, source: 'ip-derived', label: 'Milan' },
      derivationAttemptedAt: 1,
      timeZone: 'Europe/Rome',
      derivationError: null,
    }
    render(<SiteLocationCard />)
    expect(screen.getByText('Derived from IP')).toBeTruthy()
  })

  it('still warns when automatic detection failed', () => {
    locationState.data = {
      location: null,
      derivationAttemptedAt: 1,
      derivationError: 'lookup refused',
    }
    render(<SiteLocationCard />)
    expect(screen.getByText('Not configured')).toBeTruthy()
    expect(screen.getByText(/Automatic detection from the public IP did not succeed/)).toBeTruthy()
  })
})
