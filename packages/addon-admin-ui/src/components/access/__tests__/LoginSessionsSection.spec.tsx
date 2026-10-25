// @vitest-environment jsdom
/**
 * Login sessions on Identity → Tokens & sessions. The caller's own current
 * session is marked, has no Sign out and can never be selected for a bulk
 * sign-out — not one by one, not through "Select all shown".
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Session {
  id: string
  userId: string
  method: string
  refreshable: boolean
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  client: string | null
  ip: string | null
  current: boolean
}

const NOW = Date.now()
const revokeMutate = vi.fn()
const bulkMutate = vi.fn()
let promptAnswer: string | null = null
let sessions: Session[] = []

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useConfirm: () => async () => true,
  usePrompt: () => async () => promptAnswer,
  useUserManagementListUsers: () => ({
    data: [
      { id: 'u-root', username: 'root' },
      { id: 'u-alice', username: 'alice' },
    ],
  }),
  trpc: {
    useUtils: () => ({ auth: { listSessions: { invalidate: vi.fn() } } }),
    auth: {
      listSessions: {
        useQuery: () => ({ data: sessions, isLoading: false, isError: false }),
      },
      revokeSessions: {
        useMutation: () => ({
          mutate: revokeMutate,
          isPending: false,
          variables: undefined,
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

import { LoginSessionsSection } from '../LoginSessionsSection'

function session(over: Partial<Session> & { id: string }): Session {
  return {
    userId: 'u-root',
    method: 'password',
    refreshable: true,
    createdAt: NOW - 60_000,
    lastUsedAt: NOW - 1000,
    expiresAt: NOW + 3_600_000,
    client:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    ip: '192.168.1.20',
    current: false,
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
  revokeMutate.mockReset()
  bulkMutate.mockReset()
  promptAnswer = null
  sessions = []
})

describe('LoginSessionsSection', () => {
  it('marks the current session; it has no Sign out and no checkbox', () => {
    sessions = [
      session({ id: 'here', current: true, createdAt: NOW - 1 }),
      session({ id: 'other', userId: 'u-alice', createdAt: NOW - 2 }),
    ]
    render(<LoginSessionsSection />)
    const [here, other] = screen.getAllByRole('row').slice(1)
    if (here === undefined || other === undefined) throw new Error('rows missing')
    expect(within(here).getByText('This session')).toBeTruthy()
    expect(within(here).queryByRole('checkbox')).toBeNull()
    expect(within(here).queryByRole('button', { name: /sign out/i })).toBeNull()
    expect(within(other).getByText('alice')).toBeTruthy()
    expect(within(other).getByText('Safari on macOS')).toBeTruthy()
    expect(within(other).getByRole('button', { name: /sign out/i })).toBeTruthy()
  })

  it('"Select all shown" never includes the current session', async () => {
    sessions = [
      session({ id: 'here', current: true }),
      session({ id: 'a', userId: 'u-alice' }),
      session({ id: 'b', userId: 'u-alice' }),
    ]
    render(<LoginSessionsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }))
    promptAnswer = '2'
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke 2 sessions…' }))
    })
    const sent = bulkMutate.mock.calls[0]?.[0] as { kind?: string; ids: string[] }
    // Revocation is by credential id (D892): the hub finds each id itself.
    expect(sent.kind).toBeUndefined()
    expect(sent.ids.toSorted()).toEqual(['a', 'b'])
  })

  it('signs out one session by id', async () => {
    sessions = [session({ id: 'a', userId: 'u-alice' })]
    render(<LoginSessionsSection />)
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(revokeMutate).toHaveBeenCalledWith({ id: 'a' }))
  })
})
