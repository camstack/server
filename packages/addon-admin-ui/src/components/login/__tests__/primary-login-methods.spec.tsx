// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

/**
 * PrimaryLoginMethods rendering contract:
 *   • no methods → renders NOTHING (no "Or continue with" divider),
 *   • a widget method whose remote bundle FAILS to load must surface a
 *     visible error row — never vanish silently under the divider,
 *   • a widget method still loading shows the loading row,
 *   • a resolved widget method mounts the remote component,
 *   • a redirect method renders its labelled link,
 *   • a passkey method renders the native button ONLY when the origin
 *     gate passes (browser support + hostname/rpId — see
 *     `second-factor-selection.ts`); when the gate fails it renders
 *     NOTHING for that arm (no error row, no `PreAuthWidgetMount`).
 *
 * `browserSupportsWebAuthn` is mocked (jsdom has no WebAuthn API); the
 * hostname/rpId leg is exercised for REAL — jsdom's default test URL is
 * `http://localhost:3000/`, so a passkey method's `rpId: 'localhost'`
 * naturally matches (see `passkey-gate.test.ts`), letting these tests
 * verify the actual gate wiring instead of stubbing it out.
 */

type RemoteResolution = 'loading' | 'failed' | 'resolved'
let remoteResolution: RemoteResolution = 'resolved'
let webAuthnSupported = true

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const original = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    // The real glyph table — the login button resolves its icon through it (D780, D854).
    resolveDisplayIcon: original.resolveDisplayIcon,
    useIconGlyphsVersion: original.useIconGlyphsVersion,
    loadIconGlyphs: original.loadIconGlyphs,
    useRemoteComponent: () => {
      if (remoteResolution === 'loading') return null
      if (remoteResolution === 'failed') return undefined
      return ({ instanceId }: { instanceId: string }) => (
        <div data-testid="remote-widget">{instanceId}</div>
      )
    },
  }
})

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => webAuthnSupported,
  startAuthentication: vi.fn(),
}))

import { loadIconGlyphs } from '@camstack/ui-library'
import {
  PrimaryLoginMethods,
  type LoginMethod,
  type PasskeyLoginMethod,
} from '../PrimaryLoginMethods'

const widgetMethod: LoginMethod = {
  kind: 'widget',
  id: 'auth-webauthn/passkey-direct-login',
  addonId: 'auth-webauthn',
  bundle: 'remoteEntry.js',
  remote: {
    remoteName: 'addon_auth_webauthn_widgets',
    exposedModule: './widgets',
    componentKey: 'passkey-direct-login',
  },
  stage: 'primary',
  bundleUrl: '/api/addon-widgets/auth-webauthn/remoteEntry.js?v=1',
}

const redirectMethod: LoginMethod = {
  kind: 'redirect',
  id: 'auth-oidc/login',
  label: 'Single sign-on',
  startUrl: '/api/auth/oidc/start',
  stage: 'primary',
}

const passkeyMethodOnMatchingOrigin: PasskeyLoginMethod = {
  kind: 'passkey',
  id: 'auth-webauthn/passkey-direct',
  label: 'Sign in with a passkey',
  stage: 'primary',
  rpId: 'localhost',
  origin: null,
}

const passkeyMethodOnMismatchedOrigin: PasskeyLoginMethod = {
  ...passkeyMethodOnMatchingOrigin,
  rpId: 'example.com',
}

beforeEach(() => {
  remoteResolution = 'resolved'
  webAuthnSupported = true
})

describe('PrimaryLoginMethods', () => {
  it('renders nothing when there are no methods', () => {
    const { container } = render(<PrimaryLoginMethods methods={[]} widgetConfig={{}} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByText('Or continue with')).toBeNull()
  })

  it('mounts a resolved widget method under the divider', () => {
    render(<PrimaryLoginMethods methods={[widgetMethod]} widgetConfig={{}} />)
    expect(screen.getByText('Or continue with')).toBeTruthy()
    expect(screen.getByTestId('remote-widget').textContent).toBe(
      'auth-webauthn/passkey-direct-login',
    )
  })

  it('surfaces a visible error when a widget bundle fails to load', () => {
    remoteResolution = 'failed'
    render(<PrimaryLoginMethods methods={[widgetMethod]} widgetConfig={{}} />)
    expect(screen.getByTestId('login-method-load-error')).toBeTruthy()
  })

  it('shows the loading row while a widget bundle is loading', () => {
    remoteResolution = 'loading'
    render(<PrimaryLoginMethods methods={[widgetMethod]} widgetConfig={{}} />)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('renders a redirect method as a labelled link', () => {
    render(<PrimaryLoginMethods methods={[redirectMethod]} widgetConfig={{}} />)
    const link = screen.getByText('Single sign-on').closest('a')
    expect(link?.getAttribute('href')).toBe('/api/auth/oidc/start')
  })

  it('renders the native passkey button when the origin gate passes', () => {
    render(
      <PrimaryLoginMethods
        methods={[passkeyMethodOnMatchingOrigin]}
        widgetConfig={{ onComplete: vi.fn() }}
      />,
    )
    expect(screen.getByText('Or continue with')).toBeTruthy()
    expect(screen.getByTestId('login-passkey-direct')).toBeTruthy()
    expect(screen.getByText('Sign in with a passkey')).toBeTruthy()
  })

  it('renders NOTHING for a passkey method when the browser lacks WebAuthn support', () => {
    webAuthnSupported = false
    const { container } = render(
      <PrimaryLoginMethods
        methods={[passkeyMethodOnMatchingOrigin]}
        widgetConfig={{ onComplete: vi.fn() }}
      />,
    )
    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('login-passkey-direct')).toBeNull()
    expect(screen.queryByTestId('login-method-load-error')).toBeNull()
  })

  it('renders NOTHING for a passkey method whose rpId does not match the origin', () => {
    const { container } = render(
      <PrimaryLoginMethods
        methods={[passkeyMethodOnMismatchedOrigin]}
        widgetConfig={{ onComplete: vi.fn() }}
      />,
    )
    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('login-passkey-direct')).toBeNull()
    expect(screen.queryByTestId('login-method-load-error')).toBeNull()
  })

  it('falls through to a usable widget method when a sibling passkey method is gated out', () => {
    render(
      <PrimaryLoginMethods
        methods={[passkeyMethodOnMismatchedOrigin, widgetMethod]}
        widgetConfig={{ onComplete: vi.fn() }}
      />,
    )
    expect(screen.queryByTestId('login-passkey-direct')).toBeNull()
    expect(screen.getByTestId('remote-widget')).toBeTruthy()
  })
})

describe('PrimaryLoginMethods — redirect icon (D780)', () => {
  const withIcon = (icon: string | undefined): LoginMethod => ({
    kind: 'redirect',
    id: 'auth-oidc/authentik',
    label: 'Authentik',
    startUrl: '/addon/auth-oidc/authentik/start',
    stage: 'primary',
    ...(icon !== undefined ? { icon } : {}),
  })

  // `key` is not on the synchronous first-paint table: the lazy glyph table must be
  // there. Loading it imports the whole icon module, which can exceed a test's own
  // 5 s budget on a busy machine, so it is paid once here, outside the assertion.
  beforeAll(async () => {
    await loadIconGlyphs()
  }, 60_000)

  it('draws the contributed catalog key', () => {
    const { container } = render(
      <PrimaryLoginMethods methods={[withIcon('key')]} widgetConfig={{}} />,
    )
    expect(container.querySelector('.lucide-key')).not.toBeNull()
    expect(container.querySelector('.lucide-shield-check')).toBeNull()
  })

  it('falls back to shield-check for a key outside the vocabulary, or none', () => {
    for (const icon of ['not-a-glyph', undefined]) {
      const { container, unmount } = render(
        <PrimaryLoginMethods methods={[withIcon(icon)]} widgetConfig={{}} />,
      )
      expect(container.querySelector('.lucide-shield-check')).not.toBeNull()
      unmount()
    }
  })
})
