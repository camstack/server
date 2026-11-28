/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { DeviceType } from '@dominevo/types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CameraRow } from '../../components/archive/camera-rows'
import { withDeviceSearchHub, type SearchHubDevice } from '../../test-setup/device-search-hub'
import '../../i18n'

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
// The REAL camera picker over a fake search hub: a light sits in the fleet to prove it is left out.
const FLEET: readonly SearchHubDevice[] = [
  { id: 101, name: 'Front door', type: DeviceType.Camera },
  { id: 102, name: 'Garden', type: DeviceType.Camera },
  { id: 103, name: 'Porch light', type: DeviceType.Light },
]
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
    withDeviceSearchHub(
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
      FLEET,
    ),
  )
}

describe('ArchivePage', () => {
  it('opens on the overview, with an Overview and a Cameras section', () => {
    renderAt('/archive')
    expect(screen.getByTestId('section-overview')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('section-cameras')).toBeInTheDocument()
    expect(screen.queryByTestId('archive-camera-section')).not.toBeInTheDocument()
  })

  it('a camera row opens the Cameras section on that camera', async () => {
    renderAt('/archive')
    fireEvent.click(screen.getByText('Garden'))
    expect(screen.getByTestId('search')).toHaveTextContent('section=cameras&camera=102')
    expect(screen.getByTestId('review-section')).toHaveTextContent('102')
    // The picker names the camera it holds, not its id.
    await waitFor(() => expect(screen.getByTestId('archive-camera')).toHaveTextContent('Garden'))
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

  it('the header picker names the camera, offers cameras only, and picking one replaces the camera', async () => {
    renderAt('/archive?section=cameras&camera=101')
    const picker = screen.getByTestId('archive-camera')
    await waitFor(() => expect(picker).toHaveTextContent('Front door'))

    fireEvent.click(within(picker).getAllByRole('button')[0])
    const garden = await screen.findByRole('option', { name: /Garden/ })
    expect(screen.queryByRole('option', { name: /Porch light/ })).toBeNull()

    fireEvent.click(garden)
    expect(screen.getByTestId('review-section')).toHaveTextContent('102')
  })
})
