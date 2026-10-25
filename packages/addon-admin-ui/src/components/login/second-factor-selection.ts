/**
 * Shared passkey-arm visibility gate + second-factor selection, used by
 * BOTH login-page stages:
 *   • `PrimaryLoginMethods` (primary stage — "Or continue with…")
 *   • `Login.tsx` (second-factor stage — the 2FA challenge phase)
 *
 * Centralizing this closes a footgun the two call sites used to each
 * re-derive independently: the second-factor phase must choose the
 * native `passkey` ceremony ONLY when a `passkey` arm exists AND passes
 * the visibility gate (browser support + origin/rpId, see
 * `passkey-gate.ts`) — never merely because a `passkey` arm was
 * CONTRIBUTED. A passkey-enrolled user on a raw-IP origin (gate fails)
 * must still see the MF `widget` fallback; falling back only on
 * "no passkey arm at all" left them with neither surface.
 */
import { browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { passkeyUsableOnOrigin } from './passkey-gate'
import type { LoginMethod, PasskeyLoginMethod, WidgetLoginMethod } from './PrimaryLoginMethods'

/**
 * Reads the hostname the gate checks against. A plain function param
 * (not a component prop) — injectable so `isPasskeyMethodUsable` /
 * `selectSecondFactorMethods` are unit-testable without touching
 * `window.location`; defaults to the live browser global everywhere
 * else, so callers never need to pass one.
 */
export type HostnameGetter = () => string

const defaultHostnameGetter: HostnameGetter = () => window.location.hostname

/**
 * Visibility gate for a single `passkey` login-method arm: the browser
 * must expose the WebAuthn API AND the current origin must be usable
 * with the addon's effective `rpId` (see `passkey-gate.ts`). The SOLE
 * gate check — both stages call this instead of re-deriving it.
 */
export function isPasskeyMethodUsable(
  method: PasskeyLoginMethod,
  getHostname: HostnameGetter = defaultHostnameGetter,
): boolean {
  return browserSupportsWebAuthn() && passkeyUsableOnOrigin(getHostname(), method.rpId)
}

export interface SecondFactorMethodSelection {
  /** `passkey` second-factor arms that passed the visibility gate. */
  readonly passkeyMethods: readonly PasskeyLoginMethod[]
  /** MF `widget` second-factor arms — populated ONLY when no
   *  `passkeyMethods` are usable (gate failed on every passkey arm, or
   *  none were contributed at all). */
  readonly widgetMethods: readonly WidgetLoginMethod[]
}

/**
 * Selects which second-factor login-method arm(s) `Login.tsx` should
 * render: prefer native `passkey` arms that pass the gate; fall back to
 * the MF `widget` arm(s) only when NO passkey arm is usable — covering
 * both "no passkey arm contributed" (an addon-auth predating the
 * declarative-login rollout) AND "a passkey arm exists but the gate
 * failed" (e.g. a raw-IP origin) — the case the un-gated fallback used
 * to miss.
 */
export function selectSecondFactorMethods(
  methods: readonly LoginMethod[],
  getHostname: HostnameGetter = defaultHostnameGetter,
): SecondFactorMethodSelection {
  const passkeyArms = methods.filter(
    (m): m is PasskeyLoginMethod => m.kind === 'passkey' && m.stage === 'second-factor',
  )
  const passkeyMethods = passkeyArms.filter((m) => isPasskeyMethodUsable(m, getHostname))
  const widgetMethods =
    passkeyMethods.length > 0
      ? []
      : methods.filter(
          (m): m is WidgetLoginMethod => m.kind === 'widget' && m.stage === 'second-factor',
        )
  return { passkeyMethods, widgetMethods }
}

/**
 * Empty-state guard for the second-factor phase: `true` when the
 * challenge REQUIRES a passkey factor but nothing actionable can render
 * it — no native `passkey` arm passed the gate, no MF `widget` fallback
 * was contributed, AND there is no `totp` factor to fall back to. This
 * is the raw-IP dead-end: a passkey-only 2FA user reaching the hub over
 * a LAN IP would otherwise see a phase with no usable control. The page
 * renders an informational hint in that case instead of a blank card.
 *
 * Pure over its inputs (both selection arrays are already computed by
 * `selectSecondFactorMethods`) so it is trivially unit-testable.
 */
export function needsOriginHint(
  factors: readonly string[],
  selection: SecondFactorMethodSelection,
): boolean {
  const hasPasskeyFactor = factors.includes('passkey')
  const hasUsablePasskey = selection.passkeyMethods.length > 0 || selection.widgetMethods.length > 0
  const hasTotpFallback = factors.includes('totp')
  return hasPasskeyFactor && !hasUsablePasskey && !hasTotpFallback
}
