/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { selectOption } from '@camstack/ui-library/testing'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CameraRow } from '../../components/archive/camera-rows'

expect.extend(jestDomMatchers)

const row = (deviceId: number, name: string): CameraRow => ({
  deviceId,
  name,
  mode: 'continuous',
  state: 'recording',
  warnings: 0,
  footageBytes: 10,
  oldestMs: null,
  eventRows: 1,
  eventBytes: 1,
})
const ROWS: readonly CameraRow[] = [row(101, 'Front door'), row(102, 'Garden')]

vi.mock('../../components/archive/use-archive-data', () => ({
  useArchiveData: () => ({
    cameras: [
      { id: 101, name: 'Front door' },
      { id: 102, name: 'Garden' },
    ],
    rows: ROWS,
    totals: {},
    usage: null,
    footprint: null,
    statuses: [],
    findings: [],
    digestAtMs: null,
    isLoading: false,
  }),
}))
vi.mock('../../components/archive/ArchiveKeyNumbers', () => ({ ArchiveKeyNumbers: () => <div /> }))
vi.mock('../../components/archive/ArchiveStorageCards', () => ({
  ArchiveStorageCards: () => <div />,
}))
vi.mock('../../components/archive/ArchiveActivity', () => ({ ArchiveActivity: () => <div /> }))
vi.mock('../../components/archive/ArchiveTools', () => ({ ArchiveTools: () => <div /> }))
vi.mock('../../components/archive/ArchiveReviewSection', () => ({
  ArchiveReviewSection: ({ deviceId }: { deviceId: number }) => (
    <div data-testid="review-section">{deviceId}</div>
  ),
}))
vi.mock('../../components/archive/ArchiveSettingsSection', () => ({
  ArchiveSettingsSection: () => <div data-testid="settings-section" />,
}))
vi.mock('../../components/archive/ArchiveSpaceSection', () => ({
  ArchiveSpaceSection: () => <div data-testid="space-section" />,
}))
vi.mock('../../components/archive/ArchiveHealthSection', () => ({
  ArchiveHealthSection: () => <div data-testid="health-section" />,
  cameraStatusOf: () => undefined,
  FUNCTION_STATE_VARIANT: {
    ok: 'success',
    off: 'default',
    warning: 'warning',
    critical: 'danger',
    unknown: 'default',
  },
}))

import { ArchivePage } from '../Archive'

function Search(): ReactElement {
  const { search } = useLocation()
  return <div data-testid="search">{search}</div>
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/archive"
          element={
            <>
              <ArchivePage />
              <Search />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ArchivePage', () => {
  it('opens on the overview, with an Overview and a Cameras section', () => {
    renderAt('/archive')
    expect(screen.getByTestId('section-overview')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('section-cameras')).toBeInTheDocument()
    expect(screen.queryByTestId('archive-camera-section')).not.toBeInTheDocument()
  })

  it('a camera row opens the Cameras section on that camera', () => {
    renderAt('/archive')
    fireEvent.click(screen.getByText('Garden'))
    expect(screen.getByTestId('search')).toHaveTextContent('section=cameras&camera=102')
    expect(screen.getByTestId('review-section')).toHaveTextContent('102')
    expect(screen.getByRole('combobox', { name: 'Camera' })).toHaveValue('102')
  })

  it('the Cameras section has no camera list, and Review is its default view', () => {
    renderAt('/archive?section=cameras&camera=101')
    expect(screen.queryByText('Garden', { selector: 'td *, td' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('review-section')).toHaveTextContent('101')
  })

  it('Health & space carries health, activity and space; Settings the settings', () => {
    renderAt('/archive?section=cameras&camera=101&view=health')
    expect(screen.getByTestId('health-section')).toBeInTheDocument()
    expect(screen.getByTestId('space-section')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.getByTestId('settings-section')).toBeInTheDocument()
    expect(screen.getByTestId('search')).toHaveTextContent('view=settings')
  })

  it('picking another camera in the header keeps the section and replaces the camera', () => {
    renderAt('/archive?section=cameras&camera=101')
    selectOption(screen.getByRole('combobox', { name: 'Camera' }), '102')
    expect(screen.getByTestId('review-section')).toHaveTextContent('102')
  })
})
