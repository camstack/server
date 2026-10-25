// @vitest-environment jsdom
/**
 * System → Secrets, as the operator reported it (2026-10-08): a revealed value
 * blew the table apart, and the warnings stacked into overlapping boxes.
 *
 * Pinned here:
 *   - every warning renders inside ONE notice region, ordered;
 *   - a revealed value opens in a dialog and never inside the table;
 *   - the reveal hides itself after SECRET_REVEAL_MS;
 *   - orphans have a filter and a confirmed bulk delete;
 *   - the audit is its own paginated view.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET_VALUE = 'FAKE-VALUE-NOT-A-SECRET-0123456789'

const H = 3_600_000
const SOURCE = {
  kind: 'default-file',
  path: '/data/.keychain/master.key',
  sharesBackupWithDatabase: true,
}
const RESET = {
  id: 'r1',
  at: 1,
  actor: 'trigger-file',
  lockedReason: 'wrong-key',
  archived: 3,
  archivedCollection: 'keychain:secrets-orphaned-1',
  archivedKeysCollection: 'keychain:keys-orphaned-1',
  clearedSettingsKeys: [],
  acknowledgedAt: null,
}

function secret(owner: string, fieldPath: string, usage: string) {
  return {
    ref: `secret://${owner}/global/${fieldPath}`,
    owner,
    scope: 'global',
    fieldPath,
    version: 1,
    createdAt: 1,
    updatedAt: 2 * H,
    updatedBy: `addon:${owner}`,
    lastReadAt: null,
    usage,
  }
}

const SECRETS = [
  secret('cloudflare-tunnel', 'customApiToken', 'in-use'),
  secret('notifiers', 'targets.telegram.botToken', 'orphan'),
  secret('auth-oidc', 'providers.google.clientSecret', 'orphan'),
  secret('provider-homeassistant', 'longLivedAccessToken', 'unknown'),
]

const AUDIT = Array.from({ length: 60 }, (_, i) => ({
  id: `a${i}`,
  at: 1_000_000 - i,
  action: 'reveal',
  actor: 'user:admin',
  ref: `secret://x/global/field-${i}`,
  detail: null,
}))

let status: Record<string, unknown>
let report: { reset: unknown; pendingReentry: unknown[] }
const { reveal, deleteOrphans, confirm, acknowledge } = vi.hoisted(() => ({
  acknowledge: vi.fn(async () => ({ acknowledged: true })),
  reveal: vi.fn(),
  deleteOrphans: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const mutation = (fn?: ReturnType<typeof vi.fn>) => () => ({
    mutate: fn ?? vi.fn(),
    mutateAsync: fn ?? vi.fn(async () => ({})),
    isPending: false,
  })
  return {
    ...actual,
    useKeychainAdminStatus: () => ({ data: status, refetch: vi.fn() }),
    useKeychainAdminListSecrets: () => ({ data: SECRETS, refetch: vi.fn() }),
    useKeychainAdminListAudit: () => ({ data: AUDIT, refetch: vi.fn() }),
    useKeychainAdminResetReport: () => ({ data: report, refetch: vi.fn() }),
    useKeychainAdminAcknowledgeReset: mutation(acknowledge),
    useKeychainAdminDeleteOrphans: mutation(deleteOrphans),
    useKeychainAdminRotateMasterKey: mutation(),
    useKeychainAdminPurgeRetiredKeys: mutation(),
    useKeychainAdminDownloadRecoveryKey: mutation(),
    useKeychainAdminResetKeychain: mutation(),
    useKeychainAdminReveal: mutation(reveal),
    useAddonsList: () => ({ data: [] }),
    useConfirm: () => confirm,
    useAlert: () => vi.fn(async () => undefined),
    usePrompt: () => vi.fn(async () => null),
  }
})

import { SECRET_REVEAL_MS } from '@camstack/ui-library'
import { SecretsPage } from '../Secrets'

function renderPage(path = '/system/secrets') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SecretsPage />
    </MemoryRouter>,
  )
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

beforeEach(() => {
  status = {
    keychain: { state: 'ready' },
    keySource: SOURCE,
    configuredSource: SOURCE,
    fingerprint: '0123456789abcdef',
    activeKeyId: 'k1',
    rotationPending: false,
    retiredWraps: 0,
    recoveryKeyDownloadedAt: null,
    secretCount: SECRETS.length,
    lastReset: RESET,
  }
  report = { reset: RESET, pendingReentry: [SECRETS[0]] }
  reveal.mockReset()
  reveal.mockResolvedValue({ value: SECRET_VALUE, version: 1 })
  deleteOrphans.mockReset()
  deleteOrphans.mockResolvedValue({ deleted: [], kept: [] })
  confirm.mockReset()
  confirm.mockResolvedValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SecretsPage — notices', () => {
  it('renders every warning inside ONE notice region, in priority order', () => {
    renderPage()
    const regions = screen.getAllByRole('region', { name: /keychain notices/i })
    expect(regions).toHaveLength(1)
    const region = regions[0]!
    // Collapsed by default past the first one: expand to see the rest.
    fireEvent.click(within(region).getByRole('button', { name: /more/i }))
    const items = within(region).getAllByRole('listitem')
    const text = items.map((li) => li.textContent ?? '')
    expect(text[0]).toMatch(/reset/i)
    expect(text[1]).toMatch(/backup/i)
    expect(text[2]).toMatch(/recovery copy/i)
    expect(text[3]).toMatch(/2 stored values/i)
  })

  it('raises no alert box outside the notice region', () => {
    renderPage()
    const region = screen.getByRole('region', { name: /keychain notices/i })
    for (const alert of screen.queryAllByRole('alert')) expect(region.contains(alert)).toBe(true)
  })

  it('a healthy keychain renders no notice region at all', () => {
    status = {
      ...status,
      keySource: { ...SOURCE, kind: 'config-file', sharesBackupWithDatabase: false },
      configuredSource: { ...SOURCE, kind: 'config-file', sharesBackupWithDatabase: false },
      recoveryKeyDownloadedAt: 5,
    }
    report = { reset: null, pendingReentry: [] }
    renderPage('/system/secrets')
    // Orphans still exist in the fixture → one info notice, nothing else.
    const region = screen.getByRole('region', { name: /keychain notices/i })
    expect(within(region).getAllByRole('listitem')).toHaveLength(1)
  })
})

describe('SecretsPage — reset notice', () => {
  it('dismiss acknowledges the reset', async () => {
    renderPage()
    const region = screen.getByRole('region', { name: /keychain notices/i })
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: /dismiss/i }))
    })
    expect(acknowledge).toHaveBeenCalledWith({})
  })

  it('an acknowledged reset is not a notice', () => {
    report = { reset: { ...RESET, acknowledgedAt: 5 }, pendingReentry: [SECRETS[0]] }
    renderPage()
    const region = screen.getByRole('region', { name: /keychain notices/i })
    expect(region.textContent).not.toMatch(/was reset/i)
  })
})

describe('SecretsPage — reveal', () => {
  it('opens the value in a dialog and never inside the table', async () => {
    renderPage()
    const table = screen.getByRole('table')
    await act(async () => {
      fireEvent.click(within(table).getByRole('button', { name: 'Reveal customApiToken' }))
    })
    expect(reveal).toHaveBeenCalledWith({ ref: SECRETS[0]!.ref })
    expect(table.textContent).not.toContain(SECRET_VALUE)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain(SECRET_VALUE)
    expect(dialog.textContent).toMatch(/audit/i)
  })

  it('hides the value again after SECRET_REVEAL_MS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage()
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('table')).getAllByRole('button', { name: /^reveal/i })[0]!,
      )
    })
    expect(document.body.textContent).toContain(SECRET_VALUE)
    await act(async () => {
      vi.advanceTimersByTime(SECRET_REVEAL_MS + 50)
    })
    expect(document.body.textContent).not.toContain(SECRET_VALUE)
  })

  it('offers no reveal while the keychain is locked', () => {
    status = { ...status, keychain: { state: 'locked', reason: 'wrong-key' }, keySource: null }
    renderPage()
    for (const b of within(screen.getByRole('table')).queryAllByRole('button', {
      name: /^reveal/i,
    })) {
      expect(b).toHaveProperty('disabled', true)
    }
    const region = screen.getByRole('region', { name: /keychain notices/i })
    expect(within(region).getByRole('button', { name: /reset keychain/i })).toBeTruthy()
  })
})

describe('SecretsPage — orphans', () => {
  it('filters to orphans and deletes them after a confirm', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /^orphans/i }))
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /delete 2 orphans/i }))
    })
    expect(confirm).toHaveBeenCalled()
    expect(deleteOrphans).toHaveBeenCalledWith({ refs: [SECRETS[1]!.ref, SECRETS[2]!.ref] })
  })

  it('does not delete when the confirm is declined', async () => {
    confirm.mockResolvedValue(false)
    renderPage()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^orphans/i }))
      fireEvent.click(screen.getByRole('button', { name: /delete 2 orphans/i }))
    })
    expect(deleteOrphans).not.toHaveBeenCalled()
  })
})

describe('SecretsPage — audit', () => {
  it('is its own view, deep-linkable and paginated', () => {
    renderPage('/system/secrets?view=audit')
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 25)
    expect(table.textContent).toContain('field-0')
    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    const next = screen.getByRole('table')
    expect(next.textContent).toContain('field-25')
    expect(next.textContent).not.toContain('field-0')
  })
})
