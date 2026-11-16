/// <reference types="@testing-library/jest-dom" />

import { selectOption } from '@camstack/ui-library/testing'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraRow } from '../camera-rows'
import type { ArchiveData } from '../use-archive-data'

expect.extend(jestDomMatchers)

const confirm = vi.fn<() => Promise<boolean>>()
const prune = vi.fn()
const removeFootage = vi.fn()
const removeEvents = vi.fn()
const idle = { isPending: false }

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useConfirm: () => confirm,
  useRecordingArchivePruneFootage: () => ({ ...idle, mutate: prune }),
  useRecordingArchiveDeleteFootprint: () => ({ ...idle, mutate: removeFootage }),
  usePipelineAnalyticsDeleteDeviceEvents: () => ({ ...idle, mutate: removeEvents }),
  useStorageListLocations: () => ({
    data: [
      { id: 'old', type: 'recordings', displayName: 'Old', mode: 'readonly' },
      { id: 'new', type: 'recordings', displayName: 'New', mode: 'active' },
    ],
  }),
}))

import { ArchiveSpaceSection } from '../ArchiveSpaceSection'

const ROW: CameraRow = {
  deviceId: 101,
  name: 'Front door',
  mode: 'continuous',
  state: 'recording',
  warnings: 0,
  footageBytes: 1024,
  oldestMs: null,
  eventRows: 3,
  eventBytes: 2048,
}
const DATA = {
  cameras: [],
  rows: [ROW],
  usage: {
    locations: [
      { locationId: 'old', devices: [{ deviceId: 101, bytes: 1 }] },
      { locationId: 'new', devices: [] },
    ],
  },
} as unknown as ArchiveData

function renderSection(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ArchiveSpaceSection data={DATA} row={ROW} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ArchiveSpaceSection danger zone', () => {
  it.each([
    ['Apply retention now', prune],
    ['Delete footage', removeFootage],
    ['Delete events', removeEvents],
  ])('%s asks first and calls nothing when declined', async (label, mutate) => {
    confirm.mockResolvedValue(false)
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(mutate).not.toHaveBeenCalled()
  })

  it('prune uses the picked reason once confirmed', async () => {
    confirm.mockResolvedValue(true)
    renderSection()
    selectOption(screen.getByLabelText('Prune reason'), 'quota')
    fireEvent.click(screen.getByRole('button', { name: 'Apply retention now' }))
    await waitFor(() => expect(prune).toHaveBeenCalledWith({ deviceId: 101, reason: 'quota' }))
  })

  it('delete footage and delete events run after the confirm', async () => {
    confirm.mockResolvedValue(true)
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Delete footage' }))
    await waitFor(() => expect(removeFootage).toHaveBeenCalledWith({ deviceId: 101 }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete events' }))
    await waitFor(() => expect(removeEvents).toHaveBeenCalledWith({ deviceId: 101 }))
  })
})
