/**
 * Events Library section — Feed + Debug via `?section=`. Training is the addon
 * page (`/addon/training`); legacy `?section=retrain` redirects there.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../components/detection-intelligence/EventsSection', () => ({
  EventsSection: () => <div>events-feed-section</div>,
}))
vi.mock('../../components/detection-intelligence/SemanticEventSearch', () => ({
  SemanticEventSearch: () => <div>semantic-event-search</div>,
}))
vi.mock('../../components/detection-intelligence/StationarySection', () => ({
  StationarySection: () => <div>stationary-section</div>,
}))
vi.mock('../EventsDebug', () => ({
  EventsDebugPage: () => <div>events-debug-page</div>,
}))
vi.mock('../../components/detection-intelligence/RetrainTabCallout', () => ({
  RetrainTabCallout: () => <div>retrain-callout</div>,
}))

import { EventsPage } from '../Events'

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/library" element={<EventsPage />} />
          <Route path="/addon/training" element={<div>training-addon</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Events page tabs', () => {
  it('offers Feed and Debug, opens on the feed, and has no Retrain tab', () => {
    renderAt('/library?tab=events')
    expect(screen.getByRole('tablist', { name: 'Events sections' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Feed' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Debug' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Retrain' })).not.toBeInTheDocument()
    expect(screen.getByText('events-feed-section')).toBeInTheDocument()
  })

  it('redirects legacy ?section=retrain to /addon/training', () => {
    renderAt('/library?tab=events&section=retrain')
    expect(screen.getByText('training-addon')).toBeInTheDocument()
  })
})
