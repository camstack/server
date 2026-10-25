// @vitest-environment jsdom
/**
 * Login sessions (`auth.listOwnSessions` / `auth.revokeOwnSession` /
 * `auth.logout({ everywhere })`, and the admin's `auth.listSessions` /
 * `auth.revokeSessions`).
 *
 * One list, two owners: My access lists the caller's own sessions; the Users
 * page opens a user's sessions for an admin. The session this browser is
 * using is marked and never offered a per-row sign-out — signing out of it is
 * the page's own Sign out.
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

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const revokeOwnMutate = vi.fn()
const logoutMutate = vi.fn()
const adminRevokeMutate = vi.fn()
const invalidateOwn = vi.fn()
const invalidateAdmin = vi.fn()
const contextLogout = vi.fn()
const confirmSpy = vi.fn()
const listSessionsInputs: unknown[] = []
let confirmAnswer = true
let ownSessions: Session[] = []
let userSessions: Session[] = []

vi.mock('@camstack/ui-library', () => ({
  Button: ({ children, onClick }: { children: unknown; onClick: () => void }) => (
    <button onClick={onClick}>{children as string}</button>
  ),
  // UserSessionsModal moved onto the library Dialog (UI P1); the mock must
  // still render children when open so the session list assertions hold.
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? <div role="dialog">{children as never}</div> : null,
  DialogContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogHeader: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogTitle: ({ children }: { children: unknown }) => <h2>{children as never}</h2>,
  DialogBody: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogFooter: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  useConfirm: () => async (opts: unknown) => {
    confirmSpy(opts)
    return confirmAnswer
  },
  trpc: {
    useUtils: () => ({
      auth: {
        listOwnSessions: { invalidate: invalidateOwn },
        listSessions: { invalidate: invalidateAdmin },
      },
    }),
    auth: {
      listOwnSessions: {
        useQuery: () => ({ data: ownSessions, isLoading: false, isError: false }),
      },
      listSessions: {
        useQuery: (input: unknown) => {
          listSessionsInputs.push(input)
          return { data: userSessions, isLoading: false, isError: false }
        },
      },
      revokeOwnSession: {
        useMutation: (opts: { onSuccess?: () => void }) => ({
          mutate: (input: unknown) => {
            revokeOwnMutate(input)
            opts.onSuccess?.()
          },
          isPending: false,
          variables: undefined,
        }),
      },
      revokeSessions: {
        useMutation: (opts: { onSuccess?: (r: unknown, input: unknown) => void }) => ({
          mutate: (input: unknown) => {
            adminRevokeMutate(input)
            opts.onSuccess?.({ revoked: 1 }, input)
          },
          isPending: false,
          variables: undefined,
        }),
      },
      logout: {
        useMutation: (opts: { onSuccess?: () => void }) => ({
          mutate: (input: unknown) => {
            logoutMutate(input)
            opts.onSuccess?.()
          },
          isPending: false,
        }),
      },
    },
  },
}))

vi.mock('../../../contexts/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u-admin', username: 'admin', isAdmin: true, scopes: [] },
    logout: contextLogout,
  }),
}))

import { MySessionsSection } from '../MySessionsSection'
import { UserSessionsModal } from '../../users/UserSessionsModal'

const NOW = Date.now()

function session(over: Partial<Session> & { id: string }): Session {
  return {
    userId: 'u-admin',
    method: 'password',
    refreshable: true,
    createdAt: NOW - 86_400_000,
    lastUsedAt: NOW - 60_000,
    expiresAt: NOW + 7 * 86_400_000,
    client: CHROME_MAC,
    ip: '192.168.1.20',
    current: false,
    ...over,
  }
}

beforeEach(() => {
  revokeOwnMutate.mockReset()
  logoutMutate.mockReset()
  adminRevokeMutate.mockReset()
  invalidateOwn.mockReset()
  invalidateAdmin.mockReset()
  contextLogout.mockReset()
  confirmSpy.mockReset()
  listSessionsInputs.length = 0
  confirmAnswer = true
  ownSessions = []
  userSessions = []
})

describe('MySessionsSection', () => {
  it('renders one row per session: device label, method, IP; the current one is marked', () => {
    ownSessions = [
      session({ id: 's-this', current: true }),
      session({ id: 's-phone', client: SAFARI_IPHONE, method: 'passkey', ip: '10.0.0.7' }),
    ]
    render(<MySessionsSection />)
    const rows = screen.getAllByTestId('session-row')
    expect(rows).toHaveLength(2)

    const first = within(rows[0])
    expect(first.getByText('Chrome on macOS')).toBeTruthy()
    expect(first.getByText(/this device/i)).toBeTruthy()
    expect(first.getByText(/Password/)).toBeTruthy()
    expect(first.getByText(/192\.168\.1\.20/)).toBeTruthy()

    const second = within(rows[1])
    expect(second.getByText('Safari on iPhone')).toBeTruthy()
    expect(second.queryByText(/this device/i)).toBeNull()
    expect(second.getByText(/Passkey/)).toBeTruthy()
    expect(second.getByText(/10\.0\.0\.7/)).toBeTruthy()
  })

  it('the current session has no Sign out button', () => {
    ownSessions = [session({ id: 's-this', current: true }), session({ id: 's-other' })]
    render(<MySessionsSection />)
    const rows = screen.getAllByTestId('session-row')
    expect(within(rows[0]).queryByRole('button', { name: /^sign out$/i })).toBeNull()
    expect(within(rows[1]).getByRole('button', { name: /^sign out$/i })).toBeTruthy()
  })

  it('signing out another session calls the mutation and refreshes the list', async () => {
    ownSessions = [session({ id: 's-this', current: true }), session({ id: 's-other' })]
    render(<MySessionsSection />)
    const rows = screen.getAllByTestId('session-row')
    fireEvent.click(within(rows[1]).getByRole('button', { name: /^sign out$/i }))
    await waitFor(() => expect(revokeOwnMutate).toHaveBeenCalledWith({ id: 's-other' }))
    expect(invalidateOwn).toHaveBeenCalled()
  })

  it('sign out everywhere confirms (this browser too), then ends every session and logs out', async () => {
    ownSessions = [session({ id: 's-this', current: true })]
    render(<MySessionsSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }))
    })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const opts = confirmSpy.mock.calls[0]?.[0] as { message: string }
    expect(opts.message).toMatch(/this browser/i)
    expect(logoutMutate).toHaveBeenCalledWith({ everywhere: true })
    expect(contextLogout).toHaveBeenCalledTimes(1)
  })

  it('a declined sign-out-everywhere does nothing', async () => {
    confirmAnswer = false
    ownSessions = [session({ id: 's-this', current: true })]
    render(<MySessionsSection />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }))
    })
    expect(logoutMutate).not.toHaveBeenCalled()
    expect(contextLogout).not.toHaveBeenCalled()
  })
})

describe('UserSessionsModal (admin)', () => {
  it("lists the user's sessions and signs one out", async () => {
    userSessions = [
      session({ id: 's-a', userId: 'u-bob' }),
      session({ id: 's-b', userId: 'u-bob', client: SAFARI_IPHONE }),
    ]
    render(<UserSessionsModal userId="u-bob" username="bob" onClose={() => {}} />)
    expect(listSessionsInputs).toContainEqual({ userId: 'u-bob' })
    const rows = screen.getAllByTestId('session-row')
    expect(rows).toHaveLength(2)
    fireEvent.click(within(rows[1]).getByRole('button', { name: /^sign out$/i }))
    await waitFor(() => expect(adminRevokeMutate).toHaveBeenCalledWith({ id: 's-b' }))
    expect(invalidateAdmin).toHaveBeenCalled()
  })

  it('sign out everywhere ends every session of that user after a confirm', async () => {
    userSessions = [session({ id: 's-a', userId: 'u-bob' })]
    render(<UserSessionsModal userId="u-bob" username="bob" onClose={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }))
    })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(adminRevokeMutate).toHaveBeenCalledWith({ userId: 'u-bob' })
    // Someone else's sessions: the admin stays signed in.
    expect(contextLogout).not.toHaveBeenCalled()
  })

  it("signing out everywhere on the admin's OWN account logs this browser out too", async () => {
    userSessions = [session({ id: 's-this', current: true })]
    render(<UserSessionsModal userId="u-admin" username="admin" onClose={() => {}} />)
    // The admin's current session is marked and not revocable here either.
    expect(within(screen.getByTestId('session-row')).getByText(/this device/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^sign out$/i })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }))
    })
    const opts = confirmSpy.mock.calls[0]?.[0] as { message: string }
    expect(opts.message).toMatch(/this browser/i)
    expect(adminRevokeMutate).toHaveBeenCalledWith({ userId: 'u-admin' })
    expect(contextLogout).toHaveBeenCalledTimes(1)
  })

  it('an empty list says so', () => {
    render(<UserSessionsModal userId="u-bob" username="bob" onClose={() => {}} />)
    expect(screen.queryAllByTestId('session-row')).toHaveLength(0)
    expect(screen.getByText(/no active sessions/i)).toBeTruthy()
  })
})
