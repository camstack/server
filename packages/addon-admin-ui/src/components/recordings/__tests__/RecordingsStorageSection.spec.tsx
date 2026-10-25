/**
 * RecordingsStorageSection — composition test.
 *
 * The footage tab has to answer "how much" and "where does it go" without a
 * second click, and must not smuggle event-store or cluster-wide migration
 * back in (migration lives on Management).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../StorageSection', () => ({
  StorageSection: () => <div>storage-section</div>,
}))
vi.mock('../../pipeline/tabs/ClusterRecordingTab', () => ({
  ClusterRecordingTab: () => <div>cluster-recording-tab</div>,
}))
vi.mock('../../pipeline/tabs/ClusterEventsTab', () => ({
  ClusterEventsTab: () => <div>cluster-events-tab</div>,
}))
vi.mock('../EventsManagementSection', () => ({
  EventsManagementSection: () => <div>events-management-section</div>,
}))
vi.mock('../migration/StorageMigrationSection', () => ({
  StorageMigrationSection: () => <div>storage-migration-section</div>,
}))

import { RecordingsStorageSection } from '../RecordingsStorageSection'

describe('RecordingsStorageSection', () => {
  it('shows the footage footprint and recording node together', () => {
    render(<RecordingsStorageSection />)
    expect(screen.getByText('storage-section')).toBeInTheDocument()
    expect(screen.getByText('cluster-recording-tab')).toBeInTheDocument()
  })

  it('holds no event-store content and no storage migration', () => {
    render(<RecordingsStorageSection />)
    expect(screen.queryByText('cluster-events-tab')).not.toBeInTheDocument()
    expect(screen.queryByText('events-management-section')).not.toBeInTheDocument()
    expect(screen.queryByText('storage-migration-section')).not.toBeInTheDocument()
  })
})
