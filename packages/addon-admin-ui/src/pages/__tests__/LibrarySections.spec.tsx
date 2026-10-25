/**
 * Library section chrome — SectionCard bodies for People / Vehicles, no nested
 * AdminPage under Events Feed/Debug.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../components/detection-intelligence/PeopleList', () => ({
  PeopleList: () => <div data-testid="people-list">people-list</div>,
}))
vi.mock('../../components/detection-intelligence/UnassignedFaces', () => ({
  UnassignedFaces: () => <div data-testid="faces-list">faces-list</div>,
}))
vi.mock('../../components/detection-intelligence/VehiclesList', () => ({
  VehiclesList: () => <div data-testid="vehicles-list">vehicles-list</div>,
}))
vi.mock('../../components/detection-intelligence/RecentPlates', () => ({
  RecentPlates: () => <div data-testid="plates-list">plates-list</div>,
}))
vi.mock('../../components/detection-intelligence/use-face-gallery-live-refresh', () => ({
  useFaceGalleryLiveRefresh: () => undefined,
}))
vi.mock('../../components/detection-intelligence/use-plate-gallery-live-refresh', () => ({
  usePlateGalleryLiveRefresh: () => undefined,
}))
vi.mock('../../components/detection-intelligence/EventsSection', () => ({
  EventsSection: () => <div data-testid="events-section">events-section</div>,
}))
vi.mock('../../components/detection-intelligence/SemanticEventSearch', () => ({
  SemanticEventSearch: () => <div>semantic-search</div>,
}))
vi.mock('../../components/detection-intelligence/StationarySection', () => ({
  StationarySection: () => null,
}))
vi.mock('../../components/detection-intelligence/RetrainTabCallout', () => ({
  RetrainTabCallout: () => null,
}))

import { DetectionIntelligencePage } from '../DetectionIntelligence'
import { EventsFeedPage } from '../EventsFeed'
import { PlatesPage } from '../Plates'

function wrap(ui: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Library People / Vehicles section chrome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('wraps People bodies in SectionCards', () => {
    wrap(<DetectionIntelligencePage />)
    expect(screen.getByTestId('library-section-people')).toBeTruthy()
    expect(screen.getByTestId('library-section-recent-faces')).toBeTruthy()
    expect(screen.getByTestId('people-list')).toBeTruthy()
    expect(screen.getByTestId('faces-list')).toBeTruthy()
  })

  it('wraps Vehicles bodies in SectionCards', () => {
    wrap(<PlatesPage />)
    expect(screen.getByTestId('library-section-vehicles')).toBeTruthy()
    expect(screen.getByTestId('library-section-recent-plates')).toBeTruthy()
    expect(screen.getByTestId('vehicles-list')).toBeTruthy()
    expect(screen.getByTestId('plates-list')).toBeTruthy()
  })
})

describe('Events Feed under Library', () => {
  it('renders the feed body without a nested page title (no double AdminPage chrome)', () => {
    wrap(<EventsFeedPage />)
    expect(screen.getByTestId('events-section')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })
})
