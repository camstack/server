/**
 * The one place a bearer principal is classified and matched against a
 * `TokenScope` set. Pure — no I/O, no registry, no logger — so the kernel,
 * `server/backend` and any ADDON can share it. It lives in `@camstack/types`
 * for exactly that reason: `scopesAllowDeviceCap` used to live in
 * `@camstack/system`, which addons may not import, so `addon-export-alexa`
 * hand-copied it into `directive-router.ts` and said so in a comment twice.
 * One vector, one derivation.
 *
 * ── What this exists to stop ────────────────────────────────────────────
 *
 * Measured on the live hub, 2026-08-09: an `oauth-access` token minted for the
 * `export-alexa` account link was accepted on
 * `POST /addon/homeassistant-export/command` — a route that actuates PTZ,
 * reboot, the per-camera switches and notification snooze. The addon-route gate
 * verified the JWT signature and checked `isAdmin` for `access: 'admin'` routes
 * and nothing else, so every `access: 'authenticated'` route in the product was
 * reachable by ANY valid hub JWT, including one issued to a different
 * integration, a 60-second single-use authorization CODE, and a 30-day refresh
 * token. See D103.
 */
import type { MethodAccess, TokenScope } from '../schemas/auth-records.js'

// ── HTTP verb → the MethodAccess vocabulary ────────────────────────────

/**
 * The access flavour an HTTP verb asks for. `GET`/`HEAD` read; anything that
 * can change state is at least `create`.
 *
 * An UNRECOGNISED verb resolves to `delete`, the most privileged flavour, so a
 * method nobody thought about fails closed. The inverse default — treating the
 * unknown as `view` — is how a gate quietly stops gating.
 */
export function methodAccessForHttpMethod(method: string): MethodAccess {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'view'
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'create'
    default:
      return 'delete'
  }
}

// ── Scope matchers ─────────────────────────────────────────────────────

/**
 * True if the scope set grants `access` on device-scoped capabilities.
 * A `category:device` grant covers every device cap (the broad grant).
 */
export function scopesAllowDeviceCap(scopes: readonly TokenScope[], access: MethodAccess): boolean {
  return scopes.some(
    (s) => s.type === 'category' && s.target === 'device' && s.access.includes(access),
  )
}

/**
 * True if the scope set names this addon with at least `access`.
 *
 * Deliberately NOT satisfied by `category:device`: a grant over per-camera
 * capabilities says nothing about an addon's own HTTP surface, and conflating
 * the two is precisely the confusion that let an Alexa token drive Home
 * Assistant's command route.
 */
export function scopesAllowAddon(
  scopes: readonly TokenScope[],
  addonId: string,
  access: MethodAccess,
): boolean {
  return scopes.some((s) => s.type === 'addon' && s.target === addonId && s.access.includes(access))
}

// ── Principal classification ───────────────────────────────────────────

/**
 * What a verified JWT actually IS. Every one of these verifies under the same
 * hub secret — that is the whole trap. `jwt.verify` succeeding means "we minted
 * this", never "this is an API credential".
 */
export type BearerPrincipal =
  /** An ordinary user session from `auth.login`. Governed by the user's own scopes. */
  | { readonly kind: 'session' }
  /** An account-linking token issued to an integration. Governed by the grant. */
  | { readonly kind: 'integration'; readonly provider: 'oauth-access' }
  /** Minted for one hand-off step and never meant to authenticate an API call. */
  | { readonly kind: 'not-a-credential'; readonly reason: string }

/**
 * The narrow shape read off a verified JWT payload. Every field optional: the
 * payload arrives as whatever was signed, and a missing discriminator must
 * classify, never throw.
 */
export interface BearerPayloadShape {
  readonly kind?: unknown
  readonly provider?: unknown
  readonly userId?: unknown
  readonly isAdmin?: unknown
  readonly scopes?: unknown
}

/**
 * Classify a VERIFIED JWT payload.
 *
 * A session JWT carries no `kind`. Everything else in this system tags itself:
 * `kind: 'sso-bridge'` for the OAuth/SSO family (discriminated further by
 * `provider`), `kind: 'totp-challenge'` for login leg 1. Only `oauth-access` is
 * an API credential; a code lives in a browser redirect URL and a refresh token
 * belongs to `/token`.
 */
export function classifyBearerPrincipal(payload: BearerPayloadShape): BearerPrincipal {
  const kind = payload.kind
  if (kind === undefined) return { kind: 'session' }
  if (kind !== 'sso-bridge') {
    return { kind: 'not-a-credential', reason: `bridge token kind=${String(kind)}` }
  }
  const provider = payload.provider
  if (provider === 'oauth-access') return { kind: 'integration', provider: 'oauth-access' }
  return { kind: 'not-a-credential', reason: `bridge token provider=${String(provider)}` }
}

// ── The gate ───────────────────────────────────────────────────────────

export interface PrincipalAddonReachInput {
  readonly principal: BearerPrincipal
  readonly scopes: readonly TokenScope[]
  readonly isAdmin: boolean
  readonly addonId: string
  /** The HTTP verb of the request being gated. */
  readonly method: string
}

/**
 * The verdict, with the reason carried so the refusal can be LOGGED. A branch
 * that drops a request silently reads as "never happened".
 */
export type PrincipalAddonReachVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

/**
 * May this principal reach `/addon/<addonId>/…` on an `authenticated` route or
 * data-plane endpoint?
 *
 * Three principals, three answers:
 *
 *  - **session** — unchanged. A user session is governed by the route's own
 *    `access` (`authenticated` / `admin`), exactly as before. Tightening HERE
 *    would lock every non-admin viewer out of recorder playback, snapshot media
 *    and the stream-broker embed, which is a worse outcome than the hole.
 *  - **integration** — must hold `addon:<addonId>` at the verb's access. This is
 *    the same rule the scoped-token branch has always applied; the JWT
 *    branch simply never applied it, and closing that divergence IS the fix.
 *    `isAdmin` is ignored: an integration token is minted `isAdmin: false` and a
 *    token claiming otherwise must not talk its way past the grant.
 *  - **not-a-credential** — refused unconditionally.
 */
export function principalMayReachAddon(
  input: PrincipalAddonReachInput,
): PrincipalAddonReachVerdict {
  const { principal } = input
  if (principal.kind === 'not-a-credential') {
    return { allowed: false, reason: principal.reason }
  }
  if (principal.kind === 'session') return { allowed: true }

  const access = methodAccessForHttpMethod(input.method)
  if (scopesAllowAddon(input.scopes, input.addonId, access)) return { allowed: true }
  return {
    allowed: false,
    reason: `integration token holds no addon:${input.addonId}[${access}] grant`,
  }
}
