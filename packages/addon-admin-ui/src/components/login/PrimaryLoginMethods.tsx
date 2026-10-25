import { ShieldCheck, Loader2, AlertCircle } from 'lucide-react'
import { resolveDisplayIcon, useIconGlyphsVersion, useRemoteComponent } from '@camstack/ui-library'
import { isPasskeyMethodUsable } from './second-factor-selection'
import { PasskeyLoginButton, type PasskeySecondFactorOutcome } from './PasskeyLoginButton'
import { useTranslation } from 'react-i18next'

/**
 * One row of `auth.listLoginMethods` — the discriminated union the login
 * page renders directly. `redirect` → a generic button; `widget` → a
 * pre-auth MF widget mounted via `loadRemoteBundle`; `passkey` → a
 * shell-native WebAuthn ceremony (no remote code). The shapes mirror the
 * server `login-method` cap (widget arm carries the server-stamped
 * `bundleUrl`). Cap-driven: NO addon id is hardcoded — every field comes
 * from the contribution.
 */
export interface RedirectLoginMethod {
  readonly kind: 'redirect'
  readonly id: string
  readonly label: string
  readonly icon?: string
  readonly startUrl: string
  readonly stage: 'primary' | 'second-factor'
}
export interface WidgetLoginMethod {
  readonly kind: 'widget'
  readonly id: string
  readonly addonId: string
  readonly bundle: string
  readonly remote: {
    readonly remoteName: string
    readonly exposedModule: string
    readonly componentKey?: string
  }
  readonly stage: 'primary' | 'second-factor'
  readonly bundleUrl: string
}
/**
 * A declarative WebAuthn ceremony the shell renders natively. Carries
 * the addon's EFFECTIVE `rpId`/`origin` (`resolveRpID()` / `resolveOrigin()`)
 * so the shell can gate visibility (IP-literal origin, hostname/rpId
 * mismatch — see `passkey-gate.ts`) before ever showing the button.
 */
export interface PasskeyLoginMethod {
  readonly kind: 'passkey'
  readonly id: string
  readonly label: string
  readonly stage: 'primary' | 'second-factor'
  readonly rpId: string
  readonly origin: string | null
}
export type LoginMethod = RedirectLoginMethod | WidgetLoginMethod | PasskeyLoginMethod

export interface PrimaryLoginMethodsProps {
  readonly methods: readonly LoginMethod[]
  /**
   * Config handed to every primary-stage `widget` method. Carries the
   * shell's session-finalize callback (`onComplete(token)` — a widget
   * that mints a session JWT, e.g. the usernameless passkey ceremony,
   * hands the token back through it) plus the active `locale`. Purely
   * cap-driven — the shell knows nothing about which addon mounts here.
   */
  readonly widgetConfig: Readonly<Record<string, unknown>>
  /**
   * Called on a `redirect` button's click, before the browser follows it.
   * `true` = the shell took the sign-in elsewhere (a popup window, D791) and
   * the page must stay; `false` = navigate as a plain link.
   */
  readonly onRedirect?: (method: RedirectLoginMethod) => boolean
}

/**
 * Narrow the opaque `widgetConfig` record to the primary-stage passkey
 * ceremony's contract. Mirrors the retired `PasskeyDirectLogin` widget's
 * own `readConfig` — the config is handed through as an untyped record
 * so `PrimaryLoginMethods` stays generic across every login-method kind.
 */
/** A finalize callback: the access token, plus its refresh token and expiry when minted natively. */
type SessionComplete = (
  token: string,
  session?: { readonly refreshToken?: string; readonly expiresAt?: number },
) => void

function readPasskeyPrimaryConfig(widgetConfig: Readonly<Record<string, unknown>>): {
  onComplete: SessionComplete
  onSecondFactor?: (outcome: PasskeySecondFactorOutcome) => void
} | null {
  const onComplete = widgetConfig['onComplete']
  const onSecondFactor = widgetConfig['onSecondFactor']
  if (typeof onComplete !== 'function') return null
  return {
    onComplete: onComplete as SessionComplete,
    onSecondFactor:
      typeof onSecondFactor === 'function'
        ? (onSecondFactor as (outcome: PasskeySecondFactorOutcome) => void)
        : undefined,
  }
}

/**
 * Renders the primary-stage login-method contributions below the
 * credentials form — the "Or continue with…" section. Every auth addon
 * (OIDC, a future SSO plug-in) contributes here through the
 * public `auth.listLoginMethods` aggregate; the shell renders whatever
 * comes back with ZERO addon-specific code. `redirect` methods become
 * buttons navigating to their addon-owned `startUrl`; `widget` methods
 * mount via Module Federation (residual mechanism, no shipped addon uses
 * it here anymore); `passkey` methods render a native ceremony button
 * (see `PasskeyLoginButton`) gated on browser support + origin/rpId.
 *
 * Every `redirect`/`widget` method always renders SOMETHING — a failed
 * widget load surfaces an inline error row (see `PreAuthWidgetMount`).
 * A `passkey` method whose gate fails renders NOTHING (no error row —
 * it's filtered out before the empty-section check below, so the
 * divider never floats over zero visible methods).
 */
export function PrimaryLoginMethods({
  methods,
  widgetConfig,
  onRedirect,
}: PrimaryLoginMethodsProps) {
  const { t } = useTranslation()
  useIconGlyphsVersion()
  const visibleMethods = methods.filter((m) => m.kind !== 'passkey' || isPasskeyMethodUsable(m))
  if (visibleMethods.length === 0) return null
  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">
          {t('login.primaryLoginMethods.orContinueWith', 'Or continue with')}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="space-y-2">
        {visibleMethods.map((m) => {
          if (m.kind === 'redirect') {
            // The contributed icon is a display-icon vocabulary key (D780),
            // drawn through the same table the icon picker uses.
            const Glyph =
              (m.icon !== undefined ? resolveDisplayIcon(m.icon) : undefined) ?? ShieldCheck
            return (
              <a
                key={m.id}
                href={m.startUrl}
                onClick={(event) => {
                  if (onRedirect?.(m) === true) event.preventDefault()
                }}
                className="flex items-center justify-center gap-2 w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground hover:bg-surface-hover transition-colors"
              >
                <Glyph className="h-4 w-4 text-primary" />
                {m.label}
              </a>
            )
          }
          if (m.kind === 'passkey') {
            const cfg = readPasskeyPrimaryConfig(widgetConfig)
            if (!cfg) return null
            return (
              <PasskeyLoginButton
                key={m.id}
                method={m}
                onComplete={cfg.onComplete}
                onSecondFactor={cfg.onSecondFactor}
              />
            )
          }
          return <PreAuthWidgetMount key={m.id} method={m} config={widgetConfig} />
        })}
      </div>
    </div>
  )
}

/**
 * Mounts a pre-auth `widget` login-method through the shared Module
 * Federation loader (`useRemoteComponent`). The bundle is served by the
 * PUBLIC `/api/addon-widgets/:addonId/*` static route; the descriptor +
 * versioned `bundleUrl` come straight from the cap contribution, so no
 * auth-gated widget registry is needed.
 *
 * A failed bundle load renders a visible error row — a sign-in method
 * the server advertised must never vanish silently (the operator would
 * see the "Or continue with" divider over nothing and have no clue).
 */
export function PreAuthWidgetMount({
  method,
  config,
}: {
  method: WidgetLoginMethod
  config: Readonly<Record<string, unknown>>
}) {
  const { t } = useTranslation()
  const Component = useRemoteComponent(method.remote, method.bundleUrl)
  if (Component === null) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }
  if (Component === undefined) {
    return (
      <div
        data-testid="login-method-load-error"
        className="flex items-center justify-center gap-2 rounded-lg border border-danger/20 bg-danger/10 px-4 py-2.5 text-xs text-danger"
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {t('login.primaryMethods.loadFailed')}
      </div>
    )
  }
  return <Component instanceId={method.id} host="dashboard" config={config} />
}
