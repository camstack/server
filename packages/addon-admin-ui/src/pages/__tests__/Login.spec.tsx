/**
 * LoginPage native-handoff regression suite (viewer "Sign in with CamStack").
 *
 * The killer race this pins down: after an INTERACTIVE login (password /
 * TOTP / passkey) the submit handler AND the already-authenticated
 * auto-forward effect both call `goNext` — the parked redirect is one-shot,
 * so the losing caller used to find nothing parked and
 * `navigate(restorePath)`, yanking the SPA to the dashboard and unmounting
 * the handoff interstitial mid-mint (the operator-reproduced "sheet never
 * bounces back to the app" bug — an already-active session worked because
 * only one caller ran). `goNext` is now single-flight per page instance and
 * resolves the target from the parked value OR the live `?redirect` param.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

interface MockAuthUser {
  id: string
  username: string
  isAdmin: boolean
  exp: number
  scopes: readonly never[]
}

let mockUser: MockAuthUser | null = null
const loginMethodsOptions: unknown[] = []
let loginMethodsFail = false
const OIDC_METHODS = [
  {
    kind: 'redirect',
    id: 'auth-oidc/authentik',
    label: 'Authentik',
    startUrl: '/addon/auth-oidc/authentik/start',
    stage: 'primary',
  },
]
function loginMethodsAnswer(): { data: unknown; isError: boolean; isPending: boolean } {
  return loginMethodsFail
    ? { data: undefined, isError: true, isPending: false }
    : { data: OIDC_METHODS, isError: false, isPending: false }
}
const loginMock = vi.fn()
const navigateMock = vi.fn()
const mintMock = vi.fn()
const assignMock = vi.fn()
const finalizeMock = vi.fn()
/** `location.state` as ProtectedRoute leaves it (`{ from }`), per test. */
let routerState: { from?: string } | null = null

// jsdom refuses a real navigation ("Not implemented: navigation"), and every
// leg that leaves the SPA — the `next` bounce, the native handoff — IS a
// full-page assign. Swap `window.location` for a shim that still reads the
// live document URL (so `history.replaceState` stays the way tests set it)
// but records the assign target instead of navigating.
const realLocation = window.location
Object.defineProperty(window, 'location', {
  configurable: true,
  value: {
    get href(): string {
      return realLocation.href
    },
    get search(): string {
      return realLocation.search
    },
    get hash(): string {
      return realLocation.hash
    },
    get pathname(): string {
      return realLocation.pathname
    },
    get origin(): string {
      return realLocation.origin
    },
    assign: (url: string): void => assignMock(url),
  },
})

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ state: routerState }),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  const { default: realI18n } = await import('../../i18n/index')
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: string | Record<string, unknown>) =>
        typeof options === 'string' ? options : realI18n.t(key, options),
      i18n: { language: 'en' },
    }),
  }
})

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
    useThemeMode: () => ({ resolvedMode: 'dark' }),
    useIconGlyphsVersion: () => 0,
    resolveDisplayIcon: () => undefined,
    useRemoteComponent: () => null,
    trpc: {
      auth: {
        listLoginMethods: {
          useQuery: (_input?: unknown, options?: unknown) => {
            loginMethodsOptions.push(options)
            return loginMethodsAnswer()
          },
        },
        getServerName: {
          useQuery: () => ({ data: { name: 'Casa Napoli', isDefault: false } }),
        },
      },
    },
    // Root-mounted in these tests: the mount resolver is the identity.
    hubPath: (p: string) => p,
  }
})

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => false,
  startAuthentication: vi.fn(),
}))

vi.mock('../../lib/backend', () => ({
  getSystem: () => ({
    trpcClient: { auth: { createHandoffCode: { mutate: mintMock } } },
  }),
}))

vi.mock('../../lib/last-location', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/last-location')>()
  return { ...actual, readLastLocation: () => null }
})

vi.mock('../../contexts/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    login: loginMock,
    verifyTotp: vi.fn(),
    finalizePasskeyLogin: finalizeMock,
  }),
}))

import { LoginPage } from '../Login'

const CALLBACK = 'camstack://auth-callback'

function setLoginUrl(withRedirect: boolean): void {
  const binding = `code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&state=st-1`
  const url = withRedirect ? `/login?redirect=${encodeURIComponent(CALLBACK)}&${binding}` : '/login'
  window.history.replaceState(null, '', url)
}

async function submitCredentials(): Promise<void> {
  fireEvent.change(screen.getByTestId('login-username'), { target: { value: 'admin' } })
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'hunter22' } })
  fireEvent.click(screen.getByTestId('login-submit'))
}

beforeEach(() => {
  vi.stubGlobal('__APP_VERSION__', 'test')
  window.sessionStorage.clear()
  mockUser = null
  routerState = null
  window.localStorage.clear()
  loginMethodsFail = false
  loginMethodsOptions.length = 0
  loginMock.mockReset()
  navigateMock.mockReset()
  mintMock.mockReset()
  assignMock.mockReset()
  finalizeMock.mockReset()
  finalizeMock.mockResolvedValue(undefined)
  mintMock.mockResolvedValue({ code: 'chc_test' })
})

describe('LoginPage server name (D861)', () => {
  it('says which hub you are signing in to once it has a name', () => {
    setLoginUrl(false)
    render(<LoginPage />)
    expect(screen.getByTestId('login-server-name').textContent).toBe('Sign in to Casa Napoli')
  })
})

describe('LoginPage login methods (D315: unanswered is not empty)', () => {
  it('a failed listLoginMethods shows the options as pending, not as a password-only page', () => {
    setLoginUrl(false)
    loginMethodsFail = true
    render(<LoginPage />)
    expect(screen.getByTestId('login-methods-pending')).toBeTruthy()
  })

  it('an answered listLoginMethods shows no pending marker', () => {
    setLoginUrl(false)
    render(<LoginPage />)
    expect(screen.queryByTestId('login-methods-pending')).toBeNull()
  })

  it('keeps asking, with a growing delay, instead of giving up after one failure', () => {
    setLoginUrl(false)
    render(<LoginPage />)
    const options = loginMethodsOptions[0] as {
      retry?: unknown
      retryDelay?: (attempt: number) => number
    }
    expect(options.retry).toBe(true)
    expect(options.retryDelay?.(0)).toBeLessThan(options.retryDelay?.(4) ?? 0)
    expect(options.retryDelay?.(40)).toBeLessThanOrEqual(30_000)
  })
})

describe('LoginPage native handoff', () => {
  it('REGRESSION: an interactive login with a redirect mints the handoff and NEVER bounces to the dashboard', async () => {
    setLoginUrl(true)
    loginMock.mockResolvedValue({ kind: 'ok' })
    const { rerender } = render(<LoginPage />)

    await submitCredentials()

    // The handoff interstitial replaces the page, with the tap-to-return
    // anchor carrying the minted one-time code.
    await waitFor(() => {
      expect(screen.getByText('Open CamStack').getAttribute('href')).toBe(
        `${CALLBACK}?code=chc_test&state=st-1`,
      )
    })

    // Simulate the auth context flipping `user` (what the real provider does
    // right after login) — this is what used to fire the SECOND goNext that
    // found the parked redirect consumed and navigated to the dashboard.
    mockUser = { id: 'u1', username: 'admin', isAdmin: true, exp: 9_999_999_999, scopes: [] }
    rerender(<LoginPage />)

    await waitFor(() => {
      expect(mintMock).toHaveBeenCalledTimes(1)
    })
    // Single-flight: no dashboard/restore navigation, interstitial intact.
    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByText('Open CamStack')).toBeTruthy()
  })

  it('an already-authenticated mount with a redirect auto-forwards into the handoff (post-remount retry path)', async () => {
    setLoginUrl(true)
    mockUser = { id: 'u1', username: 'admin', isAdmin: true, exp: 9_999_999_999, scopes: [] }
    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText('Open CamStack').getAttribute('href')).toBe(
        `${CALLBACK}?code=chc_test&state=st-1`,
      )
    })
    expect(mintMock).toHaveBeenCalledTimes(1)
    // The app's PKCE challenge and state ride the mint (D855).
    expect(mintMock).toHaveBeenCalledWith({
      purpose: 'new-session',
      codeChallenge: 'a'.repeat(43),
      state: 'st-1',
    })
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('a plain login without a redirect param navigates to the restore path exactly once', async () => {
    setLoginUrl(false)
    loginMock.mockResolvedValue({ kind: 'ok' })
    const { rerender } = render(<LoginPage />)

    await submitCredentials()

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/devices', { replace: true })
    })

    // Auth context flips afterwards — still exactly one navigation.
    mockUser = { id: 'u1', username: 'admin', isAdmin: true, exp: 9_999_999_999, scopes: [] }
    rerender(<LoginPage />)
    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(mintMock).not.toHaveBeenCalled()
  })

  it('a failed mint surfaces the retriable error instead of silently falling through', async () => {
    setLoginUrl(true)
    mintMock.mockRejectedValue(new Error('boom'))
    mockUser = { id: 'u1', username: 'admin', isAdmin: true, exp: 9_999_999_999, scopes: [] }
    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeTruthy()
    })
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('a step-up refused as "sign in again first" falls back to the sign-in form, never a dead retry; a fresh sign-in then mints', async () => {
    const binding = `code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&state=st-1&purpose=step-up`
    window.history.replaceState(
      null,
      '',
      `/login?redirect=${encodeURIComponent(CALLBACK)}&${binding}`,
    )
    mintMock.mockRejectedValueOnce(
      Object.assign(new Error('Sign in again first: the sign-in is too old'), {
        data: { code: 'FORBIDDEN' },
      }),
    )
    loginMock.mockResolvedValue({ kind: 'ok' })
    mockUser = { id: 'u1', username: 'admin', isAdmin: true, exp: 9_999_999_999, scopes: [] }
    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByTestId('login-username')).toBeTruthy()
    })
    expect(screen.queryByText('Retry')).toBeNull()
    expect(screen.getByText('Sign in again to confirm it is you.')).toBeTruthy()

    await submitCredentials()
    await waitFor(() => {
      expect(screen.getByText('Open CamStack')).toBeTruthy()
    })
    expect(mintMock).toHaveBeenCalledTimes(2)
    expect(mintMock).toHaveBeenLastCalledWith({
      purpose: 'step-up',
      codeChallenge: 'a'.repeat(43),
      state: 'st-1',
    })
  })
})

/**
 * `?next=` round trip — the server-side login bounce.
 *
 * A hub route that demands the session cookie (today: `/api/oauth2/authorize`)
 * answers an unauthenticated BROWSER navigation with
 * `302 /login?next=<the whole original url, percent-encoded>`. The login page
 * owes that url back BYTE FOR BYTE: the OAuth request lives entirely in its
 * query string, so a bounce that returns only the pathname re-issues the
 * request with nothing in it and the hub refuses with
 * `invalid_request — integration parameter missing`, `received: null` —
 * indistinguishable from a client that never sent the parameter. That has cost
 * two debugging sessions; these tests are what stops a third.
 */
const AUTHORIZE_NEXT =
  '/api/oauth2/authorize?response_type=code&client_id=camstack-ha&integration=homeassistant' +
  '&redirect_uri=https%3A%2F%2Fmy.home-assistant.io%2Fredirect%2Foauth' +
  '&state=eyJmbG93X2lkIjoiYWJjIn0%3D&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
  '&code_challenge_method=S256'

function setLoginUrlWithNext(next: string): void {
  window.history.replaceState(null, '', `/login?next=${encodeURIComponent(next)}`)
}

describe('LoginPage ?next= round trip', () => {
  it('REGRESSION: an interactive login returns to the SAME url — every query parameter intact', async () => {
    setLoginUrlWithNext(AUTHORIZE_NEXT)
    loginMock.mockResolvedValue({ kind: 'ok' })
    render(<LoginPage />)

    await submitCredentials()

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith(AUTHORIZE_NEXT)
    })
    // Not the pathname, not a re-encoded copy, and never the restore path.
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('REGRESSION: an ALREADY-authenticated mount forwards to `next` instead of demanding credentials again', async () => {
    // The session COOKIE is what `/api/oauth2/authorize` gates on, and it
    // expires independently of the SPA's own token: an operator with a live
    // admin session lands here with `user` already set. Sitting on a login
    // form they cannot progress past — and whose form submit they may never
    // make — is how the authorize request gets re-issued by hand, bare.
    setLoginUrlWithNext(AUTHORIZE_NEXT)
    mockUser = { id: 'u1', username: 'admin', isAdmin: true, exp: 9_999_999_999, scopes: [] }
    render(<LoginPage />)

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith(AUTHORIZE_NEXT)
    })
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('a `next` that is not a same-origin relative path is refused, not followed', async () => {
    setLoginUrlWithNext('https://evil.example/steal')
    loginMock.mockResolvedValue({ kind: 'ok' })
    render(<LoginPage />)

    await submitCredentials()

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/devices', { replace: true })
    })
    expect(assignMock).not.toHaveBeenCalled()
  })
})

describe('LoginPage — a session that ended on the change-password page', () => {
  // The forced first-run change ended the operator's session ON that page;
  // ProtectedRoute parked `/change-password` as `state.from`, and signing in
  // with the NEW password sent him straight back to it — a loop.
  it('signing in again never lands back on /change-password', async () => {
    setLoginUrl(false)
    routerState = { from: '/change-password' }
    loginMock.mockResolvedValue({ kind: 'ok' })
    render(<LoginPage />)

    await submitCredentials()

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/devices', { replace: true })
    })
    expect(navigateMock).not.toHaveBeenCalledWith('/change-password', expect.anything())
  })

  it('an ordinary interrupted page is still restored', async () => {
    setLoginUrl(false)
    routerState = { from: '/cameras/12' }
    loginMock.mockResolvedValue({ kind: 'ok' })
    render(<LoginPage />)

    await submitCredentials()

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/cameras/12', { replace: true })
    })
  })
})

describe('LoginPage — returning from /api/auth/sso/finish without a session (D782)', () => {
  it('an unlinked OIDC login shows the link message naming the provider', async () => {
    window.history.replaceState(
      null,
      '',
      '/login#error=sso-not-linked&provider=auth-oidc%2Fauthentik',
    )
    render(<LoginPage />)
    expect((await screen.findByTestId('login-error')).textContent).toBe(
      'This Authentik account is not linked to a CamStack user. Sign in normally and link it from your profile.',
    )
    expect(window.location.hash).toBe('')
  })

  it('a sign-in that owes TOTP resumes at the second-factor step', async () => {
    window.history.replaceState(null, '', '/login#challenge=chal.tok&factors=totp')
    render(<LoginPage />)
    expect(await screen.findByTestId('login-totp')).toBeTruthy()
    expect(screen.queryByTestId('login-username')).toBeNull()
  })
})

describe('LoginPage — SSO in a popup window (D791)', () => {
  function fakePopup(): Window {
    return { postMessage: vi.fn(), closed: false } as unknown as Window
  }

  function post(source: Window, origin: string, completion: unknown): void {
    const event = new Event('message')
    Object.defineProperties(event, {
      data: { value: { type: 'camstack:sso-return', completion } },
      origin: { value: origin },
      source: { value: source },
    })
    window.dispatchEvent(event)
  }

  it('a redirect button opens a popup with popup=1 and the page stays', () => {
    setLoginUrl(false)
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<LoginPage />)
    const notPrevented = fireEvent.click(screen.getByText('Authentik'))
    expect(notPrevented).toBe(false)
    expect(open).toHaveBeenCalledWith(
      '/addon/auth-oidc/authentik/start?popup=1',
      'camstack-sso',
      expect.stringContaining('toolbar=no'),
    )
    expect(assignMock).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('the popup session signs in exactly like a full-page return, and the popup is acked', async () => {
    setLoginUrl(false)
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<LoginPage />)
    fireEvent.click(screen.getByText('Authentik'))
    post(popup, window.location.origin, {
      target: 'login',
      fragment: 'token=abc.def.ghi&provider=x',
    })
    await waitFor(() =>
      expect(finalizeMock).toHaveBeenCalledWith(
        'abc.def.ghi',
        expect.objectContaining({ token: 'abc.def.ghi' }),
      ),
    )
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/devices', { replace: true }))
    expect(popup.postMessage).toHaveBeenCalledWith(
      { type: 'camstack:sso-ack' },
      window.location.origin,
    )
    open.mockRestore()
  })

  it('opener reference severed: a token-free "done" on the channel signs in from the session the popup kept here', async () => {
    setLoginUrl(false)
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<LoginPage />)
    fireEvent.click(screen.getByText('Authentik'))
    // What the popup did at this origin before signalling.
    localStorage.setItem('camstack_admin_token', 'kept.by.popup')
    const popupSide = new BroadcastChannel('camstack-sso')
    const acks: unknown[] = []
    popupSide.onmessage = (e: MessageEvent) => acks.push(e.data)
    popupSide.postMessage({ type: 'camstack:sso-done', target: 'login' })
    await waitFor(() =>
      expect(finalizeMock).toHaveBeenCalledWith(
        'kept.by.popup',
        expect.objectContaining({ token: 'kept.by.popup' }),
      ),
    )
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/devices', { replace: true }))
    await waitFor(() => expect(acks).toContainEqual({ type: 'camstack:sso-done-ack' }))
    popupSide.close()
    localStorage.removeItem('camstack_admin_token')
    open.mockRestore()
  })

  it('the popup hands over the refresh token and expiry with the session', async () => {
    setLoginUrl(false)
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<LoginPage />)
    fireEvent.click(screen.getByText('Authentik'))
    post(popup, window.location.origin, {
      target: 'login',
      fragment: 'token=t.o.k&refreshToken=csr_abc&expiresAt=1700000000000&provider=x',
    })
    await waitFor(() =>
      expect(finalizeMock).toHaveBeenCalledWith(
        't.o.k',
        expect.objectContaining({ refreshToken: 'csr_abc', expiresAt: 1700000000000 }),
      ),
    )
  })

  it('a message from another origin or another window is ignored', async () => {
    setLoginUrl(false)
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<LoginPage />)
    fireEvent.click(screen.getByText('Authentik'))
    post(popup, 'https://evil.example', { target: 'login', fragment: 'token=forged' })
    post(fakePopup(), window.location.origin, { target: 'login', fragment: 'token=forged' })
    await new Promise((r) => setTimeout(r, 20))
    expect(finalizeMock).not.toHaveBeenCalled()
    expect(popup.postMessage).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('a popup challenge resumes at the second-factor step, never a session', async () => {
    setLoginUrl(false)
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<LoginPage />)
    fireEvent.click(screen.getByText('Authentik'))
    post(popup, window.location.origin, {
      target: 'login',
      fragment: 'challenge=chal&factors=totp&provider=x',
    })
    await waitFor(() => expect(screen.getByTestId('login-totp')).toBeTruthy())
    expect(finalizeMock).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('a blocked popup falls back to the plain link navigation', () => {
    setLoginUrl(false)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<LoginPage />)
    expect(fireEvent.click(screen.getByText('Authentik'))).toBe(true)
    open.mockRestore()
  })

  it('the native-app handoff never opens a popup', () => {
    setLoginUrl(true)
    const open = vi.spyOn(window, 'open')
    render(<LoginPage />)
    expect(fireEvent.click(screen.getByText('Authentik'))).toBe(true)
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })
})
