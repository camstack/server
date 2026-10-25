/**
 * Widget + login-method catalog for the `auth-webauthn` addon.
 *
 * The addon ships TWO Module-Federation widgets, both bundled into
 * `dist/webauthn/remoteEntry.js` (see `vite.widgets.config.ts`):
 *
 *   - `passkey-enrollment` (post-auth) — self-service passkey management,
 *     surfaced through the normal `addon-widgets-source` registry and
 *     mounted by admin-ui's My-Access page via `<WidgetSlot>`.
 *   - `passkey-login` (`preAuth: true`) — the login-page second-factor
 *     ceremony, surfaced through the PUBLIC `auth.listLoginMethods`
 *     login-method channel (the registry listing is auth-gated).
 *
 * Pure data — NO React imports here, so the server addon entry can pull
 * these constants without dragging the widget bundle into the node build.
 */
import type { LoginMethodContribution, WidgetMetadata } from '@camstack/types'

/** MF remote name — must match `vite.widgets.config.ts` `federation.name`. */
export const AUTH_WEBAUTHN_REMOTE_NAME = 'addon_auth_webauthn_widgets'
/** MF entry filename served at `/api/addon-widgets/auth-webauthn/<bundle>`. */
export const AUTH_WEBAUTHN_BUNDLE = 'remoteEntry.js'
/** Manifest addon id — the public bundle namespace + login-method addonId. */
export const AUTH_WEBAUTHN_ADDON_ID = 'auth-webauthn'

export const authWebauthnWidgets: readonly WidgetMetadata[] = [
  {
    tab: 'dashboard',
    label: 'Passkeys',
    kind: 'remote' as const,
    remote: {
      remoteName: AUTH_WEBAUTHN_REMOTE_NAME,
      exposedModule: './widgets',
      componentKey: 'passkey-enrollment',
    },
    stableId: 'passkey-enrollment',
    description: 'Enroll and manage passkeys (WebAuthn) for your account.',
    icon: 'fingerprint',
    bundle: AUTH_WEBAUTHN_BUNDLE,
    hosts: ['dashboard'] as const,
    requires: { deviceContext: false, integrationContext: false },
    defaultSize: 'lg' as const,
    allowedSizes: ['md', 'lg', 'xl'] as const,
    defaultColumns: 12,
    defaultRows: 3,
    preAuth: false,
  },
  {
    tab: 'dashboard',
    label: 'Passkey login',
    kind: 'remote' as const,
    remote: {
      remoteName: AUTH_WEBAUTHN_REMOTE_NAME,
      exposedModule: './widgets',
      componentKey: 'passkey-login',
    },
    stableId: 'passkey-login',
    description: 'Login-page passkey second-factor ceremony.',
    icon: 'fingerprint',
    bundle: AUTH_WEBAUTHN_BUNDLE,
    hosts: ['dashboard'] as const,
    requires: { deviceContext: false, integrationContext: false },
    defaultSize: 'sm' as const,
    allowedSizes: ['sm'] as const,
    defaultColumns: 4,
    defaultRows: 1,
    preAuth: true,
  },
  {
    tab: 'dashboard',
    label: 'Passkey sign-in',
    kind: 'remote' as const,
    remote: {
      remoteName: AUTH_WEBAUTHN_REMOTE_NAME,
      exposedModule: './widgets',
      componentKey: 'passkey-direct-login',
    },
    stableId: 'passkey-direct-login',
    description: 'Login-page usernameless (discoverable-credential) passkey sign-in.',
    icon: 'fingerprint',
    bundle: AUTH_WEBAUTHN_BUNDLE,
    hosts: ['dashboard'] as const,
    requires: { deviceContext: false, integrationContext: false },
    defaultSize: 'sm' as const,
    allowedSizes: ['sm'] as const,
    defaultColumns: 4,
    defaultRows: 1,
    preAuth: true,
  },
]

/**
 * Login-method contributions — aggregated by the public
 * `auth.listLoginMethods` procedure.
 *
 *   - `passkey-login` (second-factor) — the post-password 2FA ceremony,
 *     mounted only when the challenged user has the `passkey` factor.
 *   - `passkey-direct-login` (primary) — usernameless sign-in via the
 *     standard WebAuthn discoverable-credentials flow. Contributed
 *     unconditionally while the addon is registered: the browser's own
 *     passkey picker is the honest gate (it simply offers nothing when
 *     no resident credential matches the RP) — probing the server for
 *     "does anyone have a passkey" pre-auth would leak enrollment state.
 *
 * Both are `kind:'passkey'` — a declarative WebAuthn ceremony the shell
 * renders natively (no remote code fetched pre-auth). The caller (the
 * addon, which owns `resolveRpID()`/`resolveOrigin()`) supplies the
 * EFFECTIVE rpId/origin so the shell can gate visibility (IP-literal
 * origin, hostname/rpId mismatch) without any extra round-trip.
 */
export function buildAuthWebauthnLoginMethods(
  rpId: string,
  origin: string | null,
): readonly LoginMethodContribution[] {
  return [
    {
      kind: 'passkey',
      id: `${AUTH_WEBAUTHN_ADDON_ID}/passkey-login`,
      label: 'Passkey',
      stage: 'second-factor',
      rpId,
      origin,
    },
    {
      kind: 'passkey',
      id: `${AUTH_WEBAUTHN_ADDON_ID}/passkey-direct-login`,
      label: 'Sign in with a passkey',
      stage: 'primary',
      rpId,
      origin,
    },
  ]
}
