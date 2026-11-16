/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { CameraRow } from '../../components/archive/camera-rows'

expect.extend(jestDomMatchers)

const ROWS: readonly CameraRow[] = [
  {
    deviceId: 101,
    name: 'Front door',
    mode: 'continuous',
    state: 'recording',
    warnings: 0,
    footageBytes: 10,
    oldestMs: null,
    eventRows: 1,
    eventBytes: 1,
  },
]

vi.mock('../../components/archive/use-archive-data', () => ({
  useArchiveData: () => ({ cameras: [], rows: ROWS, isLoading: false, totals: {} }),
}))
vi.mock('../../components/archive/ArchiveKeyNumbers', () => ({ ArchiveKeyNumbers: () => <div /> }))
vi.mock('../../components/archive/ArchiveStorageCards', () => ({
  ArchiveStorageCards: () => <div />,
}))
vi.mock('../../components/archive/ArchiveActivity', () => ({ ArchiveActivity: () => <div /> }))
vi.mock('../../components/archive/ArchiveTools', () => ({ ArchiveTools: () => <div /> }))

import { ArchivePage } from '../Archive'

describe('ArchivePage', () => {
  it('a camera row opens that camera page', () => {
    render(
      <MemoryRouter initialEntries={['/archive']}>
        <Routes>
          <Route path="/archive" element={<ArchivePage />} />
          <Route path="/archive/:deviceId" element={<div data-testid="camera-page" />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('Front door'))
    expect(screen.getByTestId('camera-page')).toBeInTheDocument()
  })
})
