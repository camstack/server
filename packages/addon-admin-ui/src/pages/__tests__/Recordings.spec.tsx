/**
 * Recordings page — tab strip placement, and the guarantee the re-homing pass
 * exists to keep.
 *
 * The tabs were re-sorted by DOMAIN (footage / event store / both) instead of
 * by the history of which surface introduced a control. The risk of a pass
 * like that is not an ugly tab bar, it is a control that quietly stops being
 * mounted anywhere — and a per-tab snapshot passes happily while that happens.
 *
 * So the load-bearing test here is over the MOUNTED SET: only the LEAF
 * sections are stubbed, the composers (`RecordingsStorageSection`,
 * `EventsSection`, `RecordingsManagementSection`) run for real, every tab is
 * visited, and the union of markers seen must equal the leaf set the page had
 * before the split. Move a section between tabs and this still passes; drop
 * one and it fails wherever you dropped it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../components/recordings/StorageSection', () => ({
  StorageSection: () => <div>storage-section</div>,
}))
vi.mock('../../components/recordings/CameraRecordingSettingsSection', () => ({
  CameraRecordingSettingsSection: () => <div>cameras-section</div>,
}))
vi.mock('../../components/recordings/ExportsSection', () => ({
  ExportsSection: () => <div>exports-section</div>,
}))
vi.mock('../../components/recordings/ActivitySection', () => ({
  ActivitySection: () => <div>activity-section</div>,
}))
vi.mock('../../components/recordings/EventsManagementSection', () => ({
  EventsManagementSection: () => <div>events-management-section</div>,
}))
vi.mock('../../components/recordings/CleanupSection', () => ({
  CleanupSection: () => <div>cleanup-section</div>,
}))
vi.mock('../../components/recordings/DiskReconcileSection', () => ({
  DiskReconcileSection: () => <div>disk-reconcile-section</div>,
}))
vi.mock('../../components/recordings/MaintenanceAuditSection', () => ({
  MaintenanceAuditSection: () => <div>maintenance-audit-section</div>,
}))
vi.mock('../../components/recordings/migration/StorageMigrationSection', () => ({
  StorageMigrationSection: () => <div>storage-migration-section</div>,
}))
vi.mock('../../components/pipeline/tabs/ClusterRecordingTab', () => ({
  ClusterRecordingTab: () => <div>cluster-recording-tab</div>,
}))
vi.mock('../../components/pipeline/tabs/ClusterEventsTab', () => ({
  ClusterEventsTab: () => <div>cluster-events-tab</div>,
}))

import { RecordingsPage } from '../Recordings'

/** The tab bar, left to right. */
const TAB_LABELS: readonly string[] = [
  'Recordings',
  'Events',
  'Cameras',
  'Export',
  'Activity',
  'Management',
]

/**
 * Every leaf section the page mounted BEFORE the domain split, as its stub
 * marker. This list is the contract: it may only shrink when a control is
 * deliberately deleted, never as a side effect of moving one.
 */
const LEAF_MARKERS: readonly string[] = [
  'storage-section',
  'cluster-recording-tab',
  'cameras-section',
  'exports-section',
  'events-management-section',
  'cluster-events-tab',
  'activity-section',
  'disk-reconcile-section',
  'cleanup-section',
  'storage-migration-section',
]

/** Surfaces the live query string, so the id a tab WRITES can be asserted. */
function LocationProbe(): ReactNode {
  const location = useLocation()
  return <span data-testid="search">{location.search}</span>
}

function renderPage(entry = '/recordings') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <RecordingsPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** Visit every tab and collect which leaf markers were rendered at least once. */
function collectMountedLeaves(): readonly string[] {
  const seen = new Set<string>()
  for (const label of TAB_LABELS) {
    fireEvent.click(screen.getByRole('tab', { name: label }))
    for (const marker of LEAF_MARKERS) {
      if (screen.queryByText(marker) !== null) seen.add(marker)
    }
  }
  return [...seen].toSorted()
}

describe('Recordings page tabs', () => {
  it('every section that existed before the domain split is still reachable', () => {
    renderPage()
    expect(collectMountedLeaves()).toEqual([...LEAF_MARKERS].toSorted())
  })

  it('offers exactly Recordings, Events, Cameras, Export, Activity, Management — in that order', () => {
    renderPage()
    const labels = screen.getAllByRole('tab').map((b) => b.textContent)
    expect(labels).toEqual([...TAB_LABELS])
  })

  it('defaults to Recordings — footage footprint and the recording node together', () => {
    renderPage()
    expect(screen.getByText('storage-section')).toBeInTheDocument()
    expect(screen.getByText('cluster-recording-tab')).toBeInTheDocument()
    expect(screen.queryByText('cameras-section')).not.toBeInTheDocument()
  })

  it('gathers the event-store footprint under Events', () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Events' }))
    expect(screen.getByText('events-management-section')).toBeInTheDocument()
    expect(screen.getByText('cluster-events-tab')).toBeInTheDocument()
  })

  it('leaves Management with cleanup, disk reconcile, and storage move', () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Management' }))
    expect(screen.getByText('disk-reconcile-section')).toBeInTheDocument()
    expect(screen.getByText('cleanup-section')).toBeInTheDocument()
    expect(screen.getByText('storage-migration-section')).toBeInTheDocument()
    expect(screen.queryByText('maintenance-audit-section')).not.toBeInTheDocument()
    expect(screen.queryByText('housekeeping-section')).not.toBeInTheDocument()
    expect(screen.queryByText('events-management-section')).not.toBeInTheDocument()
    expect(screen.queryByText('cluster-events-tab')).not.toBeInTheDocument()
    expect(screen.queryByText('cluster-recording-tab')).not.toBeInTheDocument()
  })

  it('does not gather the storage move on Recordings', () => {
    renderPage()
    expect(screen.queryByText('storage-migration-section')).not.toBeInTheDocument()
  })

  it('switches to Cameras', () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Cameras' }))
    expect(screen.getByText('cameras-section')).toBeInTheDocument()
    expect(screen.queryByText('storage-section')).not.toBeInTheDocument()
  })

  it('switches to Export', () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Export' }))
    expect(screen.getByText('exports-section')).toBeInTheDocument()
  })

  it('switches to Activity — the cross-domain ops log stays its own reading surface', () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }))
    expect(screen.getByText('activity-section')).toBeInTheDocument()
  })
})

/**
 * `AdminTabs` reflects the tab as `?tab=<id>`, so the ids are a deep-link
 * contract with bookmarks this repo cannot see. Renaming the "Storage" tab to
 * "Recordings" deliberately did NOT rename its id.
 *
 * The id has to be asserted on the WRITE side. Reading `?tab=storage` and
 * checking the storage surface appears proves nothing about that particular
 * id: `storage` is also the first tab, so `AdminTabs`'s unknown-id fallback
 * renders it either way — the assertion passed unchanged when the id was
 * renamed to `recordings`. The URL a tab click produces is what a bookmark
 * captures, and it is different for every id.
 */
describe('Recordings page deep links', () => {
  it.each([
    ['Recordings', 'storage'],
    ['Cameras', 'cameras'],
    ['Export', 'exports'],
    ['Events', 'events'],
    ['Activity', 'activity'],
    ['Management', 'management'],
  ])('the %s tab writes ?tab=%s', (label, tabId) => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: label }))
    expect(screen.getByTestId('search').textContent).toBe(`?tab=${tabId}`)
  })

  it.each([
    ['cameras', 'cameras-section'],
    ['exports', 'exports-section'],
    ['activity', 'activity-section'],
    ['management', 'disk-reconcile-section'],
    ['events', 'events-management-section'],
  ])('?tab=%s lands on its surface', (tabId, marker) => {
    renderPage(`/recordings?tab=${tabId}`)
    expect(screen.getByText(marker)).toBeInTheDocument()
  })

  it('an unknown tab id falls back to the first tab rather than blanking', () => {
    renderPage('/recordings?tab=nope')
    expect(screen.getByText('storage-section')).toBeInTheDocument()
  })
})
