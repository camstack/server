// @vitest-environment jsdom
/**
 * Identity → Tokens (D892/D895): one table of every token, listed by
 * `auth.listTokens`, created by `auth.mintToken`, revoked by `auth.revokeToken`
 * or a typed-count `auth.revokeCredentials` — no token kinds, no admin-token
 * or share-link surface of its own. A share link is a token whose only scope
 * is a view of some cameras; an admin script's token holds all permissions and
 * needs a fresh re-authentication first.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Token {
  id: string
  subjectId: string
  label: string
  scopes: unknown[]
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
  revokedAt: number | null
}

const NOW = Date.now()
const DAY = 86_400
const bulkMutate = vi.fn()
const promptSpy = vi.fn()
let promptAnswer: string | null = null
const mintMutate = vi.fn()
const revokeMutate = vi.fn()
const invalidateTokens = vi.fn()
const confirmSpy = vi.fn()
let confirmAnswer = true
let isAdmin = true
let tokens: Token[] = []

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  usePrompt: () => async (opts: { validate?: (v: string) => string | null }) => {
    promptSpy(opts)
    return promptAnswer
  },
  useConfirm: () => async (opts: unknown) => {
    confirmSpy(opts)
    return confirmAnswer
  },
  useUserManagementListUsers: () => ({
    data: [
      { id: 'u-admin', username: 'admin' },
      { id: 'u-bob', username: 'bob' },
    ],
  }),
  useDeviceManagerListAll: () => ({
    data: [
      { id: 11, name: 'Front Gate' },
      { id: 12, name: 'Garden' },
    ],
  }),
  // The pickers are specced in the library; here they only have to hand back values.
  ScopePicker: () => <div>scope picker</div>,
  DeviceMultiSelectField: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button type="button" onClick={() => onChange(['11', '12'])}>
      pick cameras
    </button>
  ),
  trpc: {
    useUtils: () => ({
      auth: {
        listTokens: { invalidate: invalidateTokens },
        listAuthAudit: { invalidate: vi.fn() },
      },
    }),
    auth: {
      listTokens: {
        useQuery: () => ({ data: tokens, isLoading: false, isError: false }),
      },
      mintToken: {
        useMutation: (opts: {
          onSuccess?: (r: { token: string; record: { label: string } }) => void
        }) => ({
          mutate: (input: { label: string }) => {
            mintMutate(input)
            opts.onSuccess?.({ token: 'eyJ.SECRET.VALUE', record: { label: input.label } })
          },
          isPending: false,
        }),
      },
      revokeToken: {
        useMutation: (opts: { onSuccess?: () => void }) => ({
          mutate: (input: unknown) => {
            revokeMutate(input)
            opts.onSuccess?.()
          },
          isPending: false,
        }),
      },
      revokeCredentials: {
        useMutation: () => ({
          mutateAsync: async (input: { ids: string[] }) => {
            bulkMutate(input)
            return { revoked: input.ids, skipped: [] }
          },
          isPending: false,
        }),
      },
    },
  },
}))

vi.mock('../../../contexts/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u-admin', username: 'admin', isAdmin, scopes: [] },
  }),
}))

// The prompt itself is specced in ReauthDialog.spec.tsx.
const requestProof = vi.fn(async (): Promise<string | null> => 'proof-1')
vi.mock('../../auth/ReauthDialog', () => ({
  useReauthPrompt: () => ({ requestProof, dialog: null }),
}))

import { TokensSection } from '../TokensSection'

function token(over: Partial<Token> & { id: string }): Token {
  return {
    subjectId: 'u-admin',
    label: `token-${over.id}`,
    scopes: ['*'],
    createdAt: NOW - 86_400_000,
    expiresAt: NOW + 6 * 86_400_000,
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  window.history.replaceState(null, '', window.location.pathname)
  for (const spy of [bulkMutate, promptSpy, mintMutate, revokeMutate, invalidateTokens, confirmSpy])
    spy.mockReset()
  requestProof.mockReset()
  requestProof.mockImplementation(async () => 'proof-1')
  promptAnswer = null
  confirmAnswer = true
  isAdmin = true
  tokens = []
})

async function openCreate(): Promise<void> {
  fireEvent.click(screen.getByTestId('tokens-new'))
  await screen.findByTestId('create-token-dialog')
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('create-token-submit'))
  })
}

describe('TokensSection — one list of tokens, shown by their scopes', () => {
  it('lists label, owner and scopes — never a token kind or a prefix', () => {
    tokens = [
      token({ id: 'ops', label: 'nightly-backup', lastUsedAt: NOW - 60_000 }),
      token({
        id: 'wall',
        subjectId: 'u-bob',
        label: 'kitchen wall',
        scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [11, 99] } }],
        expiresAt: null,
      }),
    ]
    render(<TokensSection />)
    const table = screen.getByTestId('tokens')
    const ops = within(table).getByText('nightly-backup').closest('tr')
    const wall = within(table).getByText('kitchen wall').closest('tr')
    if (ops === null || wall === null) throw new Error('rows not rendered')
    expect(within(ops).getAllByText('All permissions').length).toBeGreaterThan(0)
    expect(within(wall).getByText('Grid view: Front Gate, #99')).toBeTruthy()
    expect(within(wall).getByText('bob')).toBeTruthy()
    expect(table.textContent).not.toMatch(/Scoped token|Admin token|Share link/)
  })

  it('only live tokens are revocable; revoke confirms, then revokes by id', async () => {
    tokens = [
      token({ id: 'live', createdAt: NOW - 1000 }),
      token({ id: 'old', expiresAt: NOW - 1000, createdAt: NOW - 2000 }),
      token({ id: 'gone', revokedAt: NOW - 5000, createdAt: NOW - 3000 }),
    ]
    render(<TokensSection />)
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }))
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(within(rows[1]).queryByRole('button', { name: /^Revoke/ })).toBeNull()
    expect(within(rows[2]).queryByRole('button', { name: /^Revoke/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token-live' }))
    await waitFor(() => expect(revokeMutate).toHaveBeenCalledWith({ id: 'live' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(invalidateTokens).toHaveBeenCalled()
  })

  it('bulk: the typed count and the exact ids go to the hub — and no kind', async () => {
    tokens = [
      token({ id: 'a' }),
      token({ id: 'b', scopes: [{ type: 'addon', target: 'x', access: ['view'] }] }),
    ]
    render(<TokensSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }))
    promptAnswer = '2'
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Revoke 2 tokens/ }))
    })
    expect(bulkMutate).toHaveBeenCalledTimes(1)
    const sent = bulkMutate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(sent).toEqual({ ids: expect.arrayContaining(['a', 'b']), confirmCount: 2 })
    expect(sent).not.toHaveProperty('kind')
  })

  it('all permissions: asks the re-auth proof FIRST, then mints * with it', async () => {
    render(<TokensSection />)
    await openCreate()
    fireEvent.click(screen.getByTestId('token-reach-all'))
    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: 'nightly-backup' } })
    await submit()
    expect(requestProof).toHaveBeenCalledTimes(1)
    expect(mintMutate).toHaveBeenCalledWith({
      scopes: ['*'],
      expiresIn: 30 * DAY,
      label: 'nightly-backup',
      reauthToken: 'proof-1',
    })
    expect(requestProof.mock.invocationCallOrder[0]).toBeLessThan(
      mintMutate.mock.invocationCallOrder[0] ?? 0,
    )
    expect(screen.getByText('eyJ.SECRET.VALUE')).toBeTruthy()
  })

  it('a cancelled proof mints nothing', async () => {
    requestProof.mockImplementation(async () => null)
    render(<TokensSection />)
    await openCreate()
    fireEvent.click(screen.getByTestId('token-reach-all'))
    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: 'nightly-backup' } })
    await submit()
    expect(mintMutate).not.toHaveBeenCalled()
  })

  it('a view link is a token whose only scope is a view of the chosen cameras; only it may never expire', async () => {
    render(<TokensSection />)
    await openCreate()
    const lifetime = (): HTMLSelectElement => {
      const el = screen.getByLabelText(/expires after/i)
      if (!(el instanceof HTMLSelectElement)) throw new Error('not a select')
      return el
    }
    expect([...lifetime().options].map((o) => o.value)).not.toContain('never')
    fireEvent.click(screen.getByTestId('token-reach-view-link'))
    fireEvent.click(screen.getByRole('button', { name: 'pick cameras' }))
    fireEvent.click(screen.getByTestId('token-view-talk'))
    fireEvent.change(lifetime(), { target: { value: 'never' } })
    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: 'kitchen wall' } })
    await submit()
    expect(requestProof).not.toHaveBeenCalled()
    expect(mintMutate).toHaveBeenCalledWith({
      scopes: [
        { type: 'share-view', grant: { kind: 'grid-view', deviceIds: [11, 12], talk: true } },
      ],
      expiresIn: 'never',
      label: 'kitchen wall',
    })
  })

  it('My access lists only the caller’s own tokens, with no bulk revoke', () => {
    isAdmin = false
    tokens = [
      token({ id: 'mine', label: 'mine' }),
      token({ id: 'theirs', label: 'theirs', subjectId: 'u-bob' }),
    ]
    render(<TokensSection ownOnly />)
    expect(screen.getByText('mine')).toBeTruthy()
    expect(screen.queryByText('theirs')).toBeNull()
    expect(screen.queryByRole('button', { name: /select all/i })).toBeNull()
  })
})
