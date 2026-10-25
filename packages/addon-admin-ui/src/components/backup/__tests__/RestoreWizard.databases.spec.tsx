// @vitest-environment jsdom
/**
 * Restore lists the databases the archive carries; a weekly (events + history,
 * snapshots-only) archive says it does NOT touch configuration and is restored
 * whole, with no file-location whitelist.
 */
import type { DataStoreDatabase } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Archive {
  id: string
  createdAt: number
  sizeBytes: number
  locations: string[]
  databases?: DataStoreDatabase[]
}

let archives: Archive[] = []
let manifestLocations: string[] = []
const mutate = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useBackupListDestinations: () => ({
      data: [{ id: 'backups:smb', displayName: 'NAS', kind: 'smb', restoreSupported: true }],
    }),
    useBackupListArchives: () => ({ data: archives, isLoading: false }),
    useBackupGetEntries: () => ({ data: { locations: manifestLocations } }),
    useBackupRestore: () => ({ mutate, isPending: false, error: null }),
  }
})

import { RestoreWizard } from '../RestoreWizard'

function open(archiveId: string): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RestoreWizard
        initialDestinationId="backups:smb"
        initialArchiveId={archiveId}
        onClose={() => undefined}
        onScheduled={() => undefined}
      />
    </QueryClientProvider>,
  )
}

const click = async (name: RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

afterEach(cleanup)

describe('RestoreWizard — databases of the archive', () => {
  beforeEach(() => {
    mutate.mockReset()
    archives = [
      {
        id: 'weekly',
        createdAt: 1,
        sizeBytes: 10,
        locations: [],
        databases: ['events', 'history'],
      },
      {
        id: 'nightly',
        createdAt: 1,
        sizeBytes: 10,
        locations: ['config.yaml'],
        databases: ['settings'],
      },
      { id: 'legacy', createdAt: 1, sizeBytes: 10, locations: ['config.yaml'] },
    ]
  })

  it('a weekly archive states it does not touch configuration and restores without a location list', async () => {
    manifestLocations = []
    open('weekly')
    expect(screen.getByText('Events · History')).toBeTruthy()
    expect(document.body.textContent).toContain('does NOT touch')
    await click(/next/i)
    await click(/schedule restore/i)
    const input = mutate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input['backupId']).toBe('weekly')
    expect('locations' in input).toBe(false)
  })

  it('a nightly archive lists settings and keeps the location picker', async () => {
    manifestLocations = ['config.yaml']
    open('nightly')
    expect(screen.getByText('Settings')).toBeTruthy()
    expect(document.body.textContent).not.toContain('does NOT touch')
    await click(/next/i)
    await click(/schedule restore/i)
    expect(mutate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ locations: ['config.yaml'] }),
    )
  })

  it('a legacy archive (no database list) reads as settings', () => {
    manifestLocations = ['config.yaml']
    open('legacy')
    expect(screen.getByText('Settings')).toBeTruthy()
  })
})
