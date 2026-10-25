/**
 * Authentication page — an `<IntegrationHub>` (Identity → Authentication).
 *
 * `authentication` orchestrator was retired (2026-05-15) — this page
 * enumerates providers generically:
 *   • `addons.listCapabilityProviders({ capName: 'auth-provider' })`
 *     reports each provider's `isActive` (enabled) state; `addons.list`
 *     resolves display names from the manifest.
 *
 * The pills, the Enable/Disable toggle, Restart, the schema settings and
 * the activity stream are all the base's. Disabling a provider only
 * removes that external/SSO login method — local password login via
 * `user-management` is a separate path and is never affected.
 *
 * The only Auth-specific contribution is the per-provider `about` panel
 * (hints + setup steps) above the settings.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ShieldCheck, KeySquare, Globe, Smartphone, Info, BookOpen } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Badge, useAddonsList, useAddonsListCapabilityProviders } from '@camstack/ui-library'
import { AddonIntegrationBody } from '../../components/integration-hub/AddonIntegrationBody'
import { STATUS_BADGE_CLASS } from '../../components/integration-hub/addon-controls'
import { IntegrationHub } from '../../components/integration-hub/IntegrationHub'
import { providerPillState, type IntegrationGroup } from '../../components/integration-hub/types'
import { buildAddonDisplayNameMap } from '../../lib/addon-display-names'
import { OidcSettingsConnections } from './OidcSettingsConnections'
import { Trans, useTranslation } from 'react-i18next'

const PROVIDERS_POLL_INTERVAL_MS = 30_000

/**
 * The set of capabilities whose providers are "authentication" and so
 * belong on this page. Cap-driven — a provider appears because it
 * registers one of these caps + exposes global settings, NOT because of
 * any addon-id special case. Mirrors the `INTEGRATION_CAP_MARKERS`
 * precedent. Add a cap here to surface a new class of auth provider
 * (e.g. a future `auth-oauth-device`); no other change is needed.
 *
 *   • `auth-provider`  — login providers (local password, OIDC, SAML,
 *     …) that satisfy the FIRST credential leg.
 *   • `user-passkeys`  — WebAuthn / passkey SECOND-factor providers.
 *
 * The toggle on these caps is an auth addon's ONLY enable (D777): addons carry
 * no private `enabled` setting, and the hub's login-method aggregation and SSO
 * finish ask the same caps (`AUTH_GOVERNING_CAPS` in
 * `server/backend/src/auth/auth-provider-gate.ts` — keep the two in step).
 */
const AUTH_CAPS = [
  {
    capName: 'auth-provider',
    /** Extra badge shown on each row of this cap (null = none). */
    stageBadge: null,
  },
  {
    capName: 'user-passkeys',
    stageBadge: 'Second factor',
  },
] as const

const AUTH_SECTION = {
  titleKey: 'system.authentication.sectionTitle',
  subtitleKey: 'system.authentication.sectionSubtitle',
  emptyTitleKey: 'system.authentication.sectionEmptyTitle',
  emptyDescriptionKey: 'system.authentication.sectionEmptyDescription',
  installLabelKey: 'system.authentication.sectionInstall',
} as const

/**
 * One enumerated auth provider; `isActive` mirrors the registry's
 * enabled-set.
 */
interface AuthProviderRow {
  readonly addonId: string
  readonly displayName: string
  readonly isActive: boolean
  /** The cap this row's provider registered (enable/disable target). */
  readonly capName: string
  /** Extra stage pill ("Second factor") — null for plain login providers. */
  readonly stageBadge: string | null
}

// ---------------------------------------------------------------------------
// Provider-kind metadata — per-provider hints.
// ---------------------------------------------------------------------------

interface ProviderHint {
  readonly headline: string
  readonly bullets: readonly string[]
  readonly setupSteps?: readonly string[]
  readonly icon: LucideIcon
}

/** Look up hints by the provider's addonId prefix. The orchestrator's
 *  per-provider `kind` field is gone with the facade — addonId is the
 *  only structural signal left, and CamStack's auth addons follow the
 *  `local-auth` / `auth-oidc` / `auth-saml` / `auth-webauthn` naming. */
function hintFor(addonId: string): ProviderHint {
  if (addonId === 'local-auth') {
    return {
      headline: 'Username + password (local).',
      icon: KeySquare,
      bullets: [
        'Users live in the hub’s SQLite database — no IdP roundtrip.',
        'TOTP / 2FA is self-enrolled: each user enables it from their own profile page (My access → Two-factor authentication).',
        'Scoped tokens, admin tokens and sessions are managed from Identity → Tokens & sessions.',
      ],
      setupSteps: [
        'A fresh hub has one account, admin / changeme — the first sign-in asks for a new password. Add users from Users → New user.',
        'Hand out either passwords or scoped tokens — both validate through this provider.',
      ],
    }
  }
  if (addonId.startsWith('auth-oidc')) {
    return {
      headline: 'OpenID Connect (Google, Microsoft, Okta, Keycloak, …).',
      icon: Globe,
      bullets: [
        'Three-leg redirect flow with PKCE S256 + nonce.',
        'id_token is signature-verified against the IdP’s JWKS — no implicit trust.',
        'Explicit linking only: an IdP account signs in only the CamStack user who linked it from their profile (My access → Linked sign-in accounts). No auto-created users, no email matching.',
        'The linked user’s role, scopes and two-factor authentication apply.',
      ],
      setupSteps: [
        'Register a web app at your IdP and copy the client_id + client_secret.',
        'Choose a stable instance id (slug). Set the IdP redirect URI to `https://<this-hub>/addon/auth-oidc/<id>/callback`.',
        'In Settings below, Add connection — enter the id, issuer, and credentials; Save.',
        'Each user then links their IdP account from My access → Linked sign-in accounts.',
      ],
    }
  }
  if (addonId.startsWith('auth-saml')) {
    return {
      headline: 'SAML 2.0 — enterprise SSO (Azure AD, Okta, OneLogin).',
      icon: Globe,
      bullets: [
        'Heavier handshake than OIDC — exchange metadata XML with your IdP.',
        'Group → role mapping via SAML assertions.',
      ],
    }
  }
  if (addonId.startsWith('auth-webauthn') || addonId.startsWith('auth-passkey')) {
    return {
      headline: 'Passkeys / WebAuthn — passwordless second factor.',
      icon: Smartphone,
      bullets: [
        'Enroll a YubiKey, Touch ID, or platform passkey per user.',
        'Resistant to phishing — the browser binds the credential to your hub origin.',
      ],
    }
  }
  if (addonId.startsWith('auth-totp')) {
    return {
      headline: 'TOTP — second factor.',
      icon: Smartphone,
      bullets: [
        'Time-based codes from an authenticator app (RFC 6238).',
        'Compatible with Google Authenticator, Aegis, 1Password, Bitwarden, etc.',
      ],
    }
  }
  return {
    headline: 'Authentication provider.',
    icon: ShieldCheck,
    bullets: ['Generic authentication provider. No additional hints registered.'],
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AuthenticationPage() {
  const { t } = useTranslation()
  // ONE unified section listing the providers of every auth cap together
  // (login providers + passkey second-factor) — each row still toggles its
  // OWN cap via the per-item capName override, and a stage pill marks the
  // second-factor rows. Cap-driven throughout: a new auth cap in AUTH_CAPS
  // is the only change needed to surface a new provider class.
  const loginQuery = useAddonsListCapabilityProviders(
    { capName: AUTH_CAPS[0].capName },
    { refetchInterval: PROVIDERS_POLL_INTERVAL_MS },
  )
  const passkeyQuery = useAddonsListCapabilityProviders(
    { capName: AUTH_CAPS[1].capName },
    { refetchInterval: PROVIDERS_POLL_INTERVAL_MS },
  )
  const addonsQuery = useAddonsList(undefined, { refetchInterval: PROVIDERS_POLL_INTERVAL_MS })

  const displayNames = useMemo(
    () => buildAddonDisplayNameMap(addonsQuery.data ?? []),
    [addonsQuery.data],
  )

  const providers = useMemo<readonly AuthProviderRow[]>(() => {
    const rows: AuthProviderRow[] = []
    const sources = [loginQuery.data ?? [], passkeyQuery.data ?? []] as const
    for (const [i, cap] of AUTH_CAPS.entries()) {
      for (const p of sources[i] ?? []) {
        rows.push({
          addonId: p.addonId,
          displayName: displayNames.get(p.addonId) ?? p.addonId,
          isActive: p.isActive,
          capName: cap.capName,
          stageBadge: cap.stageBadge,
        })
      }
    }
    return rows
  }, [loginQuery.data, passkeyQuery.data, displayNames])

  const groups: readonly IntegrationGroup[] = [
    {
      id: 'authentication',
      label: t('system.authentication.authenticationProviders', 'Authentication providers'),
      install: { capability: AUTH_CAPS[0].capName, label: t(AUTH_SECTION.installLabelKey) },
      entries: providers.map((p) => ({
        id: p.addonId,
        name: p.displayName,
        fallbackIcon: ShieldCheck,
        ...providerPillState(p.isActive),
        render: () => (
          <AddonIntegrationBody
            addonId={p.addonId}
            displayName={p.displayName}
            capName={p.capName}
            isActive={p.isActive}
            badges={
              p.stageBadge !== null ? (
                <Badge variant="info" className={STATUS_BADGE_CLASS}>
                  {p.stageBadge}
                </Badge>
              ) : null
            }
            settingsContent={
              p.addonId.startsWith('auth-oidc') ? (
                <OidcSettingsConnections addonId={p.addonId} />
              ) : undefined
            }
            panels={[
              {
                id: 'about',
                title: t('system.authentication.about', 'About'),
                icon: hintFor(p.addonId).icon,
                content: <AuthHintPanel addonId={p.addonId} />,
              },
            ]}
          />
        ),
      })),
    },
  ]

  return (
    <IntegrationHub
      embedded
      icon={ShieldCheck}
      title={t(AUTH_SECTION.titleKey)}
      subtitle={t(AUTH_SECTION.subtitleKey)}
      groups={groups}
      isLoading={loginQuery.isLoading || passkeyQuery.isLoading}
      emptyTitle={t(AUTH_SECTION.emptyTitleKey)}
      emptyDescription={t(AUTH_SECTION.emptyDescriptionKey)}
    />
  )
}

/**
 * Per-provider `about` panel — the operator-facing detail tier, above the
 * integration's settings.
 */
function AuthHintPanel({ addonId }: { readonly addonId: string }): React.ReactElement {
  const { t } = useTranslation()
  const hint = hintFor(addonId)
  const HintIcon = hint.icon
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-2 sm:p-4">
      <div className="flex items-start gap-2.5">
        <HintIcon className="h-4 w-4 mt-0.5 text-primary shrink-0" />
        <div className="text-xs text-foreground font-medium">{hint.headline}</div>
      </div>
      <ul className="text-xs text-foreground-subtle space-y-1.5 pl-6 list-disc">
        {hint.bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
      {hint.setupSteps && hint.setupSteps.length > 0 && (
        <div className="rounded-md border border-border bg-surface-hover/40 px-3 py-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground-subtle uppercase tracking-wide">
            <BookOpen className="h-3 w-3" />
            {t('system.authentication.setupSteps', 'Setup steps')}
          </div>
          <ol className="text-xs text-foreground space-y-0.5 pl-4 list-decimal">
            {hint.setupSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {addonId === 'local-auth' && (
        <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 flex items-start gap-2 text-[11px] text-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 text-info shrink-0" />
          <span>
            <Trans
              i18nKey="system.authentication.totpNote"
              components={{
                access: (
                  <Link to="/system/my-access?tab=sign-in" className="underline text-primary" />
                ),
                users: <Link to="/system/identity?tab=users" className="underline text-primary" />,
              }}
            />
          </span>
        </div>
      )}
    </div>
  )
}
