import type { IncomingMessage } from 'node:http'
import type {
  AuthenticatedUser,
  CatalogLang,
  CredentialScope,
  CredentialTokenClaims,
  DeviceMetaLike,
} from '@camstack/types'
import { getUserManagementInternal } from '@camstack/system'
import { DEFAULT_AUTH_NETWORK_POLICY } from '../../auth/auth-network-policy.js'
import {
  createCredentialVerifier,
  type CredentialVerifier,
  type Principal,
  type PrincipalAuditTag,
  type RequestFacts,
  type ScopeMemo,
  type UsersMemo,
  type VerifierTokenRows,
  type VerifierUserDirectory,
  type VerifiedJwtClaims,
} from '../../auth/credential-verifier.js'
import type { CreateWSSContextFnOptions } from '@trpc/server/adapters/ws'
import type { FastifyRequest } from 'fastify'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service'
import type { AuthService } from '../../core/auth/auth.service'
import type { DeviceScopeLookup } from './scope-access.js'
import { requestLangInputFrom, resolveRequestLang } from '../../i18n/request-lang.js'

/**
 * The request principal (D892): who the credential acts for and the
 * permissions it carries, as `scopes`. Authorization reads `scopes` through
 * the one matcher (`principal-authorization.ts`) and nothing else — there is
 * no `isScoped`, `shareView` or admin-token flag any more. `isAdmin` is
 * derived (`scopes` holds `'*'`).
 */
export interface AuthenticatedAgent extends AuthenticatedUser {
  /** Every permission the credential carries. */
  scopes?: readonly CredentialScope[]
  /** The id of the row behind the credential (session, token, link). */
  credentialId?: string
  /** Where the credential came from — attribution only, no gate reads it. */
  auditTag?: PrincipalAuditTag
  /**
   * A person signed in through a login session. Provenance, not a permission:
   * only such a principal re-authenticates, mints a token or manages its
   * sessions (a token cannot mint a token, D816). Absent = no.
   */
  interactive?: boolean
  /**
   * The user holds the credential themselves (a login session or an account
   * link they consented to), not a token minted from one. Provenance: it may
   * manage its share links and hand itself a code. Absent = no.
   */
  userDelegated?: boolean
  /** The provider of an account-link credential (`oauth-access`). Diagnostics only. */
  credential?: string
  /** The OAuth session behind an `oauth-access` credential. Diagnostics only. */
  oauthSessionId?: string
  /**
   * The login session behind a session token (`sid`). Logout and the session
   * list name it; a password change keeps it and ends the others.
   */
  sessionId?: string
}

/** The tRPC principal a verified credential becomes. */
export function agentFromPrincipal(principal: Principal): AuthenticatedAgent {
  return {
    id: principal.subjectId,
    username: principal.username,
    isAdmin: principal.isAdmin,
    permissions: { isAdmin: principal.isAdmin, allowedProviders: '*', allowedDevices: {} },
    isApiKey: !principal.interactive,
    scopes: principal.scopes,
    credentialId: principal.credentialId,
    auditTag: principal.auditTag,
    interactive: principal.interactive,
    userDelegated: principal.userDelegated,
    ...(principal.sessionId !== undefined ? { sessionId: principal.sessionId } : {}),
    ...(principal.oauthSessionId !== undefined ? { oauthSessionId: principal.oauthSessionId } : {}),
    ...(principal.credential !== undefined ? { credential: principal.credential } : {}),
  }
}

/**
 * The live-scope memo of non-admin sessions, shared by every verifier this
 * process builds (a request builds one; the memo must outlive it).
 */
const hubScopeMemo: ScopeMemo = new Map()
/** The user-list memo, shared the same way (every token verify asks "does its subject exist?"). */
const hubUsersMemo: UsersMemo = { entry: null }

/**
 * The hub's own credential stores, bound once at boot (`main.ts`) so every
 * surface that verifies a bearer — tRPC, addon routes, uploads, whoami —
 * reads the same ones without each being handed them.
 */
interface HubCredentialStores {
  tokenRows: VerifierTokenRows | null
}
const hubStores: HubCredentialStores = { tokenRows: null }

export function bindHubCredentialStores(stores: Partial<HubCredentialStores>): void {
  if (stores.tokenRows !== undefined) hubStores.tokenRows = stores.tokenRows
}

/** What {@link hubCredentialVerifier} reads. */
export interface HubCredentialVerifierDeps {
  readonly authService: {
    verifyToken(token: string): VerifiedJwtClaims
    verifyCredentialToken(token: string): CredentialTokenClaims
  }
  readonly addonRegistry: {
    getCapabilityRegistry(): { getSingleton(capability: string): unknown }
  }
  readonly tokenRows?: VerifierTokenRows | null
  readonly logger?: TrpcContextLogger | null
  /** Device selectors' ancestor / type / location lookups (tRPC has them; other doors fail closed). */
  readonly deviceScopeLookup?: DeviceScopeLookup
}

/**
 * The hub's verifier over its own stores — the same one for tRPC and the
 * addon routes. Documented type boundary: the registry hands the
 * `user-management` provider back untyped; the one method the verifier reads
 * (`listUsers`) is asserted here.
 */
export function hubCredentialVerifier(deps: HubCredentialVerifierDeps): CredentialVerifier {
  const provider = (): unknown =>
    deps.addonRegistry.getCapabilityRegistry().getSingleton('user-management')
  return createCredentialVerifier({
    verifyJwt: (token) => deps.authService.verifyToken(token),
    verifyCredentialJwt: (token) => deps.authService.verifyCredentialToken(token),
    users: () => (provider() as VerifierUserDirectory | undefined) ?? null,
    internal: () => getUserManagementInternal(provider()),
    tokenRows: () => deps.tokenRows ?? hubStores.tokenRows,
    logger: deps.logger ?? null,
    scopeMemo: hubScopeMemo,
    usersMemo: hubUsersMemo,
    ...(deps.deviceScopeLookup !== undefined ? { deviceScopeLookup: deps.deviceScopeLookup } : {}),
  })
}

/**
 * Request union accepted by the tRPC context.
 *
 * HTTP tRPC requests arrive as `FastifyRequest`, but the WS adapter provides
 * a raw `IncomingMessage` with no `.query`. Callers must narrow before reading
 * Fastify-specific properties.
 */
export type TrpcRequest = FastifyRequest | IncomingMessage

export interface TrpcContext {
  user: AuthenticatedAgent | null
  /**
   * The language this request is answered in (D863): the user's profile
   * language when one exists, else the app's `lang`, else `Accept-Language`,
   * else English. Absent (mesh / test contexts) means English.
   */
  lang?: CatalogLang
  /**
   * The originating HTTP/WS request. Absent for mesh-originated calls
   * (the core-cap bridge invokes procedures via `createCaller`, with no
   * request behind them).
   */
  req?: TrpcRequest
  /**
   * Resolves a deviceId's ancestors + persisted type/location for the
   * scope-access matcher (v3 selectors + parent → child accessory
   * inheritance). Populated by `createTrpcContext` from the hub-process
   * persisted-device mirror; omitted on the mesh / test paths.
   */
  deviceScopeLookup?: DeviceScopeLookup
  /**
   * The whole persisted device fleet (slim), for FLEET-wide selector
   * expansion — `auth.me`'s effective-scope counts and response projection.
   * Omitted on mesh / test paths.
   */
  deviceFleet?: () => readonly DeviceMetaLike[]
  /**
   * WebSocket connections only: is the login session behind this socket's
   * principal still live? `protectedProcedure` asks on every call.
   */
  sessionLive?: () => boolean
  /**
   * WebSocket connections only: the socket presented a bearer that resolved to
   * NO principal (revoked, expired, unknown). The hub closes such a socket
   * (`session-ended`) rather than answering anonymous forever.
   */
  credentialRejected?: boolean
  /**
   * Present on HTTP and WebSocket contexts. The person-without-viewer refusal
   * logs through it, once per user.
   */
  logger?: TrpcContextLogger | null
}

/**
 * The logger surface the context needs — narrow on purpose, so a test passes a
 * spy and production passes the `IScopedLogger` the tRPC plugin already builds.
 */
export interface TrpcContextLogger {
  warn(
    message: string,
    options?: {
      readonly meta?: Record<string, unknown>
      readonly tags?: { readonly userId?: string }
    },
  ): void
}

/** Read `req.query` if present (Fastify-only) without losing type safety. */
function readQuery(req: TrpcRequest): Record<string, unknown> | null {
  if (!('query' in req)) return null
  const q: unknown = Reflect.get(req, 'query')
  if (q === null || typeof q !== 'object' || Array.isArray(q)) return null
  return { ...q }
}

/**
 * Extract a bearer from an HTTP request.
 * Priority: Authorization header → Fastify req.query → URL query string
 */
function extractTokenFromRequest(req: TrpcRequest): string | null {
  const authHeader = req.headers.authorization
  if (authHeader && typeof authHeader === 'string') {
    const [scheme, token] = authHeader.split(' ')
    if (scheme === 'Bearer' && token) return token
  }

  // Fastify-parsed query object (HTTP tRPC requests)
  const q = readQuery(req)
  if (q && typeof q.token === 'string') {
    return q.token
  }

  // Raw URL query string fallback (IncomingMessage or Fastify w/o parsed query)
  const url = req.url
  if (url) {
    const qIdx = url.indexOf('?')
    if (qIdx !== -1) {
      const t = new URLSearchParams(url.slice(qIdx + 1)).get('token')
      if (t) return t
    }
  }

  return null
}

/** What the audit of an admin-capable token's use records about the request. */
export function requestFacts(req: TrpcRequest | undefined): RequestFacts {
  if (req === undefined) return {}
  const ip = DEFAULT_AUTH_NETWORK_POLICY.clientAddress(req).ip
  const url = req.url
  const path = typeof url === 'string' ? url.split('?')[0] : undefined
  return { ...(path !== undefined ? { path } : {}), ...(ip !== null ? { ip } : {}) }
}

async function resolveUser(
  token: string | null,
  verifier: CredentialVerifier,
  facts: RequestFacts,
): Promise<AuthenticatedAgent | null> {
  const principal = await verifier.verify(token, facts)
  return principal === null ? null : agentFromPrincipal(principal)
}

/**
 * Build the parent-chain walker for the scope-access matcher. Returns every
 * ancestor deviceId of `deviceId` (parent, grandparent, …) so a grant on a
 * Reolink camera covers its accessory children without re-enumerating them.
 *
 * Reads `AddonRegistryService.getPersistedAncestors` — the hub-process mirror of
 * the device-manager's PERSISTED parentage (F0.6). It MUST NOT walk the hub
 * `DeviceRegistry` directly: that registry only holds hub-local devices, so it
 * is empty for every forked provider and the inheritance this function exists to
 * provide silently did nothing (0/6 providers inherited).
 */
function makeDeviceScopeLookup(addonRegistry: AddonRegistryService): DeviceScopeLookup {
  return {
    getAncestors: (deviceId: number) => addonRegistry.getPersistedAncestors(deviceId),
    getType: (deviceId: number) => addonRegistry.getPersistedType(deviceId),
    getLocation: (deviceId: number) => addonRegistry.getPersistedLocation(deviceId),
  }
}

/**
 * Context factory for calls arriving over the Moleculer mesh (the `$core-caps`
 * bridge service in `core-cap-bridge.ts`).
 *
 * `principal` names WHO is calling (D802): `mesh` for the hub's own runners
 * (they reach the bridge over UDS, inside the hub's trust boundary), and
 * `node:<nodeId>` for another node — whose id the hub's mesh gate has bound
 * to its CERTIFICATE before the call got here (D857).
 *
 * Both principals hold `'*'`: that keeps every `adminProcedure` an agent's
 * addons call working. What is NOT reachable from another node is decided by
 * the bridge itself (`REMOTE_DENIED_NAMESPACES`), and `repl` is not bridged at
 * all. There is no HTTP request behind the call.
 */
export function createMeshTrpcContext(principal = 'mesh'): TrpcContext {
  const user: AuthenticatedAgent = {
    id: principal,
    username: principal,
    isAdmin: true,
    permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
    isApiKey: true,
    scopes: ['*'],
    credentialId: principal,
  }
  return { user }
}

/** Context factory for HTTP tRPC requests (Fastify adapter). */
export async function createTrpcContext(
  req: TrpcRequest,
  authService: AuthService,
  addonRegistry: AddonRegistryService,
  logger: TrpcContextLogger | null = null,
  tokenRows: VerifierTokenRows | null = null,
): Promise<TrpcContext> {
  const deviceScopeLookup = makeDeviceScopeLookup(addonRegistry)
  const verifier = hubCredentialVerifier({
    authService,
    addonRegistry,
    tokenRows,
    logger,
    deviceScopeLookup,
  })
  return {
    user: await resolveUser(extractTokenFromRequest(req), verifier, requestFacts(req)),
    req,
    lang: resolveRequestLang(requestLangInputFrom(req.headers, readQuery(req))),
    deviceScopeLookup,
    deviceFleet: () => addonRegistry.getPersistedDeviceList(),
    logger,
  }
}

/**
 * Context factory for WebSocket tRPC connections (applyWSSHandler).
 * Token is sent via tRPC connectionParams (a JSON message sent right after
 * the WS handshake), which is more reliable than query params through proxies.
 */
export async function createWsTrpcContext(
  opts: CreateWSSContextFnOptions,
  authService: AuthService,
  addonRegistry: AddonRegistryService,
  logger: TrpcContextLogger | null = null,
  tokenRows: VerifierTokenRows | null = null,
): Promise<TrpcContext> {
  // 1. connectionParams.token (sent by BackendClient's createWSClient)
  const paramToken = opts.info.connectionParams?.['token']
  const token =
    (typeof paramToken === 'string' ? paramToken : null) ?? extractTokenFromRequest(opts.req)

  const deviceScopeLookup = makeDeviceScopeLookup(addonRegistry)
  const verifier = hubCredentialVerifier({
    authService,
    addonRegistry,
    tokenRows,
    logger,
    deviceScopeLookup,
  })
  const user = await resolveUser(token, verifier, requestFacts(opts.req))
  const sessionId = user?.sessionId
  return {
    user,
    req: opts.req,
    lang: resolveRequestLang(
      requestLangInputFrom(
        opts.req.headers,
        readQuery(opts.req),
        opts.info.connectionParams?.['lang'],
      ),
    ),
    ...(user === null && token !== null && token !== '' ? { credentialRejected: true } : {}),
    ...(user !== null && sessionId !== undefined
      ? {
          sessionLive: () =>
            authService.checkSession({
              sid: sessionId,
              userId: user.id,
              isAdmin: user.isAdmin,
              allowedProviders: '*',
              allowedDevices: {},
            }) === null,
        }
      : {}),
    deviceScopeLookup,
    deviceFleet: () => addonRegistry.getPersistedDeviceList(),
    logger,
  }
}
