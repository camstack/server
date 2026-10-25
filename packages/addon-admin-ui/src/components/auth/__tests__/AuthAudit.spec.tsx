// @vitest-environment jsdom
/**
 * The auth audit trail (`auth.listAuthAudit`) on Identity → Tokens & sessions →
 * Audit. Admin-only on the hub: a non-admin never mounts it, so never sends
 * the read. A record that carries only a token id is named from the token
 * list (`auth.listTokens`).
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface AuditRecord {
  id: string
  at: number
  action: string
  userId?: string
  ip?: string
  detail?: Record<string, string | number | boolean>
}

const NOW = Date.now()
const auditInputs: unknown[] = []
let isAdmin = true
let tokens: { id: string; label: string }[] = []
let audit: AuditRecord[] = []

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useUserManagementListUsers: () => ({
    data: [
      { id: 'u-admin', username: 'admin' },
      { id: 'u-bob', username: 'bob' },
    ],
  }),
  trpc: {
    auth: {
      listTokens: {
        useQuery: () => ({ data: tokens, isLoading: false, isError: false }),
      },
      listAuthAudit: {
        useQuery: (input: unknown) => {
          auditInputs.push(input)
          return { data: audit, isLoading: false, isError: false }
        },
      },
    },
  },
}))

vi.mock('../../../contexts/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u-admin', username: 'admin', isAdmin, scopes: [] },
  }),
}))

import { AuthAuditSection } from '../AuthAuditSection'

beforeEach(() => {
  auditInputs.length = 0
  isAdmin = true
  tokens = []
  audit = []
})

describe('AuthAuditSection', () => {
  it('words each action with the user, IP and details', () => {
    tokens = [{ id: 'at-1', label: 'nightly-backup' }]
    audit = [
      {
        id: 'a1',
        at: NOW - 1000,
        action: 'admin-token-used',
        userId: 'u-admin',
        ip: '10.0.0.5',
        detail: {
          tokenId: 'at-1',
          name: 'nightly-backup',
          prefix: 'tok_abcd',
          path: 'devices.list',
        },
      },
      {
        id: 'a2',
        at: NOW - 2000,
        action: 'admin-token-created',
        userId: 'u-admin',
        detail: { tokenId: 'at-1', name: 'nightly-backup', prefix: 'tok_abcd' },
      },
      {
        id: 'a3',
        at: NOW - 3000,
        action: 'admin-token-revoked',
        userId: 'u-bob',
        detail: { tokenId: 'at-1' },
      },
      {
        id: 'a4',
        at: NOW - 4000,
        action: 'second-factor-skipped',
        userId: 'u-bob',
        ip: '192.0.2.10',
        detail: { method: 'password', factors: 'totp,passkey' },
      },
      { id: 'a5', at: NOW - 5000, action: 'something-new' },
    ]
    render(<AuthAuditSection />)
    expect(auditInputs).toContainEqual({ limit: 100 })
    const rows = screen.getAllByTestId('auth-audit-row')
    expect(rows).toHaveLength(5)

    const used = within(rows[0])
    expect(used.getByText(/admin token "nightly-backup" used/i)).toBeTruthy()
    expect(used.getByText(/devices\.list/)).toBeTruthy()
    expect(used.getByText(/tok_abcd/)).toBeTruthy()
    expect(used.getByText('admin')).toBeTruthy()
    expect(used.getByText(/10\.0\.0\.5/)).toBeTruthy()

    expect(within(rows[1]).getByText(/admin token "nightly-backup" created/i)).toBeTruthy()
    // The revoke record carries only the id; the name comes from the token list.
    expect(within(rows[2]).getByText(/admin token "nightly-backup" revoked/i)).toBeTruthy()
    expect(within(rows[2]).getByText('bob')).toBeTruthy()

    const skipped = within(rows[3])
    expect(skipped.getByText(/second factor skipped/i)).toBeTruthy()
    expect(skipped.getByText(/totp, passkey/i)).toBeTruthy()
    expect(skipped.getByText(/password/i)).toBeTruthy()

    expect(within(rows[4]).getByText('something-new')).toBeTruthy()
  })

  it('an empty trail says so', () => {
    render(<AuthAuditSection />)
    expect(screen.getByText(/no authentication events/i)).toBeTruthy()
  })

  it('is not rendered for a non-admin, and never reads the trail', () => {
    isAdmin = false
    const { container } = render(<AuthAuditSection />)
    expect(container.innerHTML).toBe('')
    expect(auditInputs).toHaveLength(0)
  })
})
