/**
 * Library shell — one Detection nav entry, `?tab=` owned by the shell,
 * hard cut of the four former routes (no redirects).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  buildNavSections,
  type BuildNavSectionsParams,
  type NavTranslate,
} from '../../lib/nav-items'

vi.mock('../DetectionIntelligence', () => ({
  DetectionIntelligencePage: () => <div data-testid="people-body">people</div>,
}))
vi.mock('../Plates', () => ({
  PlatesPage: () => <div data-testid="vehicles-body">vehicles</div>,
}))
vi.mock('../Scenes', () => ({
  ScenesPage: () => <div data-testid="scenes-body">scenes</div>,
}))
vi.mock('../../components/recordings/ExportsSection', () => ({
  ExportsSection: () => <div data-testid="exports-body">exports</div>,
}))

import { LibraryPage } from '../Library'

function navTranslate(key: string): string
function navTranslate(key: string, defaultValue: string): string
function navTranslate(key: string, defaultValue?: string): string {
  return typeof defaultValue === 'string' ? defaultValue : key
}

const navT: NavTranslate = navTranslate
const navParams: BuildNavSectionsParams = { isAdmin: true, t: navT }

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.search}</div>
}

function renderLibrary(initialEntry: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/library"
            element={
              <>
                <LibraryPage />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<div data-testid="no-match">no-match</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Detection nav — Library hard cut', () => {
  it('exposes one Library path under Detection, plus Archive', () => {
    const detection = buildNavSections(navParams).find((s) => s.key === 'detection')
    expect(detection?.items.map((i) => i.path)).toEqual(['/library', '/archive'])
    expect(detection?.items.map((i) => i.label)).toEqual(['Library', 'Archive'])
  })
})

describe('LibraryPage', () => {
  it('defaults to people and switches bodies via ?tab=', () => {
    renderLibrary('/library')
    expect(screen.getByTestId('people-body')).toBeTruthy()
    expect(screen.queryByTestId('vehicles-body')).toBeNull()

    expect(screen.getByRole('tablist', { name: 'Library sections' })).toBeTruthy()
    expect(screen.getByTestId('section-people').getAttribute('aria-selected')).toBe('true')
  })

  it('renders Vehicles at /library?tab=vehicles', () => {
    renderLibrary('/library?tab=vehicles')
    expect(screen.getByTestId('vehicles-body')).toBeTruthy()
    expect(screen.queryByTestId('people-body')).toBeNull()
    expect(screen.getByTestId('section-vehicles').getAttribute('aria-selected')).toBe('true')
  })

  it('lists every export at /library?tab=exports', () => {
    renderLibrary('/library?tab=exports')
    expect(screen.getByTestId('exports-body')).toBeTruthy()
    expect(screen.getByTestId('section-exports').getAttribute('aria-selected')).toBe('true')
  })

  it("declares ?camera= as the Exports section's own: leaving Exports drops it", () => {
    renderLibrary('/library?tab=exports&camera=101')
    expect(screen.getByTestId('location').textContent).toContain('camera=101')
    fireEvent.click(screen.getByTestId('section-people'))
    expect(screen.getByTestId('people-body')).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('?tab=people')
  })

  it('leaves /plates unmatched (hard cut, no redirect)', () => {
    renderLibrary('/plates')
    expect(screen.getByTestId('no-match')).toBeTruthy()
    expect(screen.queryByTestId('vehicles-body')).toBeNull()
  })
})
