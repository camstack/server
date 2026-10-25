// @vitest-environment jsdom
/**
 * The schedule editor writes `databases`: a new entry carries settings, an
 * existing row without a list opens as settings, and ticking events adds it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useBackupListDestinations: () => ({
      data: [{ id: 'backups:default', displayName: 'Local', kind: 'local' }],
      isLoading: false,
    }),
    useBackupListAvailableDatabases: () => ({
      data: { answered: true, databases: ['settings', 'events'] },
    }),
    useBackupUpsertSchedule: () => ({ mutate, isPending: false, error: null }),
    useBackupPreviewSchedule: () => ({ data: undefined, isLoading: false }),
  }
})

import { BackupEntryModal } from '../BackupEntryModal'

function open(entry: Parameters<typeof BackupEntryModal>[0]['entry']): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BackupEntryModal entry={entry} onClose={() => undefined} onSaved={() => undefined} />
    </QueryClientProvider>,
  )
}

const saveWith = async (): Promise<Record<string, unknown>> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /create entry|save/i }))
  })
  return mutate.mock.calls[0]?.[0] as Record<string, unknown>
}

afterEach(cleanup)

describe('BackupEntryModal — what to back up', () => {
  beforeEach(() => mutate.mockReset())

  it('a new entry defaults to settings and saves it', async () => {
    open(null)
    expect(
      (screen.getByTestId('backup-entry-databases-settings') as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.change(screen.getByTestId('backup-entry-name'), { target: { value: 'Nightly' } })
    fireEvent.click(screen.getByText('Local'))
    expect((await saveWith())['databases']).toEqual(['settings'])
  })

  it('an existing row with no list opens as settings; ticking events saves both', async () => {
    open({
      id: 'e1',
      label: 'Nightly',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:default'],
      retentionCount: 7,
    })
    expect(
      (screen.getByTestId('backup-entry-databases-settings') as HTMLInputElement).checked,
    ).toBe(true)
    fireEvent.click(screen.getByTestId('backup-entry-databases-events'))
    expect((await saveWith())['databases']).toEqual(['settings', 'events'])
  })

  it('cannot save with nothing selected', () => {
    open({
      id: 'e2',
      label: 'Weekly',
      cron: '0 4 * * 0',
      enabled: true,
      locationIds: ['backups:default'],
      retentionCount: 4,
      databases: ['events'],
    })
    fireEvent.click(screen.getByTestId('backup-entry-databases-events'))
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})
