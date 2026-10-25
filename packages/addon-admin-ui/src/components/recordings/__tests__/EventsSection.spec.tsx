/**
 * EventsSection — composition test.
 *
 * Event-domain controls live here: the durable store footprint AND the
 * eventMedia folder / post-processing node. Footage stays off this tab.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../EventsManagementSection', () => ({
  EventsManagementSection: () => <div>events-management-section</div>,
}))
vi.mock('../../pipeline/tabs/ClusterEventsTab', () => ({
  ClusterEventsTab: () => <div>cluster-events-tab</div>,
}))
vi.mock('../../pipeline/tabs/ClusterRecordingTab', () => ({
  ClusterRecordingTab: () => <div>cluster-recording-tab</div>,
}))
vi.mock('../StorageSection', () => ({
  StorageSection: () => <div>storage-section</div>,
}))

import { EventsSection } from '../EventsSection'

describe('EventsSection', () => {
  it('shows the event-store footprint and the eventMedia folder', () => {
    render(<EventsSection />)
    expect(screen.getByText('events-management-section')).toBeInTheDocument()
    expect(screen.getByText('cluster-events-tab')).toBeInTheDocument()
  })

  it('holds no footage content', () => {
    render(<EventsSection />)
    expect(screen.queryByText('cluster-recording-tab')).not.toBeInTheDocument()
    expect(screen.queryByText('storage-section')).not.toBeInTheDocument()
  })
})
