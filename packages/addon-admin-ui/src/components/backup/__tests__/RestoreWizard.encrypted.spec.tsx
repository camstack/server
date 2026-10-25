// @vitest-environment jsdom
/**
 * Restore asks for the backup key — for an encrypted archive only. A plain
 * archive (made before encryption, or with it off) restores as before.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Archive {
  id: string
  createdAt: number
  sizeBytes: number
  label?: string
  locations: string[]
  encryption?: { scheme: string; keyId: string }
}

let archives: Archive[] = []
const mutate = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useBackupListDestinations: () => ({
      data: [{ id: 'backups:smb', displayName: 'NAS', kind: 'smb', restoreSupported: true }],
    }),
    useBackupListArchives: () => ({ data: archives, isLoading: false }),
    useBackupGetEntries: () => ({ data: { locations: ['config.yaml', 'tls'] } }),
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

async function toConfirmStep(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
  })
}

describe('RestoreWizard — encrypted archives', () => {
  beforeEach(() => {
    mutate.mockReset()
    archives = [
      {
        id: 'enc',
        createdAt: 1,
        sizeBytes: 10,
        locations: ['config.yaml', 'tls'],
        encryption: { scheme: 'x25519-hkdf-aes256gcm-stream-v1', keyId: '0123456789abcdef' },
      },
      { id: 'plain', createdAt: 1, sizeBytes: 10, locations: ['config.yaml', 'tls'] },
    ]
  })

  it('an encrypted archive asks for its key, names the key id, and passes it to restore', async () => {
    open('enc')
    await toConfirmStep()
    expect(document.body.textContent).toContain('0123456789abcdef')
    const submit = screen.getByRole('button', { name: /schedule restore/i }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    const field = screen.getByLabelText(/backup key/i) as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: 'camstack-backup-secret-v1:abc' } })
    expect(submit.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(submit)
    })
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        backupId: 'enc',
        backupSecretKey: 'camstack-backup-secret-v1:abc',
      }),
    )
  })

  it('a plain archive restores without asking for a key', async () => {
    open('plain')
    await toConfirmStep()
    expect(screen.queryByLabelText(/backup key/i)).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /schedule restore/i }))
    })
    const input = mutate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input['backupId']).toBe('plain')
    expect('backupSecretKey' in input).toBe(false)
  })
})
