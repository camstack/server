/**
 * Library shell — one Detection nav entry, `?tab=` owned by the shell,
 * hard cut of the four former routes (no redirects).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
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
vi.mock('../Events', () => ({
  EventsPage: () => <div data-testid="events-body">events</div>,
}))
vi.mock('../Scenes', () => ({
  ScenesPage: () => <div data-testid="scenes-body">scenes</div>,
}))

import { LibraryPage } from '../Library'

function navTranslate(key: string): string
function navTranslate(key: string, defaultValue: string): string
function navTranslate(key: string, defaultValue?: string): string {
  return typeof defaultValue === 'string' ? defaultValue : key
}

const navT: NavTranslate = navTranslate
const navParams: BuildNavSectionsParams = { isAdmin: true, t: navT }

function renderLibrary(initialEntry: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="*" element={<div data-testid="no-match">no-match</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Detection nav — Library hard cut', () => {
  it('exposes one Library path under Detection, plus Recordings', () => {
    const detection = buildNavSections(navParams).find((s) => s.key === 'detection')
    expect(detection?.items.map((i) => i.path)).toEqual(['/library', '/recordings'])
    expect(detection?.items.map((i) => i.label)).toEqual(['Library', 'Recordings'])
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

  it('leaves /plates unmatched (hard cut, no redirect)', () => {
    renderLibrary('/plates')
    expect(screen.getByTestId('no-match')).toBeTruthy()
    expect(screen.queryByTestId('vehicles-body')).toBeNull()
  })
})
