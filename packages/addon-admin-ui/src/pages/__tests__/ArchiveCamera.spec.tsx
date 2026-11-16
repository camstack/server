/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { CameraRow } from '../../components/archive/camera-rows'

expect.extend(jestDomMatchers)

const ROW: CameraRow = {
  deviceId: 101,
  name: 'Front door',
  mode: 'continuous',
  state: 'recording',
  warnings: 0,
  footageBytes: 10,
  oldestMs: null,
  eventRows: 1,
  eventBytes: 1,
}

vi.mock('../../components/archive/use-archive-data', () => ({
  useArchiveData: () => ({
    cameras: [{ id: 101, name: 'Front door' }],
    rows: [ROW],
    statuses: [],
    findings: [],
    isLoading: false,
  }),
}))
vi.mock('../../components/archive/ArchiveReviewSection', () => ({
  ArchiveReviewSection: ({ deviceId }: { deviceId: number }) => (
    <div data-testid="review-section">{deviceId}</div>
  ),
}))
vi.mock('../../components/archive/ArchiveSettingsSection', () => ({
  ArchiveSettingsSection: () => <div />,
}))
vi.mock('../../components/archive/ArchiveSpaceSection', () => ({
  ArchiveSpaceSection: () => <div />,
}))
vi.mock('../../components/archive/ArchiveHealthSection', () => ({
  ArchiveHealthSection: () => <div />,
  cameraStatusOf: () => undefined,
  FUNCTION_STATE_VARIANT: {
    ok: 'success',
    off: 'default',
    warning: 'warning',
    critical: 'danger',
    unknown: 'default',
  },
}))
vi.mock('../../components/archive/ArchiveActivity', () => ({ ArchiveActivity: () => <div /> }))
vi.mock('../../components/detection-intelligence/EventsSection', () => ({
  EventsSection: () => <div />,
}))
vi.mock('../../components/detection-intelligence/RetrainTabCallout', () => ({
  RetrainTabCallout: () => <div />,
}))
vi.mock('../../components/detection-intelligence/SemanticEventSearch', () => ({
  SemanticEventSearch: () => <div />,
}))
vi.mock('../../components/detection-intelligence/StationarySection', () => ({
  StationarySection: () => <div />,
}))
vi.mock('../../components/recordings/ExportsSection', () => ({ ExportsSection: () => <div /> }))
vi.mock('../EventsDebug', () => ({ EventsDebugPage: () => <div /> }))

import { ArchiveCameraPage } from '../ArchiveCamera'

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/archive/:deviceId" element={<ArchiveCameraPage />} />
        <Route path="/archive" element={<div data-testid="overview" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ArchiveCameraPage', () => {
  it('renders the sections for a known camera', () => {
    renderAt('/archive/101')
    expect(screen.getByTestId('review-section')).toHaveTextContent('101')
    for (const name of ['Review', 'Events', 'Exports', 'Health', 'Space', 'Settings']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
  })

  it('shows a clear empty state for an unknown camera', () => {
    renderAt('/archive/999')
    expect(screen.getByText('Camera not found')).toBeInTheDocument()
    expect(screen.queryByTestId('review-section')).not.toBeInTheDocument()
  })
})
