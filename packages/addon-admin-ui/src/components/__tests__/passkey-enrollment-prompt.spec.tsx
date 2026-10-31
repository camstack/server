// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * PasskeyEnrollmentPrompt visibility contract:
 *   • prompts ONLY for a signed-in user with ZERO enrolled passkeys, a
 *     usable `passkey` arm in `auth.listLoginMethods` (installed +
 *     configured + origin/rpId gate passes), and an installed
 *     enrollment widget (user-passkeys provider present),
 *   • never prompts when a passkey exists anywhere,
 *   • never prompts when the widget (provider) is absent,
 *   • never prompts when no `passkey` arm is contributed at all,
 *   • never prompts when a `passkey` arm exists but fails the
 *     origin/rpId gate (IP-literal hostname, or hostname/rpId mismatch),
 *   • "Not now" persists a per-user dismissal (~30 days, localStorage),
 *   • "Enroll now" mounts the shared enrollment widget inline.
 */

const listOwnPasskeys = vi.fn<() => Promise<readonly unknown[]>>()
let widgetMeta: Record<string, unknown> | null = { id: 'auth-webauthn/passkey-enrollment' }
let authUser: { id: string; username: string; isAdmin: boolean } | null = {
  id: 'u-1',
  username: 'alice',
  isAdmin: false,
}
interface FakeLoginMethod {
  readonly kind: string
  readonly id: string
  readonly stage: string
  readonly rpId?: string
}
// jsdom's default `window.location.hostname` is `localhost` — an rpId
// equal to it passes the origin gate with no need to stub `window.location`.
let loginMethods: readonly FakeLoginMethod[] = [
  { kind: 'passkey', id: 'passkey-direct-login', stage: 'primary', rpId: 'localhost' },
]

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useSystem: () => ({ listOwnPasskeys }),
    useWidgetMetadata: () => widgetMeta,
    WidgetSlot: ({ widgetId }: { widgetId: string }) => (
      <div data-testid="widget-slot">{widgetId}</div>
    ),
    trpc: {
      auth: {
        listLoginMethods: {
          useQuery: () => ({ data: loginMethods }),
        },
      },
    },
  }
})

vi.mock('../../contexts/auth-context', () => ({
  useAuth: () => ({ user: authUser }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

import { PasskeyEnrollmentPrompt } from '../system/PasskeyEnrollmentPrompt'

function renderPrompt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <PasskeyEnrollmentPrompt />
    </QueryClientProvider>,
  )
}

const DISMISS_KEY = 'camstack_passkey_prompt_dismissed:u-1'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  widgetMeta = { id: 'auth-webauthn/passkey-enrollment' }
  authUser = { id: 'u-1', username: 'alice', isAdmin: false }
  loginMethods = [
    { kind: 'passkey', id: 'passkey-direct-login', stage: 'primary', rpId: 'localhost' },
  ]
  listOwnPasskeys.mockResolvedValue([])
})

describe('PasskeyEnrollmentPrompt', () => {
  it('prompts a signed-in user with zero passkeys', async () => {
    renderPrompt()
    expect(await screen.findByText('Save a passkey for faster sign-in?')).toBeTruthy()
  })

  it('never prompts when the user already has a passkey (anywhere)', async () => {
    listOwnPasskeys.mockResolvedValue([{ credentialId: 'cred-1' }])
    renderPrompt()
    await waitFor(() => expect(listOwnPasskeys).toHaveBeenCalled())
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
  })

  it('never prompts when no enrollment widget (provider) is installed', async () => {
    widgetMeta = null
    renderPrompt()
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
    expect(listOwnPasskeys).not.toHaveBeenCalled()
  })

  it('never prompts when no `passkey` arm exists in listLoginMethods (provider not installed/configured)', async () => {
    loginMethods = [{ kind: 'redirect', id: 'oidc', stage: 'primary' }]
    renderPrompt()
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
    expect(listOwnPasskeys).not.toHaveBeenCalled()
  })

  it('never prompts when the `passkey` arm exists but fails the origin/rpId gate (hostname mismatch)', async () => {
    loginMethods = [
      {
        kind: 'passkey',
        id: 'passkey-direct-login',
        stage: 'primary',
        rpId: 'other-host.example.com',
      },
    ]
    renderPrompt()
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
    expect(listOwnPasskeys).not.toHaveBeenCalled()
  })

  it('never prompts when the `passkey` arm exists but has an unconfigured (empty) rpId', async () => {
    loginMethods = [{ kind: 'passkey', id: 'passkey-direct-login', stage: 'primary', rpId: '' }]
    renderPrompt()
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
    expect(listOwnPasskeys).not.toHaveBeenCalled()
  })

  it('is visible when the origin/rpId gate passes + zero passkeys + not dismissed', async () => {
    renderPrompt()
    expect(await screen.findByText('Save a passkey for faster sign-in?')).toBeTruthy()
  })

  it('never prompts while the passkey list is still loading', () => {
    listOwnPasskeys.mockReturnValue(new Promise(() => undefined))
    renderPrompt()
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
  })

  it('"Not now" hides the prompt and persists a per-user dismissal', async () => {
    renderPrompt()
    fireEvent.click(await screen.findByText('Not now'))
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
    expect(localStorage.getItem(DISMISS_KEY)).toBeTruthy()
  })

  it('stays hidden on a fresh mount while the dismissal is recent', async () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    renderPrompt()
    await Promise.resolve()
    expect(screen.queryByText('Save a passkey for faster sign-in?')).toBeNull()
  })

  it('re-prompts once the dismissal is older than ~30 days', async () => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000
    localStorage.setItem(DISMISS_KEY, String(thirtyOneDaysAgo))
    renderPrompt()
    expect(await screen.findByText('Save a passkey for faster sign-in?')).toBeTruthy()
  })

  it('"Enroll now" mounts the shared enrollment widget inline', async () => {
    renderPrompt()
    fireEvent.click(await screen.findByText('Enroll now'))
    expect(screen.getByTestId('widget-slot').textContent).toBe('auth-webauthn/passkey-enrollment')
  })
})
