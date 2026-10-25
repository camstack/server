/**
 * Auth router — core API for login/logout/me.
 *
 * Login validates credentials via the `user-management` capability
 * (owned by the local-auth addon) and signs a JWT.
 *
 * JWT signing stays in the server — it's a transport-level concern
 * (the server owns the secret and the HTTP session).
 *
 * Pre-auth login surfaces (OIDC redirect buttons + the
 * passkey second-factor widget) are aggregated for the login page by the
 * public `listLoginMethods` procedure from the `login-method` cap
 * collection — the single, generic mechanism every auth addon contributes
 * to (superseding the removed `auth.listProviders`).
 */

import type { CapabilityRegistry } from '@camstack/system'
import type { ILoginMethodProvider, IScopedLogger } from '@camstack/types'
import {
  advertisedHubOrigins,
  DEVICE_CERT_SIGNATURE,
  DEVICE_SIGNATURE_MESSAGE_VERSION,
  DeviceCertificateLoginMethodSchema,
  MethodAccessSchema,
  parseAppAuthCallback,
  pickRequestOrigin,
  PasskeyLoginMethodSchema,
  PasskeySummarySchema,
  RedirectLoginMethodSchema,
  ServerNameInfoSchema,
  summarizeEffectiveScope,
  UserScopeSchema,
  ViewerFeatureIdSchema,
  WidgetLoginMethodSchema,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { AuthNetworkPolicy } from '../../auth/auth-network-policy.js'
import { DEFAULT_AUTH_NETWORK_POLICY } from '../../auth/auth-network-policy.js'
import { APP_PASSKEY_PATH } from '../../auth/app-passkey-routes.js'
import { createRateLimiter, type RateLimiter } from '../../auth/auth-rate-limit.js'
import { isAuthAddonDisabled } from '../../auth/auth-provider-gate.js'
import { DeviceEnrollProofs } from '../../auth/device-enroll-proofs.js'
import { ExternalLinkIntents } from '../../auth/external-link-intents.js'
import type { NativeLinkCompletions, ParkedNativeLink } from '../../auth/native-link-completions.js'
import {
  FinishRegistrationSchema,
  OptionsJsonSchema,
  resolvePasskeyProvider,
  SecondFactorPreferenceSchema,
  SetSecondFactorPreferenceSchema,
} from '../../auth/passkey-provider.js'
import {
  collectSecondFactors,
  type SecondFactor,
  SecondFactorSchema,
} from '../../auth/second-factors.js'
import { readSessionCookieFromHeader } from '../../auth/session-cookie.js'
import { userManagementInternal } from '../../auth/hub-sessions.js'
import {
  createSessionMinter,
  type CredentialGate,
  type SessionBacking,
  type SessionIssue,
  SessionRefreshRefusedError,
  SessionUserGoneError,
} from '../../auth/session-mint.js'
import type { AuthService } from '../../core/auth/auth.service.js'
import { HandoffCodeService } from '../../core/auth/handoff-code.service.js'
import type { MoleculerService } from '../../core/moleculer/moleculer.service.js'
import type { TrpcRequest } from '../trpc/trpc.context.js'
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  trpcRouter,
} from '../trpc/trpc.middleware.js'
import {
  type AuthLimiters,
  assertAccountNotLocked,
  limitByClient,
  limitByUser,
  PROCESS_AUTH_LIMITERS,
  recordAccountFailure,
} from './auth-limits.js'
import { createAuthAuditProcedures } from './auth-audit.procedures.js'
import { createTokenProcedures } from './auth-tokens.procedures.js'
import type { CredentialTokenService } from '../../core/auth/credential-token.service.js'
import { createRevokeCredentialsProcedures } from './auth-revoke-credentials.procedures.js'
import {
  assertReauthenticated,
  createReauthProcedures,
  ReauthTokenInput,
} from './auth-reauth.procedures.js'
import { createDeviceCertProcedures } from './auth-device-cert.procedures.js'
import { createSessionProcedures } from './auth-sessions.procedures.js'
import { serverNameReaderFor } from './server-name.js'
import { capabilityScopesOf, userError } from '@camstack/types'
import { trpcUserError } from '../trpc/user-error.js'

/**
 * A public procedure limited per (procedure, REAL client address) — see
 * `auth-limits.ts` for the tiers and why the address is the forwarded client.
 */
function makeRateLimitedProcedure(limiter: RateLimiter, network: AuthNetworkPolicy) {
  return publicProcedure.use(({ ctx, path, next }) => {
    limitByClient(limiter, path, ctx.req, network)
    return next({ ctx })
  })
}

/** Router-level knobs that are not services: the network policy and the limiters. */
export interface AuthRouterOptions {
  /** Real client address + trusted networks; default trusts loopback only. */
  readonly network?: AuthNetworkPolicy
  /** Override the process-wide limiters (specs). */
  readonly limiters?: AuthLimiters
  /**
   * The login-session table the mint opens sessions in (`hub-sessions.ts`).
   * Absent only in specs that test claims: tokens then carry no `sid`.
   */
  readonly sessions?: () => SessionBacking | null
  /** The device-credential registry the refresh path re-checks (D855). Absent: credential sessions fail closed. */
  readonly credentials?: () => CredentialGate | null
  /** Auth log scope: handoff refusals, device-certificate refusals. */
  readonly logger?: IScopedLogger
  /** Override the step-up proof store (specs). */
  readonly enrollProofs?: DeviceEnrollProofs
  /** Override how the hub origin of a request is resolved (specs). */
  readonly resolveOrigin?: (req: TrpcRequest | undefined) => Promise<string | null>
  /** The one token store (D892). Absent: every mint, list and revoke refuses. */
  readonly credentialTokens?: CredentialTokenService | null
}

/** A step-up's sign-in may be at most this old (D855). */
const STEP_UP_FRESH_MS = 120_000
/** Login methods that count as an authentication (a handoff / exchange / certificate session does not). */
const STEP_UP_LOGIN_METHODS: readonly string[] = ['password', 'passkey', 'sso']

/** Asks for the refresh-token flow (short access token + rotating refresh token). */
const RefreshableInput = z.boolean().optional()

/** The request's User-Agent, trimmed, for the sessions list. */
function clientLabel(req: TrpcRequest | undefined): string | undefined {
  const ua = req?.headers['user-agent']
  const value = Array.isArray(ua) ? ua[0] : ua
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : undefined
}

/**
 * Signed-in legs that mint or redeem a one-time code for the CALLER (native
 * link claim, browser handoff — D801): per user, not per ip, because the
 * caller is known and a tunnel puts every client behind one address.
 */
const SELF_CODE_LIMITER = createRateLimiter({ windowMs: 60_000, max: 10 })
const selfCodeProcedure = protectedProcedure.use(({ ctx, path, next }) => {
  const verdict = SELF_CODE_LIMITER.check(`${path}:${ctx.user?.id ?? 'anonymous'}`)
  if (!verdict.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Too many attempts — retry in ${verdict.retryAfterSeconds}s`,
    })
  }
  return next({ ctx })
})

/**
 * What the native link and browser-handoff legs need from the hub (D801).
 * `link` is the SSO finish's own identity-link step, passed in so the claim
 * applies exactly the conflict rule the browser finish does.
 */
export interface NativeLinkRouterDeps {
  readonly completions: NativeLinkCompletions
  readonly link: (input: ParkedNativeLink) => Promise<'linked' | 'conflict'>
  /** One-time codes that open the hub's account page signed in, in a browser. */
  readonly browserHandoffs: HandoffCodeService
}

/** The hub route a browser-handoff code is redeemed at (`main.ts`). */
export const BROWSER_HANDOFF_PATH = '/api/auth/browser-handoff'

/**
 * The available second-factor kinds a user may satisfy after the
 * password leg. Capability-driven — `totp` maps to the
 * `user-management` cap's TOTP surface, `passkey` to ANY provider of
 * the `user-passkeys` cap. The client renders a chooser from this list
 * so a future alternate 2FA cap works with zero login-flow changes.
 */
// `SecondFactorSchema` lives in `auth/second-factors.ts` (shared with the SSO finish).

/**
 * Login response.
 *
 *   • `secondFactors` empty / absent: the credentials were sufficient,
 *     `token` is the real session JWT.
 *   • `secondFactors` non-empty: the user has one or more second
 *     factors enrolled. `token` is a short-lived (5 min) challenge
 *     token, NOT a session. The client presents the factor chooser and
 *     completes ONE of: `loginVerifyTotp` (`totp`) or
 *     `loginBeginPasskey` + `loginVerifyPasskey` (`passkey`). Only on
 *     success does the server mint the real session.
 *
 * `requiresTotp` is retained (`= secondFactors.includes('totp')`) for
 * backward compatibility with older SDK builds that branch on it.
 */
const LoginResultSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    username: z.string(),
    isAdmin: z.boolean(),
  }),
  requiresTotp: z.boolean().optional(),
  secondFactors: z.array(SecondFactorSchema).optional(),
  /** When the access token expires (epoch ms). Absent on a challenge. */
  expiresAt: z.number().optional(),
  /** The server-side login session. */
  sessionId: z.string().optional(),
  /** When the session expires unless refreshed (epoch ms). */
  sessionExpiresAt: z.number().optional(),
  /**
   * Only when the client asked (`refreshable: true`): swap it at
   * `auth.refreshSession` before `expiresAt`. Store it like a password.
   */
  refreshToken: z.string().optional(),
})
type LoginResult = z.infer<typeof LoginResultSchema>

// ── Login-method aggregation (login-method cap) ──────────────────────
//
// The PUBLIC `listLoginMethods` procedure walks the `login-method`
// collection and returns the union that the login page renders directly:
// `redirect` buttons (OIDC), native `passkey` ceremonies, and
// (generic mechanism, unused by shipped addons) pre-auth `widget`s.
// The widget arm is enriched server-side with a public `bundleUrl` from
// `addonId` + `bundle`, so the addon never encodes the static-route
// scheme. The version is a PATH prefix (`v<…>/`), not a `?v=` query, so the
// bundle's relative sibling imports inherit it and a CDN busts the WHOLE
// bundle atomically on deploy (see the stamping site below). `redirect` and
// `passkey` arms pass through untouched — no server-side enrichment needed.
const PublicWidgetLoginMethodSchema = WidgetLoginMethodSchema.extend({
  bundleUrl: z.string(),
})

/** Stable per hub PROCESS — busts the login widget bundle URL on each
 *  restart/deploy while caching cleanly within the process's uptime. */
const AUTH_BUNDLE_VERSION = String(Date.now())
// Every arm of the PUBLIC list says how a native app starts it (D858): the hub
// always sends `app` (`null` when there is no app path - the viewer hides the
// method). It stays optional in the TYPE so the admin-ui's hand-mirrored arms,
// which never read it, keep matching this union.
const PublicRedirectLoginMethodSchema = RedirectLoginMethodSchema
const PublicPasskeyLoginMethodSchema = PasskeyLoginMethodSchema
const PublicLoginMethodSchema = z.discriminatedUnion('kind', [
  PublicRedirectLoginMethodSchema,
  PublicWidgetLoginMethodSchema,
  PublicPasskeyLoginMethodSchema,
  DeviceCertificateLoginMethodSchema,
])

/** One of the caller's linked sign-in identities, as the profile shows it (D782). */
const OwnExternalIdentitySchema = z.object({
  provider: z.string(),
  subject: z.string(),
  label: z.string().optional(),
  linkedAt: z.number(),
  /** The provider instance's button label, or `null` when it is gone / disabled. */
  providerLabel: z.string().nullable(),
  /** Whether the provider instance is configured and enabled right now. */
  available: z.boolean(),
})

/**
 * Token minting/management surfaces are for REAL user sessions only.
 * A minted token — whatever its scopes — must never mint handoff codes or
 * link sign-in accounts: a leaked restricted token would otherwise widen its
 * own reach.
 */
function assertRealUserSession(user: { readonly userDelegated?: boolean }, what: string): void {
  // A minted token (admin, scoped or share-view) is a script's
  // credential, never a person's: it must not turn itself into a session
  // (handoff codes) or mint links. Provenance, not permission (D892).
  if (user.userDelegated !== true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${what} requires a real user session`,
    })
  }
}

// ── Session exchange (viewer same-origin session reuse) ──────────────
//
// The viewer web build is served by the hub under `/viewer/camstack/`
// — SAME ORIGIN as the admin-ui. After an admin-ui login the session
// JWT is mirrored into the httpOnly `camstack_session` cookie
// (`POST /api/auth/session`); `auth.exchangeSession` lets the viewer
// upgrade that cookie back into a bearer token WITHOUT ever reading the
// cookie from JS (it's httpOnly — the browser attaches it, the server
// answers with a freshly-minted session).

/** Custom header a cross-site form can never set — CSRF gate for the
 *  cookie-authenticated `exchangeSession` mutation. */
export const EXCHANGE_SESSION_HEADER = 'x-camstack-exchange'

/** Read a single-valued request header off the tRPC context request. */
function readRequestHeader(req: TrpcRequest | undefined, name: string): string | null {
  const value = req?.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

/** Per-access device reach summary (counts, never id lists). */
const DeviceReachSummarySchema = z.object({
  all: z.boolean(),
  deviceCount: z.number().int(),
})

/** One capability/addon grant flattened for the UI. */
const ScopeGrantSummarySchema = z.object({
  name: z.string(),
  access: z.array(MethodAccessSchema).readonly(),
})

/**
 * The caller's RESOLVED effective scope (scope model v3). Selectors are
 * expanded against the live fleet to counts/flags — never raw id lists — so
 * the viewer (F3/F4) can HIDE out-of-scope surfaces from a single probe. A
 * non-admin with zero grants reports zero everything (born with no access).
 */
const EffectiveScopeSchema = z.object({
  isAdmin: z.boolean(),
  /** `admin`, `viewer` (D921), or `scoped` — a legacy grant set not yet converted. */
  role: z.enum(['admin', 'viewer', 'scoped']),
  /** The viewer features granted (D921); empty for every other role. */
  features: z.array(ViewerFeatureIdSchema).readonly(),
  allDevicesViewable: z.boolean(),
  viewableDeviceCount: z.number().int(),
  device: z.object({
    view: DeviceReachSummarySchema,
    create: DeviceReachSummarySchema,
    delete: DeviceReachSummarySchema,
  }),
  system: z.array(MethodAccessSchema).readonly(),
  capabilities: z.array(ScopeGrantSummarySchema).readonly(),
  addons: z.array(ScopeGrantSummarySchema).readonly(),
})

/** Wire shape of the authenticated user returned by `auth.me`. */
const MeSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    isAdmin: z.boolean(),
    permissions: z.object({
      isAdmin: z.boolean(),
      allowedProviders: z.union([z.literal('*'), z.array(z.string())]),
      allowedDevices: z.record(z.string(), z.unknown()),
    }),
    isApiKey: z.boolean(),
    /**
     * The caller's resolved effective scope. Absent only on the (unreachable
     * here — `me` is `protected`) null-principal branch.
     */
    scope: EffectiveScopeSchema.optional(),
  })
  .nullable()

export function createAuthRouter(
  auth: AuthService,
  registry: CapabilityRegistry | null,
  moleculer: MoleculerService | null = null,
  handoffCodes: HandoffCodeService = new HandoffCodeService(),
  linkIntents: ExternalLinkIntents = new ExternalLinkIntents(),
  nativeLink: NativeLinkRouterDeps | null = null,
  options: AuthRouterOptions = {},
) {
  const network = options.network ?? DEFAULT_AUTH_NETWORK_POLICY
  const limiters = options.limiters ?? PROCESS_AUTH_LIMITERS
  /** Secret-verifying legs (password / TOTP / passkey assertion / codes). */
  const credentialProcedure = makeRateLimitedProcedure(limiters.credential, network)
  /** Challenge-minting begin-legs — looser, they verify nothing. */
  const ceremonyProcedure = makeRateLimitedProcedure(limiters.ceremony, network)
  const credentialTokens = options.credentialTokens ?? null

  /**
   * THE session mint (`auth/session-mint.ts`, D712) — the single shared tail
   * of every successful login leg, including `/api/auth/sso/finish`. It
   * re-reads the user record so scopes / allowedDevices / isAdmin reflect any
   * admin change made mid-flow; signing from stale claims could mint a
   * stale-scope session.
   */
  const minter = createSessionMinter({
    signer: auth,
    directory: () => registry?.getSingleton('user-management'),
    ...(options.sessions !== undefined ? { sessions: options.sessions } : {}),
    credentials:
      options.credentials ??
      (() => {
        const internal = registry === null ? null : userManagementInternal(registry)
        return internal === null ? null : internal.deviceCredentials
      }),
  })
  const findUserById = minter.findUser
  /** How THIS request's login is recorded on its session. */
  const issueFor = (
    req: TrpcRequest | undefined,
    method: SessionIssue['method'],
    refreshable: boolean | undefined,
  ): SessionIssue => {
    const client = clientLabel(req)
    const ip = network.clientAddress(req).ip
    return {
      method,
      refreshable: refreshable === true,
      ...(client !== undefined ? { client } : {}),
      ...(ip !== null ? { ip } : {}),
    }
  }
  const mintSessionForUserId = (userId: string, issue: SessionIssue) =>
    minter.mintForUserId(userId, issue)

  /**
   * `mintSessionForUserId` with the "user vanished" failure mapped to a
   * clean 401 — for the token-exchange legs (`exchangeSession`,
   * `redeemHandoffCode`) where the caller presented a credential whose
   * backing user may have been deleted mid-flight. Infrastructure
   * failures (user-management cap not registered) still surface as 500.
   */
  const mintSessionOrUnauthorized = async (
    userId: string,
    issue: SessionIssue,
  ): Promise<LoginResult> => {
    try {
      return await mintSessionForUserId(userId, issue)
    } catch (error: unknown) {
      if (error instanceof SessionUserGoneError) {
        throw trpcUserError('UNAUTHORIZED', 'auth.user-gone', undefined, 'User no longer exists')
      }
      throw error
    }
  }

  /** The second factors a primary login still owes (`auth/second-factors.ts`). */
  const collectSecondFactorsFor = async (
    userId: string,
    primary: 'password' | 'passkey',
  ): Promise<SecondFactor[]> => {
    const userMgmt = registry?.getSingleton('user-management')
    return collectSecondFactors(
      {
        ...(userMgmt && typeof userMgmt.getTotpStatus === 'function'
          ? { getTotpStatus: (input: { userId: string }) => userMgmt.getTotpStatus(input) }
          : {}),
        passkeyProvider: () => resolvePasskeyProvider(registry, moleculer),
      },
      userId,
      primary,
    )
  }

  /**
   * The second factors THIS login owes: none when the operator listed a
   * trusted network, the request came DIRECTLY from it (never through the
   * tunnel or any proxy — `auth-network-policy.ts`), and the user has
   * factors to skip. Every skip is audited.
   */
  const factorsOwedHere = async (
    userId: string,
    primary: 'password' | 'passkey',
    req: TrpcRequest | undefined,
  ): Promise<SecondFactor[]> => {
    const factors = await collectSecondFactorsFor(userId, primary)
    if (factors.length === 0) return factors
    const address = network.clientAddress(req)
    if (!network.isTrustedNetworkLogin(address)) return factors
    const internal = registry === null ? null : userManagementInternal(registry)
    if (internal === null) return factors // cannot audit it → do not skip it
    await internal.audit.record({
      action: 'second-factor-skipped',
      userId,
      ...(address.ip !== null ? { ip: address.ip } : {}),
      detail: { method: primary, factors: factors.join(',') },
    })
    return []
  }

  /**
   * The login page's methods: every enabled auth addon's `login-method`
   * contributions (D777), validated and deduplicated. Shared by
   * `listLoginMethods` and the D782 linking procedures.
   */
  /**
   * The hub origin a device-certificate challenge is bound to: the origin the
   * request CLAIMS when the hub advertises it (Network page / address book),
   * else the public endpoint — never a forged `Host` (same rule as the OIDC
   * return, D791).
   */
  const resolveDeviceOrigin =
    options.resolveOrigin ??
    (async (req: TrpcRequest | undefined): Promise<string | null> => {
      const provider = registry?.getSingleton('local-network')
      if (!provider) return null
      const book = await provider.getAddresses({})
      const headers: Record<string, string | undefined> = {}
      for (const [name, value] of Object.entries(req?.headers ?? {})) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value
      }
      const picked = pickRequestOrigin(headers, advertisedHubOrigins(book))
      return (
        picked ??
        book.roles.publicEndpoint.resolved ??
        book.roles.appConnections.resolved[0] ??
        null
      )
    })
  const enrollProofs =
    options.enrollProofs ?? new DeviceEnrollProofs(Date.now, options.logger ?? null)

  /** The device credential behind a session, so a session minted FROM it inherits it (D855). */
  const credentialOfSession = (sessionId: string | undefined): string | undefined => {
    if (sessionId === undefined || registry === null) return undefined
    const check = userManagementInternal(registry)?.sessions.check(sessionId)
    return check?.state === 'active' ? (check.session.credentialId ?? undefined) : undefined
  }

  /**
   * A step-up (the proof that lets a device enroll itself) needs an
   * authentication that JUST happened - never a session that merely exists:
   *  - a single-use `reauthToken` (password / passkey re-authentication), or
   *  - a session that was OPENED by a primary login (password, passkey, SSO)
   *    at most {@link STEP_UP_FRESH_MS} ago, once. A session born of a handoff,
   *    a cookie exchange or a device certificate is not an authentication.
   */
  const assertFreshAuthentication = (
    user: { id: string; sessionId?: string },
    reauthToken: string | undefined,
  ): void => {
    const refuse = (message: string): never => {
      options.logger?.warn(`Step-up refused: ${message}`, { tags: { userId: user.id } })
      throw new TRPCError({ code: 'FORBIDDEN', message: `Sign in again first: ${message}` })
    }
    if (reauthToken !== undefined) {
      assertReauthenticated(auth, user, reauthToken)
      if (!enrollProofs.consumeReauth(reauthToken)) refuse('that confirmation was already used')
      return
    }
    const sid = user.sessionId
    const check =
      sid === undefined || registry === null
        ? null
        : userManagementInternal(registry)?.sessions.check(sid)
    if (check?.state !== 'active') return refuse('no live session')
    if (!STEP_UP_LOGIN_METHODS.includes(check.session.method)) {
      return refuse('this session was not opened by a sign-in')
    }
    if (Date.now() - check.session.createdAt > STEP_UP_FRESH_MS) {
      return refuse('the sign-in is too old')
    }
    if (sid === undefined || !enrollProofs.claimFreshSession(sid, check.session.createdAt)) {
      return refuse('this sign-in already started a step-up')
    }
  }

  const serverNameReader = serverNameReaderFor(registry)
  const aggregateLoginMethods = async (): Promise<z.infer<typeof PublicLoginMethodSchema>[]> => {
    if (!registry) return []
    const out: z.infer<typeof PublicLoginMethodSchema>[] = []
    // Defense-in-depth dedupe: a routing bug in a grouped runner once
    // resolved every provider to the same addon (3× identical login
    // buttons) — a duplicated contribution id must never render twice.
    const seenIds = new Set<string>()
    for (const [addonId, provider] of registry.getCollectionEntries<ILoginMethodProvider>(
      'login-method',
    )) {
      // The operator's Enable/Disable on Identity → Authentication is the
      // addon's ONE enable (D777). It toggles `auth-provider` /
      // `user-passkeys`, never `login-method` — so ask the governing caps.
      if (isAuthAddonDisabled(registry, addonId)) continue
      let contributions: Awaited<ReturnType<ILoginMethodProvider['getLoginMethods']>>
      try {
        contributions = await provider.getLoginMethods()
      } catch {
        continue
      }
      for (const raw of contributions) {
        if (seenIds.has(raw.id)) continue
        if (raw.kind === 'redirect') {
          const parsed = PublicRedirectLoginMethodSchema.safeParse({
            ...raw,
            app: raw.app ?? null,
          })
          if (parsed.success) {
            out.push(parsed.data)
            seenIds.add(parsed.data.id)
          }
          continue
        }
        if (raw.kind === 'passkey') {
          // Native ceremony — passes through untouched, no server-side
          // enrichment (rpId/origin are already stamped by the addon).
          // The passkey page is the hub's own (D858): the primary arm runs in the
          // system browser at it; a second-factor ceremony has no app path.
          const parsed = PublicPasskeyLoginMethodSchema.safeParse({
            ...raw,
            app: raw.stage === 'primary' ? { kind: 'browser', startPath: APP_PASSKEY_PATH } : null,
          })
          if (parsed.success) {
            out.push(parsed.data)
            seenIds.add(parsed.data.id)
          }
          continue
        }
        // Widget arm — stamp a public bundleUrl with the version in the
        // PATH, not a `?v=` query. Module-Federation bundles import their
        // fixed-name siblings (`./_stub.js`) by RELATIVE url, which never
        // inherit a query — so a `?v=` busts only the entry and a CDN edge
        // keeps serving a stale `_stub.js` (missing the newest widget). A
        // path prefix makes every relative import inherit it → one atomic
        // whole-bundle cache miss per deploy, on any CDN. `AUTH_BUNDLE_VERSION`
        // is stable per hub process (busts on restart/deploy, caches within
        // uptime). The `/api/addon-widgets` route strips the `v<…>/` segment.
        const parsed = PublicWidgetLoginMethodSchema.safeParse({
          ...raw,
          app: null,
          bundleUrl: `/api/addon-widgets/${raw.addonId}/v${AUTH_BUNDLE_VERSION}/${raw.bundle}`,
        })
        if (parsed.success) {
          out.push(parsed.data)
          seenIds.add(parsed.data.id)
        }
      }
    }
    // The hub's own method (D855): a device certificate. Not an addon
    // contribution - the device CA lives in `local-auth` - so it is added here.
    // Offered only where the hub can actually serve it (local-auth up).
    if (userManagementInternal(registry) !== null)
      out.push({
        kind: 'device-certificate',
        id: 'device-certificate',
        label: 'This device',
        stage: 'primary',
        challengePath: 'auth.getDeviceChallenge',
        loginPath: 'auth.loginWithDeviceCertificate',
        renewPath: 'auth.renewDeviceCertificate',
        revokePath: 'auth.revokeOwnDeviceCertificate',
        enrollSelfPath: 'auth.enrollSelf',
        signature: DEVICE_CERT_SIGNATURE,
        messageVersion: DEVICE_SIGNATURE_MESSAGE_VERSION,
        clients: ['native'],
        app: { kind: 'native' },
      })
    return out
  }

  /**
   * Sign-in providers a signed-in user may link (D782): an enabled provider's
   * redirect method that declares `linkable: true` — the contract, not its id.
   */
  const linkableProviders = async (): Promise<
    { readonly provider: string; readonly label: string; readonly startUrl: string }[]
  > =>
    (await aggregateLoginMethods()).flatMap((m) =>
      m.kind === 'redirect' && m.linkable === true
        ? [{ provider: m.id, label: m.label, startUrl: m.startUrl }]
        : [],
    )

  return trpcRouter({
    login: credentialProcedure
      .input(
        z.object({ username: z.string(), password: z.string(), refreshable: RefreshableInput }),
      )
      .output(LoginResultSchema)
      .mutation(async ({ input, ctx }) => {
        const userMgmt = registry?.getSingleton('user-management')
        if (!userMgmt) {
          // The local-auth addon owns this cap. When this fires the
          // addon either failed to initialize or is still booting.
          // Check the server log for `[hub/local-auth]` errors —
          // common cause is a settings-store regression that breaks
          // the `users` collection query path.
          throw new Error(
            'Login unavailable — `user-management` capability not registered. ' +
              'The `local-auth` addon failed to initialize; check server logs ' +
              'for an error tagged `[hub/local-auth]`.',
          )
        }

        assertAccountNotLocked(limiters, input.username)
        const user = await userMgmt.validateCredentials({
          username: input.username,
          password: input.password,
        })
        if (!user) {
          recordAccountFailure(limiters, input.username)
          throw userError('auth.invalid-credentials', undefined, 'Invalid credentials')
        }

        // ── Second-factor gate ───────────────────────────────────────
        // After credentials validate, collect every ACTIVE second
        // factor (TOTP when enrolled; passkey only when enrolled AND
        // the user opted in — see `collectSecondFactors`). If ANY is
        // present, mint a SHORT-LIVED challenge token instead of the
        // real session — the client must complete one factor before we
        // hand out the actual JWT. The challenge token carries
        // `kind: 'totp-challenge'` so it can't be replayed against
        // protected endpoints (the auth middleware rejects anything
        // without the standard session shape); the same token binds
        // both the TOTP and the passkey second legs (same userId).
        const secondFactors = await factorsOwedHere(user.id, 'password', ctx.req)
        if (secondFactors.length > 0) {
          const challengeToken = auth.signTotpChallengeToken({
            userId: user.id,
            username: user.username,
            isAdmin: user.isAdmin,
            method: 'password',
          })
          return {
            token: challengeToken,
            user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
            requiresTotp: secondFactors.includes('totp'),
            secondFactors,
          }
        }

        // `user` is the record `validateCredentials` just read — fresh.
        return minter.mintForRecord(user, issueFor(ctx.req, 'password', input.refreshable))
      }),

    /**
     * Second leg of the 2FA login. Accepts the challenge token minted
     * by `login` (when `requiresTotp: true`) plus the operator-entered
     * 6-digit code. Re-validates both, then mints the real session.
     *
     * Failure modes:
     *   • Invalid/expired challenge token → 401 (session timed out,
     *     restart login).
     *   • Code doesn't match → 401 (try again with a fresh code from
     *     the authenticator app).
     *   • User vanished between leg 1 and leg 2 → 401 (operator was
     *     deleted concurrently — rare).
     */
    loginVerifyTotp: credentialProcedure
      .input(
        z.object({ challengeToken: z.string(), code: z.string(), refreshable: RefreshableInput }),
      )
      .output(LoginResultSchema)
      .mutation(async ({ input, ctx }) => {
        const claims = auth.verifyTotpChallengeToken(input.challengeToken)
        if (!claims) {
          throw new Error('Invalid or expired TOTP challenge — please re-enter your password')
        }
        const userMgmt = registry?.getSingleton('user-management')
        if (!userMgmt) {
          throw new Error('Login unavailable — `user-management` capability not registered')
        }
        assertAccountNotLocked(limiters, claims.username)
        const verify =
          typeof userMgmt.verifyTotp === 'function'
            ? await userMgmt.verifyTotp({ userId: claims.userId, code: input.code.trim() })
            : { valid: false }
        if (!verify.valid) {
          recordAccountFailure(limiters, claims.username)
          throw userError('auth.invalid-totp', undefined, 'Invalid TOTP code')
        }
        return mintSessionForUserId(
          claims.userId,
          issueFor(ctx.req, claims.method ?? 'password', input.refreshable),
        )
      }),

    /**
     * Passkey second leg — step 1 of 2. Accepts the challenge token
     * minted by `login` and returns the WebAuthn assertion options
     * (`PublicKeyCredentialRequestOptionsJSON`) scoped to the user's
     * enrolled credentials (strict-user `allowCredentials`). PUBLIC —
     * the client is still pre-session at this point.
     */
    loginBeginPasskey: ceremonyProcedure
      .input(z.object({ challengeToken: z.string() }))
      .output(OptionsJsonSchema)
      .mutation(async ({ input }) => {
        const claims = auth.verifyTotpChallengeToken(input.challengeToken)
        if (!claims) {
          throw userError(
            'auth.login-challenge-expired',
            undefined,
            'Invalid or expired login challenge — please re-enter your password',
          )
        }
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey authentication is not available')
        return provider.beginAuthentication({ userId: claims.userId })
      }),

    /**
     * Passkey second leg — step 2 of 2. Accepts the challenge token +
     * the browser assertion (`AuthenticationResponseJSON`). Verifies the
     * assertion via the `user-passkeys` cap and, on success, mints the
     * real session JWT through the SAME `auth.signToken` path
     * `loginVerifyTotp` uses (fresh user re-fetch for up-to-date scopes).
     */
    loginVerifyPasskey: credentialProcedure
      .input(
        z.object({
          challengeToken: z.string(),
          response: z.record(z.string(), z.unknown()),
          refreshable: RefreshableInput,
        }),
      )
      .output(LoginResultSchema)
      .mutation(async ({ input, ctx }) => {
        const claims = auth.verifyTotpChallengeToken(input.challengeToken)
        if (!claims) {
          throw userError(
            'auth.login-challenge-expired',
            undefined,
            'Invalid or expired login challenge — please re-enter your password',
          )
        }
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey authentication is not available')
        assertAccountNotLocked(limiters, claims.username)
        const result = await provider.finishAuthentication({
          userId: claims.userId,
          response: input.response,
        })
        if (!result.verified) {
          recordAccountFailure(limiters, claims.username)
          throw userError(
            'auth.passkey-verification-failed',
            undefined,
            'Passkey verification failed',
          )
        }
        return mintSessionForUserId(
          claims.userId,
          issueFor(ctx.req, claims.method ?? 'password', input.refreshable),
        )
      }),

    /**
     * Usernameless (passkey-FIRST) login — step 1 of 2. PUBLIC. Returns
     * WebAuthn assertion options with an EMPTY `allowCredentials` list
     * (the standard discoverable-credentials flow): the browser offers
     * every resident passkey it holds for this RP and the user picks one
     * — no username, no password. The challenge is minted and stored by
     * the `user-passkeys` provider, deliberately NOT bound to any user.
     *
     * Abuse surface: limited per client address (ceremony tier); the
     * challenge store is bounded by its 5-min TTL prune.
     */
    passkeyLoginBegin: ceremonyProcedure
      .input(z.void())
      .output(OptionsJsonSchema)
      .mutation(async () => {
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey authentication is not available')
        return provider.beginDiscoverableAuthentication({})
      }),

    /**
     * Usernameless login — step 2 of 2. PUBLIC. Submits the browser
     * assertion; the provider resolves the credential's OWNER, verifies
     * the assertion (challenge + public key + counter + required user
     * verification), and on success we mint the SAME session JWT shape
     * `auth.login` mints — via the shared `mintSessionForUserId` tail
     * (fresh user re-fetch for up-to-date scopes).
     *
     * Second-factor gate — SAME rules as `auth.login`: 2FA applies
     * uniformly after any primary method, so an enrolled TOTP bounces
     * this leg to the challenge stage (same challenge-token LoginResult
     * shape, completed via `loginVerifyTotp`). The passkey factor
     * itself is skipped here — the primary factor WAS the passkey, and
     * re-proving it adds nothing.
     */
    passkeyLoginFinish: credentialProcedure
      .input(
        z.object({ response: z.record(z.string(), z.unknown()), refreshable: RefreshableInput }),
      )
      .output(LoginResultSchema)
      .mutation(async ({ input, ctx }) => {
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey authentication is not available')
        const result = await provider.finishDiscoverableAuthentication({
          response: input.response,
        })
        if (!result.verified || !result.userId) {
          throw trpcUserError(
            'UNAUTHORIZED',
            'auth.passkey-verification-failed',
            undefined,
            'Passkey verification failed',
          )
        }
        const secondFactors = await factorsOwedHere(result.userId, 'passkey', ctx.req)
        if (secondFactors.length > 0) {
          const challenged = await findUserById(result.userId)
          const challengeToken = auth.signTotpChallengeToken({
            userId: challenged.id,
            username: challenged.username,
            isAdmin: challenged.isAdmin,
            method: 'passkey',
          })
          return {
            token: challengeToken,
            user: {
              id: challenged.id,
              username: challenged.username,
              isAdmin: challenged.isAdmin,
            },
            requiresTotp: secondFactors.includes('totp'),
            secondFactors,
          }
        }
        return mintSessionForUserId(result.userId, issueFor(ctx.req, 'passkey', input.refreshable))
      }),

    /**
     * PUBLIC — upgrade the browser's httpOnly session COOKIE into a
     * bearer token (viewer same-origin session reuse). Authentication
     * comes from the `camstack_session` cookie ONLY — never from a
     * bearer header — so a hub-served SPA (the viewer under
     * `/viewer/camstack/`) can bootstrap without its own login.
     *
     * Security properties:
     *   • CSRF: mutation (POST) + a REQUIRED custom header
     *     (`x-camstack-exchange: 1`) that a cross-site form can't set;
     *     belt-and-braces on top of the cookie's `SameSite=Lax`
     *     semantics (see `buildSessionCookie` — Lax already withholds
     *     the cookie from cross-site POSTs).
     *   • Only REAL session JWTs qualify: bridge tokens (`kind:
     *     'totp-challenge'` / `'sso-bridge'`) and minted tokens are
     *     rejected — the cookie must carry a v2 session.
     *   • The returned bearer is minted FRESH through the shared
     *     `mintSessionForUserId` tail (re-fetched user → up-to-date
     *     scopes), equivalent to what `auth.login` hands out.
     */
    exchangeSession: credentialProcedure
      .input(z.object({ refreshable: RefreshableInput }).optional())
      .output(LoginResultSchema)
      .mutation(async ({ ctx, input }) => {
        if (readRequestHeader(ctx.req, EXCHANGE_SESSION_HEADER) !== '1') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Missing ${EXCHANGE_SESSION_HEADER} header`,
          })
        }
        const cookieToken = readSessionCookieFromHeader(
          readRequestHeader(ctx.req, 'cookie') ?? undefined,
        )
        if (!cookieToken) {
          throw trpcUserError(
            'UNAUTHORIZED',
            'auth.no-session-cookie',
            undefined,
            'No session cookie',
          )
        }
        let payload
        try {
          payload = auth.verifyToken(cookieToken)
        } catch {
          throw trpcUserError(
            'UNAUTHORIZED',
            'auth.invalid-session-cookie',
            undefined,
            'Invalid session cookie',
          )
        }
        // Reject non-session JWTs that verify under the same secret:
        // challenge/bridge tokens carry a `kind` discriminator, and a
        // v2 session always has a boolean `isAdmin` + string `userId`.
        const kind: unknown = Reflect.get(payload, 'kind')
        if (
          kind !== undefined ||
          typeof payload.isAdmin !== 'boolean' ||
          typeof payload.userId !== 'string'
        ) {
          throw trpcUserError(
            'UNAUTHORIZED',
            'auth.invalid-session-cookie',
            undefined,
            'Invalid session cookie',
          )
        }
        // A session of its own for the client that asked (the hub-served
        // viewer): signing out of one never signs the other out.
        return mintSessionOrUnauthorized(payload.userId, {
          ...issueFor(ctx.req, 'exchange', input?.refreshable),
          ...(payload.cid !== undefined ? { credentialId: payload.cid } : {}),
        })
      }),

    // ── One-time handoff codes (native-app login handoff) ─────────────
    //
    // The admin-ui login page, when its `redirect` param is the app's
    // custom-scheme callback, mints a code AFTER a successful login and
    // bounces to `camstack://auth-callback?code=…`; the app redeems it
    // for a real session. TTL 60s, single-use, bound to the minting
    // user — see `HandoffCodeService`.

    /** Mint a one-time handoff code for the CALLING user. Real user
     *  sessions only — a minted token (scoped, admin or share-view)
     *  must never convert itself into a full session. */
    createHandoffCode: protectedProcedure
      .input(
        z
          .object({
            purpose: z.enum(['renew', 'new-session', 'step-up']).optional(),
            /** PKCE S256 challenge of the app's verifier: redeem then requires the verifier. */
            codeChallenge: z.string().min(43).max(128).optional(),
            /** The app's anti-CSRF state, required again at redeem. */
            state: z.string().min(1).max(256).optional(),
            /** `step-up`: a fresh single-use re-authentication, when the session itself is not a fresh sign-in. */
            reauthToken: ReauthTokenInput.optional(),
          })
          .optional(),
      )
      .output(z.object({ code: z.string(), expiresAt: z.number() }))
      .mutation(({ ctx, input }) => {
        assertRealUserSession(ctx.user, 'Handoff-code minting')
        const purpose = input?.purpose ?? 'renew'
        // A code that ends at an app callback is PKCE-bound and state-bound, always.
        // Only the legacy `renew` pair (installed viewers renewing their own session)
        // may omit them; it ends with D812's retirement of the `renew` handoff.
        if (
          purpose !== 'renew' &&
          (input?.codeChallenge === undefined || input?.state === undefined)
        ) {
          options.logger?.warn('Handoff code refused: PKCE challenge and state are required', {
            tags: { userId: ctx.user.id },
            meta: { purpose },
          })
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'codeChallenge (S256) and state are required for this handoff',
          })
        }
        if (purpose === 'step-up') assertFreshAuthentication(ctx.user, input?.reauthToken)
        // `renew` (the default — what installed viewer apps call this for)
        // continues THIS session; `new-session` (signing the native app in)
        // opens a separate one for the redeemer.
        const credentialId = credentialOfSession(ctx.user.sessionId)
        return handoffCodes.create(ctx.user.id, {
          ...(ctx.user.sessionId !== undefined ? { sessionId: ctx.user.sessionId } : {}),
          ...(credentialId !== undefined ? { credentialId } : {}),
          purpose,
          ...(input?.codeChallenge !== undefined ? { codeChallenge: input.codeChallenge } : {}),
          ...(input?.state !== undefined ? { state: input.state } : {}),
        })
      }),

    /** PUBLIC — redeem a one-time handoff code for a session bearer.
     *  Unknown / expired / already-used codes → UNAUTHORIZED. */
    redeemHandoffCode: credentialProcedure
      .input(
        z.object({
          code: z.string().min(1),
          refreshable: RefreshableInput,
          /** PKCE: required when the code was minted with a `codeChallenge`. */
          codeVerifier: z.string().min(1).max(256).optional(),
          state: z.string().min(1).max(256).optional(),
        }),
      )
      .output(LoginResultSchema)
      .mutation(async ({ input, ctx }) => {
        const redeemed = handoffCodes.redeemWithReason(input.code, {
          ...(input.codeVerifier !== undefined ? { codeVerifier: input.codeVerifier } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
        })
        const grant = redeemed.grant
        // A step-up code only ever yields a device-enroll proof (at
        // `deviceEnrollProofFromHandoff`), never a session.
        if (grant !== null && grant.purpose === 'step-up') {
          options.logger?.warn('Handoff redeem refused: a step-up code is not a login code', {
            tags: { userId: grant.userId },
          })
        } else if (grant === null) {
          options.logger?.warn('Handoff redeem refused', {
            meta: { reason: redeemed.reason ?? 'unknown' },
          })
        }
        if (!grant || grant.purpose === 'step-up') {
          throw trpcUserError(
            'UNAUTHORIZED',
            'auth.handoff-code-invalid',
            undefined,
            'Invalid or expired handoff code',
          )
        }
        // A `renew` code continues THE SESSION IT WAS MINTED FROM. One without a session would
        // open a brand-new session with no PKCE behind it: refused.
        if (grant.purpose === 'renew' && grant.sessionId === undefined) {
          options.logger?.warn('Handoff redeem refused: a renew code with no session behind it', {
            tags: { userId: grant.userId },
          })
          throw trpcUserError(
            'UNAUTHORIZED',
            'auth.handoff-code-invalid',
            undefined,
            'Invalid or expired handoff code',
          )
        }
        if (grant.purpose === 'renew' && grant.sessionId !== undefined) {
          // A legacy client renewing: the SAME session, its expiry slides. A
          // session revoked meanwhile (logout elsewhere) renews nothing.
          try {
            return await minter.continueSession(grant.userId, grant.sessionId)
          } catch (error: unknown) {
            if (
              error instanceof SessionRefreshRefusedError ||
              error instanceof SessionUserGoneError
            ) {
              throw new TRPCError({
                code: 'UNAUTHORIZED',
                message: 'Session expired — sign in again',
              })
            }
            throw error
          }
        }
        return mintSessionOrUnauthorized(grant.userId, {
          ...issueFor(ctx.req, 'handoff', input.refreshable),
          // Minted FROM a credential session: the child dies with the credential.
          ...(grant.credentialId !== undefined ? { credentialId: grant.credentialId } : {}),
        })
      }),

    me: protectedProcedure
      .input(z.void())
      .output(MeSchema)
      .query(({ ctx }) => {
        if (!ctx.user) return null
        // Resolve the effective scope against the live fleet so the viewer can
        // hide surfaces from a single probe (F1 #5). Admins summarise to
        // "everything"; a scoped principal's selectors expand to counts.
        const fleet = ctx.deviceFleet?.() ?? []
        const scope = summarizeEffectiveScope(
          capabilityScopesOf(ctx.user.scopes ?? []),
          fleet,
          ctx.user.isAdmin,
        )
        return { ...ctx.user, scope }
      }),

    /**
     * Resolve a PROPOSED grant set the same way `me` resolves the caller's
     * own — so the Users page can show "12 devices viewable, 2 actionable"
     * BEFORE saving, and the number it shows is the number the matcher will
     * enforce.
     *
     * Deliberately the same two lines as `me` (`summarizeEffectiveScope`
     * over `ctx.deviceFleet()`) rather than a second derivation in the admin
     * UI. A preview computed client-side from the same selectors would be a
     * hand-copied scope check, and those drift (D103) — a preview that
     * disagrees with enforcement is worse than none, because it is trusted.
     *
     * Admin-gated: only an admin edits another user's scopes
     * (`user-management.setUserScopes` is `auth: 'admin'`), and the fleet
     * size / room labels this leaks are admin-visible already. It reads
     * nothing off the caller, so it is not a self-scope oracle.
     *
     * `isAdmin` previews the admin BYPASS — with it set, grants are ignored
     * and the answer is "everything", which is what the panel must show
     * when the operator ticks the Admin box.
     */
    previewScope: adminProcedure
      .input(
        z.object({
          scopes: z.array(UserScopeSchema),
          isAdmin: z.boolean().default(false),
        }),
      )
      .output(EffectiveScopeSchema)
      .query(({ ctx, input }) =>
        summarizeEffectiveScope(input.scopes, ctx.deviceFleet?.() ?? [], input.isAdmin),
      ),

    // ── Self-service profile operations ───────────────────────────────
    //
    // These route through the `user-management` capability provider but
    // bind `userId` to the CALLER's session identity (`ctx.user.id`)
    // — i.e. every authenticated user can manage THEIR OWN password and
    // TOTP enrollment, without the admin gate that the corresponding
    // cap methods enforce on the trpc layer.
    //
    // Provider methods themselves don't check admin status, so calling
    // them directly here is fine. The trpc admin-gate on the cap router
    // exists only to block third-party tampering — operators acting on
    // themselves bypass it intentionally.
    changeOwnPassword: protectedProcedure
      .input(
        z.object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(8),
        }),
      )
      .output(z.object({ success: z.literal(true) }))
      .mutation(async ({ input, ctx }) => {
        const userMgmt = registry?.getSingleton('user-management') as
          | {
              validateCredentials: (i: {
                username: string
                password: string
              }) => Promise<{ id: string } | null>
              resetPassword: (i: { id: string; newPassword: string }) => Promise<{ success: true }>
            }
          | null
          | undefined
        if (!userMgmt) throw new Error('user-management capability not available')
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        // Re-validate the current password against the live store to
        // confirm session identity → password ownership match. Stops a
        // stolen session-token from rotating credentials silently.
        const ok = await userMgmt.validateCredentials({
          username: ctx.user.username,
          password: input.currentPassword,
        })
        // A stable code (D863): the change-password page names this case
        // instead of showing whatever text arrived.
        if (!ok) throw userError('auth.password-incorrect', undefined, 'Password is incorrect')
        // Hub-internal: the password changes AND every other session of the
        // user ends (this one stays signed in).
        const internal = registry === null ? null : userManagementInternal(registry)
        if (internal === null) throw new Error('user-management capability not available')
        await internal.setPassword({
          userId: ctx.user.id,
          newPassword: input.newPassword,
          ...(ctx.user.sessionId !== undefined ? { keepSessionId: ctx.user.sessionId } : {}),
        })
        return { success: true as const }
      }),

    setupOwnTotp: protectedProcedure
      .input(z.void())
      .output(z.object({ secret: z.string(), otpauthUrl: z.string() }))
      .mutation(async ({ ctx }) => {
        const userMgmt = registry?.getSingleton('user-management') as
          | {
              setupTotp: (i: { userId: string }) => Promise<{ secret: string; otpauthUrl: string }>
            }
          | null
          | undefined
        if (!userMgmt) throw new Error('user-management capability not available')
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        return userMgmt.setupTotp({ userId: ctx.user.id })
      }),

    confirmOwnTotp: protectedProcedure
      .input(z.object({ code: z.string().min(1) }))
      .output(z.object({ success: z.literal(true) }))
      .mutation(async ({ input, ctx }) => {
        const userMgmt = registry?.getSingleton('user-management') as
          | { confirmTotp: (i: { userId: string; code: string }) => Promise<{ success: true }> }
          | null
          | undefined
        if (!userMgmt) throw new Error('user-management capability not available')
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        return userMgmt.confirmTotp({ userId: ctx.user.id, code: input.code })
      }),

    disableOwnTotp: protectedProcedure
      // Re-authentication required: a session alone must not strip 2FA.
      .input(z.object({ reauthToken: ReauthTokenInput }).optional())
      .output(z.object({ success: z.literal(true) }))
      .mutation(async ({ ctx, input }) => {
        assertReauthenticated(auth, ctx.user, input?.reauthToken)
        const userMgmt = registry?.getSingleton('user-management') as
          | { disableTotp: (i: { userId: string }) => Promise<{ success: true }> }
          | null
          | undefined
        if (!userMgmt) throw new Error('user-management capability not available')
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        return userMgmt.disableTotp({ userId: ctx.user.id })
      }),

    getOwnTotpStatus: protectedProcedure
      .input(z.void())
      .output(z.object({ enabled: z.boolean(), confirmedAt: z.number().nullable() }))
      .query(async ({ ctx }) => {
        const userMgmt = registry?.getSingleton('user-management') as
          | {
              getTotpStatus: (i: {
                userId: string
              }) => Promise<{ enabled: boolean; confirmedAt: number | null }>
            }
          | null
          | undefined
        if (!userMgmt || !ctx.user) return { enabled: false, confirmedAt: null }
        return userMgmt.getTotpStatus({ userId: ctx.user.id })
      }),

    // ── Self-service passkey enrollment (the signed-in user) ──────────
    //
    // The `user-passkeys` cap gates registration/management as `admin`
    // at the trpc layer. These bind `userId` to `ctx.user.id` and call
    // the provider server-side, so a non-admin user can enroll / revoke
    // THEIR OWN passkeys — the router is the trust boundary, exactly like
    // the TOTP self-service block above. Cap-agnostic: resolved through
    // the `user-passkeys` cap, never an addon id.
    beginOwnPasskeyRegistration: protectedProcedure
      .input(z.void())
      .output(OptionsJsonSchema)
      .mutation(async ({ ctx }) => {
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey enrollment is not available')
        return provider.beginRegistration({ userId: ctx.user.id, username: ctx.user.username })
      }),

    finishOwnPasskeyRegistration: protectedProcedure
      .input(z.object({ response: z.record(z.string(), z.unknown()), label: z.string() }))
      .output(FinishRegistrationSchema)
      .mutation(async ({ input, ctx }) => {
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey enrollment is not available')
        return provider.finishRegistration({
          userId: ctx.user.id,
          response: input.response,
          label: input.label,
        })
      }),

    listOwnPasskeys: protectedProcedure
      .input(z.void())
      .output(z.array(PasskeySummarySchema))
      .query(async ({ ctx }) => {
        if (!ctx.user) return []
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) return []
        try {
          return await provider.listPasskeys({ userId: ctx.user.id })
        } catch {
          return []
        }
      }),

    removeOwnPasskey: protectedProcedure
      // Re-authentication required: removing a passkey can strip a factor.
      .input(z.object({ credentialId: z.string(), reauthToken: ReauthTokenInput.optional() }))
      .output(z.object({ success: z.literal(true) }))
      .mutation(async ({ input, ctx }) => {
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        assertReauthenticated(auth, ctx.user, input.reauthToken)
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey management is not available')
        return provider.removePasskey({ userId: ctx.user.id, credentialId: input.credentialId })
      }),

    /**
     * Own passkey second-factor preference (opt-in, default OFF).
     * Enrolling a passkey only enables passkey-first sign-in; flipping
     * this on additionally demands the passkey as a second factor after
     * every password login. Bound to `ctx.user.id` like the rest of the
     * self-service block; reads degrade to `enabled: false` so the "My
     * access" page renders even while the provider is booting.
     */
    getOwnPasskeySecondFactorPreference: protectedProcedure
      .input(z.void())
      .output(SecondFactorPreferenceSchema)
      .query(async ({ ctx }) => {
        if (!ctx.user) return { enabled: false }
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) return { enabled: false }
        try {
          return await provider.getSecondFactorPreference({ userId: ctx.user.id })
        } catch {
          return { enabled: false }
        }
      }),

    setOwnPasskeySecondFactorPreference: protectedProcedure
      .input(z.object({ enabled: z.boolean() }))
      .output(SetSecondFactorPreferenceSchema)
      .mutation(async ({ input, ctx }) => {
        if (!ctx.user) throw userError('auth.not-authenticated', undefined, 'Not authenticated')
        const provider = resolvePasskeyProvider(registry, moleculer)
        if (!provider) throw new Error('Passkey management is not available')
        return provider.setSecondFactorPreference({
          userId: ctx.user.id,
          enabled: input.enabled,
        })
      }),

    ...createSessionProcedures({ registry, minter, credentialProcedure }),
    ...createDeviceCertProcedures({
      registry,
      minter,
      publicProcedure,
      auth,
      credentialLimiter: limiters.credential,
      ceremonyLimiter: limiters.ceremony,
      selfLimiter: SELF_CODE_LIMITER,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      network,
      enrollProofs,
      handoffCodes,
      resolveOrigin: resolveDeviceOrigin,
      issueFor,
    }),
    ...createReauthProcedures({ auth, registry, moleculer, limiters }),
    ...createAuthAuditProcedures({ registry }),
    ...createTokenProcedures({ auth, registry, network, credentialTokens }),
    ...createRevokeCredentialsProcedures({ registry, network, credentialTokens }),

    // ── External sign-in identities (D782) ────────────────────────
    //
    // A signed-in user links an OIDC identity to THEIR OWN account. The
    // intent is minted for `ctx.user` here and resolved by the SSO finish,
    // which also requires the same user's session cookie — the user id never
    // travels through the browser.

    /** Sign-in providers the caller can link (redirect methods declaring `linkable`). */
    listLinkableProviders: protectedProcedure
      .input(z.void())
      .output(z.array(z.object({ provider: z.string(), label: z.string() })))
      .query(async () =>
        (await linkableProviders()).map(({ provider, label }) => ({ provider, label })),
      ),

    /**
     * Start linking `provider` to the caller; the client navigates to `url`.
     * `returnTo` (D801): the native app's callback — allowlisted
     * (`APP_AUTH_CALLBACK_URLS`); the finish then parks the link for the app
     * to claim with `completeExternalLink` instead of needing a session cookie.
     */
    beginExternalLink: protectedProcedure
      .input(
        z.object({
          provider: z.string().min(1),
          returnTo: z.string().optional(),
          /** From `auth.reauthenticate` — linking needs a fresh proof, not just a session. */
          reauthToken: ReauthTokenInput.optional(),
        }),
      )
      .output(z.object({ url: z.string() }))
      .mutation(async ({ ctx, input }) => {
        if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
        assertRealUserSession(ctx.user, 'Linking a sign-in account')
        // Per user AND per client: each call mints an entry in a bounded
        // shared map, so a flood must not evict other users' pending links.
        limitByUser(limiters.link, 'auth.beginExternalLink', ctx.user.id)
        limitByClient(limiters.ceremony, 'auth.beginExternalLink', ctx.req, network)
        assertReauthenticated(auth, ctx.user, input.reauthToken)
        const returnTo =
          input.returnTo === undefined ? undefined : parseAppAuthCallback(input.returnTo)
        if (returnTo === null) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'returnTo is not an allowed app callback',
          })
        }
        const target = (await linkableProviders()).find((p) => p.provider === input.provider)
        if (target === undefined) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Sign-in provider "${input.provider}" is not available for linking`,
          })
        }
        const handle = linkIntents.create(ctx.user.id, target.provider, returnTo)
        const separator = target.startUrl.includes('?') ? '&' : '?'
        return { url: `${target.startUrl}${separator}link=${encodeURIComponent(handle)}` }
      }),

    /**
     * Claim a native link the SSO finish parked (D801). Bound HERE: the
     * caller must be the user the intent was minted for — a code delivered to
     * another account's app links nothing. The code is spent by this call
     * whatever the outcome.
     */
    completeExternalLink: selfCodeProcedure
      .input(z.object({ code: z.string().min(1).max(256) }))
      .output(
        z.object({
          outcome: z.enum(['linked', 'conflict', 'expired', 'session']),
          provider: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
        assertRealUserSession(ctx.user, 'Linking a sign-in account')
        if (nativeLink === null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Native linking is not available',
          })
        }
        const parked = nativeLink.completions.claim(input.code)
        if (parked === null) return { outcome: 'expired' as const }
        if (parked.userId !== ctx.user.id) return { outcome: 'session' as const }
        const outcome = await nativeLink.link(parked)
        return { outcome, provider: parked.provider }
      }),

    /**
     * A one-time code that opens the hub's account page signed in as the
     * caller, in a browser (D801) — for what only a browser can do at the
     * hub's origin: a passkey's WebAuthn ceremony. Single-use, 60 s, and it
     * lands on that page only: the route takes no destination.
     */
    createBrowserHandoff: selfCodeProcedure
      .input(z.void())
      .output(z.object({ path: z.string(), expiresAt: z.number() }))
      .mutation(({ ctx }) => {
        if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
        assertRealUserSession(ctx.user, 'Opening the account page in a browser')
        if (nativeLink === null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Browser handoff is not available',
          })
        }
        const parentCredential = credentialOfSession(ctx.user.sessionId)
        const { code, expiresAt } = nativeLink.browserHandoffs.create(ctx.user.id, {
          purpose: 'new-session',
          ...(parentCredential !== undefined ? { credentialId: parentCredential } : {}),
        })
        return { path: `${BROWSER_HANDOFF_PATH}?code=${encodeURIComponent(code)}`, expiresAt }
      }),

    /** The caller's linked identities; `available: false` when the provider instance is gone or off. */
    listOwnExternalIdentities: protectedProcedure
      .input(z.void())
      .output(z.array(OwnExternalIdentitySchema))
      .query(async ({ ctx }) => {
        if (!ctx.user) return []
        const userMgmt = registry?.getSingleton('user-management')
        if (!userMgmt || typeof userMgmt.listExternalIdentities !== 'function') return []
        const labels = new Map((await linkableProviders()).map((p) => [p.provider, p.label]))
        const links = await userMgmt.listExternalIdentities({ userId: ctx.user.id })
        return links.map((link) => ({
          provider: link.provider,
          subject: link.subject,
          ...(link.label !== undefined ? { label: link.label } : {}),
          linkedAt: link.linkedAt,
          providerLabel: labels.get(link.provider) ?? null,
          available: labels.has(link.provider),
        }))
      }),

    /** Remove one of the caller's own links. */
    unlinkOwnExternalIdentity: protectedProcedure
      .input(z.object({ provider: z.string().min(1), subject: z.string().min(1) }))
      .output(z.object({ success: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
        assertRealUserSession(ctx.user, 'Unlinking a sign-in account')
        const userMgmt = registry?.getSingleton('user-management')
        if (!userMgmt) throw new Error('user-management capability not available')
        return userMgmt.unlinkExternalIdentity({
          userId: ctx.user.id,
          provider: input.provider,
          subject: input.subject,
        })
      }),

    /**
     * PUBLIC — the login page's single source of pre-auth login surfaces.
     * Aggregates the `login-method` collection: every auth addon (OIDC,
     * WebAuthn) contributes `redirect` buttons and/or pre-auth
     * `widget`s, each tagged `stage: 'primary' | 'second-factor'`. The
     * login page renders `redirect` methods as generic buttons and mounts
     * `widget` methods via `loadRemoteBundle` — a future SSO addon plugs
     * in with ZERO shell change.
     *
     * A provider disabled on Identity → Authentication contributes nothing
     * (D777: that toggle is an auth addon's only enable).
     *
     * A failing / slow provider is skipped independently (mirrors
     * `listProviders`' old resilience) so one bad addon can't lock every
     * login method out of the UI.
     */
    listLoginMethods: publicProcedure
      .input(z.void())
      .output(z.array(PublicLoginMethodSchema).readonly())
      .query(async () => aggregateLoginMethods()),
    /**
     * The hub's human name (D861), public like `listLoginMethods` and exposing
     * nothing else. A separate method on purpose: `listLoginMethods` stays the bare
     * array every installed viewer already parses.
     */
    getServerName: publicProcedure
      .input(z.void())
      .output(ServerNameInfoSchema)
      .query(async () => serverNameReader.read()),
  })
}
