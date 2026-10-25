// @vitest-environment jsdom
/**
 * Backup page → Encryption. Opt-in; the secret key is shown ONCE, with a
 * strong "store it safely" warning, and the dialog cannot be dismissed until
 * the operator says it is stored. Replacing the key says old backups still
 * need the old one.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Status {
  enabled: boolean
  active: { keyId: string; publicKey: string; createdAt: number } | null
  keys: Array<{ keyId: string; createdAt: number; retiredAt: number | null }>
}

let status: Status = { enabled: false, active: null, keys: [] }
const setupMutateAsync = vi.fn()
const disableMutateAsync = vi.fn()
const refetch = vi.fn()
const confirm = vi.fn<(opts: { message: string }) => Promise<boolean>>()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useConfirm: () => confirm,
    useBackupGetEncryption: () => ({ data: status, refetch }),
    useBackupSetupEncryption: () => ({ mutateAsync: setupMutateAsync, isPending: false }),
    useBackupDisableEncryption: () => ({ mutateAsync: disableMutateAsync, isPending: false }),
  }
})

import { BackupEncryptionCard } from '../BackupEncryptionCard'

const SECRET = 'camstack-backup-secret-v1:AAAAexampleexampleexampleexampleexampleexample'

describe('BackupEncryptionCard', () => {
  beforeEach(() => {
    status = { enabled: false, active: null, keys: [] }
    setupMutateAsync.mockReset()
    disableMutateAsync.mockReset()
    confirm.mockReset()
    confirm.mockResolvedValue(true)
    setupMutateAsync.mockResolvedValue({
      keyId: '0123456789abcdef',
      secretKey: SECRET,
      publicKey: 'camstack-backup-public-v1:x',
      createdAt: 1,
      replacedKeyId: null,
    })
  })

  it('off by default, with an Enable action', () => {
    render(<BackupEncryptionCard />)
    expect(screen.getByText(/not encrypted/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /enable encryption/i })).toBeTruthy()
  })

  it('enabling shows the secret key once, with a store-it-safely warning, and cannot be closed until confirmed', async () => {
    render(<BackupEncryptionCard />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /enable encryption/i }))
    })
    expect(setupMutateAsync).toHaveBeenCalledWith({})
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(SECRET)
    expect(dialog.textContent).toMatch(/shown only once/i)
    expect(dialog.textContent).toMatch(/cannot be restored/i)
    const done = screen.getByRole('button', { name: /i have stored it/i }) as HTMLButtonElement
    expect(done.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(done.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(done)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('on: shows the key id, and Replace warns that older backups keep needing the old key', async () => {
    status = {
      enabled: true,
      active: { keyId: 'feedfacecafebeef', publicKey: 'p', createdAt: 5 },
      keys: [{ keyId: 'feedfacecafebeef', createdAt: 5, retiredAt: null }],
    }
    render(<BackupEncryptionCard />)
    expect(screen.getByText(/feedfacecafebeef/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /replace key/i }))
    })
    expect(confirm.mock.calls[0]?.[0].message).toMatch(/older backups/i)
    expect(setupMutateAsync).toHaveBeenCalled()
  })

  it('turning it off asks first and calls disable', async () => {
    status = {
      enabled: true,
      active: { keyId: 'feedfacecafebeef', publicKey: 'p', createdAt: 5 },
      keys: [{ keyId: 'feedfacecafebeef', createdAt: 5, retiredAt: null }],
    }
    disableMutateAsync.mockResolvedValue({ disabledKeyId: 'feedfacecafebeef' })
    render(<BackupEncryptionCard />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /turn off/i }))
    })
    expect(confirm).toHaveBeenCalled()
    expect(disableMutateAsync).toHaveBeenCalledWith({})
  })
})
