/**
 * RecordingsManagementSection — composition test.
 *
 * Management is the audit toolbar + disk-wins reconcile + storage migration.
 * Single-domain prune/delete stays off.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../CleanupSection', () => ({
  CleanupSection: () => <div>cleanup-section</div>,
}))
vi.mock('../DiskReconcileSection', () => ({
  DiskReconcileSection: () => <div>disk-reconcile-section</div>,
}))
vi.mock('../MaintenanceAuditSection', () => ({
  MaintenanceAuditSection: () => <div>maintenance-audit-section</div>,
}))
vi.mock('../EventsManagementSection', () => ({
  EventsManagementSection: () => <div>events-management-section</div>,
}))
vi.mock('../migration/StorageMigrationSection', () => ({
  StorageMigrationSection: () => <div>storage-migration-section</div>,
}))
vi.mock('../../pipeline/tabs/ClusterRecordingTab', () => ({
  ClusterRecordingTab: () => <div>cluster-recording-tab</div>,
}))
vi.mock('../../pipeline/tabs/ClusterEventsTab', () => ({
  ClusterEventsTab: () => <div>cluster-events-tab</div>,
}))

import { RecordingsManagementSection } from '../RecordingsManagementSection'

describe('RecordingsManagementSection', () => {
  it('renders cleanup, disk reconcile, and storage migration', () => {
    render(<RecordingsManagementSection />)
    expect(screen.getByText('cleanup-section')).toBeInTheDocument()
    expect(screen.getByText('disk-reconcile-section')).toBeInTheDocument()
    expect(screen.getByText('storage-migration-section')).toBeInTheDocument()
    expect(screen.queryByText('maintenance-audit-section')).not.toBeInTheDocument()
    expect(screen.queryByText('housekeeping-section')).not.toBeInTheDocument()
  })

  it('no longer holds single-domain content — that moved to Recordings and Events', () => {
    render(<RecordingsManagementSection />)
    expect(screen.queryByText('cluster-recording-tab')).not.toBeInTheDocument()
    expect(screen.queryByText('cluster-events-tab')).not.toBeInTheDocument()
    expect(screen.queryByText('events-management-section')).not.toBeInTheDocument()
  })
})
