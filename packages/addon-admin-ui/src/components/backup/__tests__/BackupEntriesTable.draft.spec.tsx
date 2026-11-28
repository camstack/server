// @vitest-environment jsdom
/**
 * The entries table is ONE draft with ONE Save (planning#675): an enable or retention edit
 * writes nothing until Save, Save re-sends every field of the entry (databases and data sources
 * included), an invalid retention blocks Save, a failed save keeps the draft and says why,
 * Discard restores the served rows, Enter saves and Escape discards.
 */
import { ConfirmDialogProvider } from '@dominevo/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const upsert = vi.hoisted(() => vi.fn())

const ROWS = [
  {
    id: 'e1',
    label: 'Nightly',
    cron: '0 3 * * *',
    enabled: true,
    locationIds: ['backups:default'],
    retentionCount: 7,
    dataSources: ['homekit'],
    databases: ['settings', 'events'],
  },
  {
    id: 'e2',
    label: 'Weekly',
    cron: '0 4 * * 0',
    enabled: true,
    locationIds: ['backups:default'],
    retentionCount: 4,
  },
]

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    useBackupListSchedules: () => ({
      data: ROWS,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useBackupListDestinations: () => ({
      data: [{ id: 'backups:default', displayName: 'Local', restoreSupported: true }],
    }),
    useBackupUpsertSchedule: () => ({ mutateAsync: upsert, isPending: false }),
    useBackupDeleteSchedule: () => ({ mutate: vi.fn() }),
    useBackupTrigger: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

import { BackupEntriesTable } from '../BackupEntriesTable'

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmDialogProvider>
        <BackupEntriesTable onEdit={() => undefined} />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

const retentionOf = (label: string) =>
  screen.getByLabelText(`Retention for ${label}`) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: 'Save' })

afterEach(cleanup)

describe('BackupEntriesTable draft', () => {
  beforeEach(() => {
    upsert.mockReset()
    upsert.mockResolvedValue({})
  })

  it('writes nothing while editing; Save re-sends the whole entry with the edit', async () => {
    mount()
    fireEvent.change(retentionOf('Nightly'), { target: { value: '14' } })
    fireEvent.click(screen.getByLabelText('Enable Weekly'))
    expect(upsert).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenCalledWith({
      id: 'e1',
      label: 'Nightly',
      cron: '0 3 * * *',
      locationIds: ['backups:default'],
      retentionCount: 14,
      enabled: true,
      dataSources: ['homekit'],
      databases: ['settings', 'events'],
    })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e2', enabled: false, retentionCount: 4 }),
    )
  })

  it('an invalid retention blocks Save and names the problem', () => {
    mount()
    fireEvent.change(retentionOf('Nightly'), { target: { value: '0' } })
    expect(screen.getByText(/whole number of at least 1/i)).toBeTruthy()
    fireEvent.click(saveButton())
    expect(upsert).not.toHaveBeenCalled()
  })

  it('a failed save names the error and keeps the draft', async () => {
    upsert.mockRejectedValue(new Error('destination offline'))
    mount()
    fireEvent.change(retentionOf('Nightly'), { target: { value: '14' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('destination offline'),
    )
    expect(retentionOf('Nightly').value).toBe('14')
    expect(saveButton()).toBeTruthy()
  })

  it('Discard restores the served values without a write', () => {
    mount()
    fireEvent.change(retentionOf('Nightly'), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(retentionOf('Nightly').value).toBe('7')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('Enter in the retention input saves, Escape discards', async () => {
    mount()
    fireEvent.change(retentionOf('Nightly'), { target: { value: '14' } })
    fireEvent.keyDown(retentionOf('Nightly'), { key: 'Escape' })
    expect(retentionOf('Nightly').value).toBe('7')
    fireEvent.change(retentionOf('Nightly'), { target: { value: '14' } })
    await act(async () => {
      fireEvent.keyDown(retentionOf('Nightly'), { key: 'Enter' })
    })
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})
