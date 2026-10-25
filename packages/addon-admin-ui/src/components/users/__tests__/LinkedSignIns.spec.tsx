// @vitest-environment jsdom
/**
 * D782 — the profile's "Linked sign-in accounts" and the admin's view of a
 * user's links. The user links (through a hub intent) and unlinks their own;
 * an admin sees and removes, never creates. A link whose provider instance is
 * gone stays listed as unavailable and stays removable.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const beginMutate = vi.fn()
const unlinkOwnMutate = vi.fn()
const adminUnlinkMutate = vi.fn()
const assignMock = vi.fn()
const invalidateOwn = vi.fn()
let providers: Array<{ provider: string; label: string }> = []
let ownLinks: Array<Record<string, unknown>> = []
let userLinks: Array<Record<string, unknown>> = []

vi.mock('@camstack/ui-library', () => ({
  Button: ({ children, onClick }: { children: unknown; onClick: () => void }) => (
    <button onClick={onClick}>{children as string}</button>
  ),
  // ExternalIdentitiesModal moved onto the library Dialog (UI P1).
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? <div role="dialog">{children as never}</div> : null,
  DialogContent: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogHeader: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogTitle: ({ children }: { children: unknown }) => <h2>{children as never}</h2>,
  DialogBody: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogFooter: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  useConfirm: () => async () => true,
  hubPath: (p: string) => p,
  useUserManagementListExternalIdentities: () => ({ data: userLinks, isLoading: false }),
  useUserManagementUnlinkExternalIdentity: () => ({ mutate: adminUnlinkMutate, isPending: false }),
  trpc: {
    useUtils: () => ({
      auth: { listOwnExternalIdentities: { invalidate: invalidateOwn } },
      userManagement: { listExternalIdentities: { invalidate: vi.fn() } },
    }),
    auth: {
      listLinkableProviders: { useQuery: () => ({ data: providers }) },
      listOwnExternalIdentities: { useQuery: () => ({ data: ownLinks }) },
      listLoginMethods: {
        useQuery: () => ({
          data: providers.map((p) => ({
            kind: 'redirect',
            id: p.provider,
            label: p.label,
            startUrl: '/x',
            stage: 'primary',
          })),
        }),
      },
      beginExternalLink: {
        useMutation: (opts: { onSuccess: (r: { url: string }) => void }) => ({
          mutate: (input: unknown) => {
            beginMutate(input)
            opts.onSuccess({ url: '/addon/auth-oidc/authentik/start?link=li_x' })
          },
          isPending: false,
          variables: undefined,
        }),
      },
      unlinkOwnExternalIdentity: {
        useMutation: () => ({ mutate: unlinkOwnMutate, isPending: false }),
      },
    },
  },
}))

// Linking asks for a fresh proof first; the prompt itself is specced on its own.
const requestProof = vi.fn(async (): Promise<string | null> => 'proof-1')
vi.mock('../../auth/ReauthDialog', () => ({
  useReauthPrompt: () => ({ requestProof, dialog: null }),
}))

/** Click, then let the re-auth prompt's promise settle. */
async function clickAndSettle(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
  })
}

import { ExternalIdentitiesModal } from '../ExternalIdentitiesModal'
import { LinkedSignInsSection } from '../LinkedSignInsSection'

const realLocation = window.location
beforeEach(() => {
  beginMutate.mockReset()
  unlinkOwnMutate.mockReset()
  adminUnlinkMutate.mockReset()
  assignMock.mockReset()
  invalidateOwn.mockReset()
  providers = [{ provider: 'auth-oidc/authentik', label: 'Authentik' }]
  ownLinks = []
  userLinks = []
  window.history.replaceState(null, '', '/system/my-access')
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return realLocation.href
      },
      get search() {
        return realLocation.search
      },
      get hash() {
        return realLocation.hash
      },
      get pathname() {
        return realLocation.pathname
      },
      get origin() {
        return realLocation.origin
      },
      assign: (url: string) => assignMock(url),
    },
  })
})

describe('LinkedSignInsSection', () => {
  it('renders nothing when no OIDC provider is configured and nothing is linked', () => {
    providers = []
    const { container } = render(<LinkedSignInsSection />)
    expect(container.innerHTML).toBe('')
  })

  it('"Link Authentik" asks for a proof, then the hub for an intent, and navigates to the provider', async () => {
    render(<LinkedSignInsSection />)
    await clickAndSettle(screen.getByText('Link Authentik'))
    expect(requestProof).toHaveBeenCalled()
    expect(beginMutate).toHaveBeenCalledWith({
      provider: 'auth-oidc/authentik',
      reauthToken: 'proof-1',
    })
    expect(assignMock).toHaveBeenCalledWith('/addon/auth-oidc/authentik/start?link=li_x')
  })

  it('a cancelled proof starts nothing', async () => {
    requestProof.mockResolvedValueOnce(null)
    render(<LinkedSignInsSection />)
    await clickAndSettle(screen.getByText('Link Authentik'))
    expect(beginMutate).not.toHaveBeenCalled()
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('"Link Authentik" runs the provider in a popup and refreshes on its outcome (D791)', async () => {
    const popup = {
      postMessage: vi.fn(),
      closed: false,
      location: { href: '' },
    } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<LinkedSignInsSection />)
    await clickAndSettle(screen.getByText('Link Authentik'))
    // Opened right after the proof (blank), then pointed at the minted start URL.
    expect(open).toHaveBeenCalledWith('about:blank', 'camstack-sso', expect.any(String))
    expect((popup as unknown as { location: { href: string } }).location.href).toBe(
      '/addon/auth-oidc/authentik/start?link=li_x&popup=1',
    )
    expect(assignMock).not.toHaveBeenCalled()
    const event = new Event('message')
    Object.defineProperties(event, {
      data: {
        value: {
          type: 'camstack:sso-return',
          completion: { target: 'profile', query: 'linked=auth-oidc%2Fauthentik' },
        },
      },
      origin: { value: realLocation.origin },
      source: { value: popup },
    })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(screen.getByText(/Linked your Authentik account/)).toBeTruthy()
    expect(popup.postMessage).toHaveBeenCalledWith(
      { type: 'camstack:sso-ack' },
      realLocation.origin,
    )
    open.mockRestore()
  })

  it('a link that finished on ANOTHER hub address: the popup closing refreshes the list and reports the new link', async () => {
    vi.useFakeTimers()
    try {
      const popup = { postMessage: vi.fn(), closed: false, location: { href: '' } }
      const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
      const { rerender } = render(<LinkedSignInsSection />)
      await clickAndSettle(screen.getByText('Link Authentik'))
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(invalidateOwn).not.toHaveBeenCalled()
      // No message can come back from another origin — only the close.
      popup.closed = true
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(invalidateOwn).toHaveBeenCalledTimes(1)
      ownLinks = [
        {
          provider: 'auth-oidc/authentik',
          subject: 's-1',
          label: 'alice@x',
          linkedAt: 0,
          providerLabel: 'Authentik',
          available: true,
        },
      ]
      rerender(<LinkedSignInsSection />)
      expect(screen.getByText(/Linked your Authentik account/)).toBeTruthy()
      open.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists own links, marks an unavailable provider, and unlinks', async () => {
    ownLinks = [
      {
        provider: 'auth-oidc/authentik',
        subject: 's-1',
        label: 'alice@x',
        linkedAt: 0,
        providerLabel: 'Authentik',
        available: true,
      },
      {
        provider: 'auth-oidc/old',
        subject: 's-2',
        linkedAt: 0,
        providerLabel: null,
        available: false,
      },
    ]
    render(<LinkedSignInsSection />)
    expect(screen.queryByText('Link Authentik')).toBeNull()
    expect(screen.getByText('provider unavailable')).toBeTruthy()
    fireEvent.click(screen.getAllByText('Unlink')[1] as HTMLElement)
    await waitFor(() =>
      expect(unlinkOwnMutate).toHaveBeenCalledWith({ provider: 'auth-oidc/old', subject: 's-2' }),
    )
  })

  it('shows the outcome the SSO finish sent back', () => {
    window.history.replaceState(null, '', '/system/my-access?linkError=conflict')
    render(<LinkedSignInsSection />)
    expect(screen.getByText(/already linked to another CamStack user/)).toBeTruthy()
  })
})

describe('ExternalIdentitiesModal (admin)', () => {
  it('lists a user’s links and removes one — no way to create a link', async () => {
    userLinks = [
      { provider: 'auth-oidc/authentik', subject: 's-1', userId: 'u-1', linkedAt: 0 },
      { provider: 'auth-oidc/gone', subject: 's-9', userId: 'u-1', linkedAt: 0 },
    ]
    render(<ExternalIdentitiesModal userId="u-1" username="alice" onClose={vi.fn()} />)
    expect(screen.getByText('Authentik')).toBeTruthy()
    expect(screen.getByText('provider unavailable')).toBeTruthy()
    expect(screen.queryByText(/^Link /)).toBeNull()
    fireEvent.click(screen.getAllByText('Remove')[1] as HTMLElement)
    await waitFor(() =>
      expect(adminUnlinkMutate).toHaveBeenCalledWith({
        userId: 'u-1',
        provider: 'auth-oidc/gone',
        subject: 's-9',
      }),
    )
  })
})
