/**
 * Generic OpenID Connect (OIDC) authentication provider.
 *
 * Multi-provider: ONE addon installation can serve N IdPs (Google AND
 * Microsoft AND custom). The configuration is a `providers` array,
 * each entry produces a discrete `/<providerId>/start` route.
 *
 * Capabilities registered:
 *   - `auth-provider` (collection, ONE entry) — the actual flow goes
 *     through the routes below; the cap methods (validateCredentials /
 *     handleCallback / getLoginUrl / validateToken) are stubs for the
 *     redirect-flow case.
 *   - `addon-routes` (collection) — `/<providerId>/start` and
 *     `/<providerId>/callback` per configured provider. The handler
 *     reads `:providerId` from the route params, picks the matching
 *     config entry, and runs the OIDC flow against THAT IdP.
 *   - `oidc-connections` (singleton) — list / create / update / delete for
 *     IdP rows; Settings UI is DataTable + dialog (no editable-array).
 *
 * Each provider entry independently performs:
 *   - PKCE S256 + nonce
 *   - id_token signature verification via `jose.jwtVerify` against the
 *     IdP's JWKS (issuer + audience + exp + nbf enforced)
 *   - Replay defense: nonce claim must match the value sent at /start
 *
 * The bridge token minted at /callback flows back to /api/auth/sso/finish
 * — the hub verifies it with the same `jwtSecret` and only then mints
 * the user session JWT.
 *
 * Identity mapping is EXPLICIT LINKING only (D782): the bridge names the
 * identity `oidc:<instance>:<sub>`; the hub signs in the user that identity
 * was linked to, and refuses an unlinked one. A flow started by a signed-in
 * user's "Link" button carries the hub's opaque `?link=` handle through the
 * pending state into the bridge (`linkIntent`); the hub resolves it.
 *
 * TODO (next session):
 *   - RP-initiated logout (`end_session_endpoint` 302 with id_token_hint).
 *   - Refresh token rotation (offline_access).
 *   - Persist state + nonce + PKCE across restart (multi-replica).
 */
import * as crypto from 'node:crypto'
import {
  APP_FLOW_DEFAULT_REDIRECT,
  APP_REFUSED_PATH,
  type AppStartRefusal,
  APP_FLOW_STATE_PREFIX,
  type AddonHttpReply,
  type AddonHttpRequest,
  addonRoutesCapability,
  type AppFlowRequest,
  appFlowLocation,
  authProviderCapability,
  BaseAddon,
  buildAddonRouteProvider,
  errMsg,
  type HubAddressBook,
  type IOidcConnectionsProvider,
  resolveIconKey,
  type IAddonHttpRoute,
  type IAuthProvider,
  type ILoginMethodProvider,
  type LoginMethodContribution,
  loginMethodCapability,
  oidcConnectionsCapability,
  parseAppFlowRequest,
  parseAppPageLang,
  type ProviderRegistration,
  SSO_STATE_COOKIE,
  SSO_STATE_COOKIE_MAX_AGE_SEC,
} from '@camstack/types'
import * as jose from 'jose'
import { DEFAULT_OIDC_ICON, OIDC_CONNECTION_FORM_SCHEMA } from './oidc-connection-schema.js'
import {
  clientSecretPatchOf,
  clientSecretView,
  connectionConfigured,
  createOidcConnection,
  DEFAULT_OIDC_PROVIDER,
  findOidcProvider,
  INSTANCE_ID_PATTERN,
  type OidcProviderRow,
  type OidcProvidersConfig,
  updateOidcConnection,
} from './oidc-connections.js'
import { oidcProviderEntryKind } from './oidc-provider-record-kinds.js'
import { OidcProviderStore } from './oidc-provider-store.js'
import {
  advertisedHubOrigins,
  claimedRequestOrigins,
  normalizeOrigin,
  pickRequestOrigin,
  type RequestHeaders,
  requestMountPrefix,
} from './request-origin.js'

type OidcConfig = OidcProvidersConfig
type OidcProviderConfig = OidcProviderRow

const DEFAULT_PROVIDER = DEFAULT_OIDC_PROVIDER

const DEFAULT_CONFIG: OidcConfig = {
  providers: [],
}

// ---------------------------------------------------------------------------
// Per-instance runtime state — discovery cache, JWKS, pending OAuth states
// ---------------------------------------------------------------------------

interface DiscoveryDocument {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly userinfo_endpoint?: string
  readonly jwks_uri?: string
  readonly end_session_endpoint?: string
}

interface PendingState {
  readonly codeVerifier: string
  /** The `redirect_uri` sent on the authorize leg — the token leg must repeat it. */
  readonly redirectUri: string
  /**
   * Origin + mount prefix of `redirectUri` — where the browser goes after the
   * callback (`/api/auth/sso/finish`), so the whole flow stays on the origin
   * it started at (D791).
   */
  readonly returnBase: string
  /** Started from a popup window: the finish lands on the popup completion page (D791). */
  readonly popup: boolean
  readonly nonce: string
  readonly providerId: string
  readonly createdAt: number
  /** Opaque hub link-intent handle when this flow was started by a "Link" button (D782). */
  readonly linkIntent?: string
  /** SHA-256 of the state cookie `/start` set: the bridge carries it (browser binding). */
  readonly browserBinding?: string
  /** Who started it - the per-client cap counts these. */
  readonly clientKey: string
  /**
   * The native app that started this flow (D858): kept server-side, signed
   * into the bridge at the callback, never sent to the IdP.
   */
  readonly app?: AppFlowRequest
}

interface OidcTokenResponse {
  readonly access_token: string
  readonly id_token?: string
  readonly token_type?: string
  readonly expires_in?: number
  readonly refresh_token?: string
}

const STATE_TTL_MS = 5 * 60_000

/**
 * Shape of a hub link-intent handle (`?link=` on /start). Opaque to this
 * addon — the hub resolves it, single-use, at the SSO finish. Validated only
 * so a junk value is refused here rather than carried into a signed bridge.
 */
const LINK_INTENT_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** Bound on in-flight logins: `/start` is public, so a flood must not grow the map. */
const MAX_PENDING_STATES = 1_000
/** In-flight logins one client may hold (D858): one browser flooding `/start` cannot fill the map for everyone. */
const MAX_PENDING_PER_CLIENT = 20
/**
 * A step-up must follow a login that happened no earlier than this before the
 * flow began (D858). The authorize request asks for `prompt=login&max_age=0`;
 * this is the check that the IdP actually honoured it.
 */
const STEP_UP_MAX_AUTH_AGE_MS = 60_000

/** The pending map is full, or this client already holds its share. Live states are never evicted for it. */
class PendingStatesFullError extends Error {}
/** A step-up whose id_token proves no login just before the flow began. */
class StepUpNotFreshError extends Error {}

/**
 * Who a `/start` is counted against. The hub already limits each real client
 * address per minute before a route runs; the addon sees only headers, so this
 * is a best-effort key (a spoofed header only rotates the bucket, and the
 * hub's limit and the global cap still bound the total).
 */
function clientKeyOf(headers: RequestHeaders | undefined): string {
  const forwarded = headers?.['x-forwarded-for']?.split(',')[0]?.trim()
  return headers?.['cf-connecting-ip'] ?? headers?.['x-real-ip'] ?? forwarded ?? 'unknown'
}

interface InstanceRuntime {
  config: OidcProviderConfig
  discovery: DiscoveryDocument | null
  discoveryFetchedAt: number
  jwks: ReturnType<typeof jose.createRemoteJWKSet> | null
  jwksUri: string | null
}

/**
 * Origin + mount prefix of a pinned `redirect_uri`: the part before the
 * callback path when it ends with it, else just its origin.
 */
function returnBaseOf(redirectUri: string, callbackPath: string): string {
  try {
    const url = new URL(redirectUri)
    const prefix = url.pathname.endsWith(callbackPath)
      ? url.pathname.slice(0, -callbackPath.length)
      : ''
    return `${url.origin}${prefix.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Addon
// ---------------------------------------------------------------------------

export class AuthOidcAddon extends BaseAddon<OidcConfig> {
  /** Per-provider runtime state, keyed by `provider.id`. */
  private instances = new Map<string, InstanceRuntime>()
  private providerStore: OidcProviderStore | null = null
  private activeProviders: readonly OidcProviderRow[] = []
  /** Pending OAuth states across ALL providers. The pending entry
   *  carries `providerId` so the /callback handler picks the right config. */
  private readonly pendingStates = new Map<string, PendingState>()

  /** Keychain path for each IdP's client secret (D787 / D828 sibling). */
  protected override readonly secretStatePaths = ['providers[id].clientSecret'] as const

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onConfigChanged(): Promise<void> {
    if (this.providerStore !== null) this.activeProviders = await this.providerStore.listResolved()
    this.rebuildInstances()
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('auth-oidc: ctx.records is required (hub-only addon)')
    }
    await records.declare({ 'oidc-provider': oidcProviderEntryKind })
    this.providerStore = OidcProviderStore.of(records)
    this.activeProviders = await this.providerStore.listResolved()
    this.rebuildInstances()

    const authProvider: IAuthProvider = {
      validateCredentials: async () => null, // OIDC has no credential flow
      validateToken: async ({ token }) => this.validateLocalSessionToken(token),
      getLoginUrl: async ({ state }) => {
        // Legacy single-provider entry-point — pick the first instance
        // for back-compat with consumers that still call the cap method.
        // Multi-provider login flows now route through `/start` URLs.
        const first = this.firstInstance()
        if (!first) throw new Error('OIDC: no providers configured')
        return this.buildLoginUrl(first.config.id, state)
      },
      handleCallback: async (params) => {
        const code = params['code']
        const state = params['state']
        if (!code || !state) throw new Error('Missing code or state in OIDC callback')
        return this.handleCallback(code, state)
      },
    }

    const routes: IAddonHttpRoute[] = [
      {
        method: 'GET',
        path: '/:providerId/start',
        access: 'public',
        rateLimit: 'auth',
        description: 'Begin OIDC redirect login flow for a configured provider',
        handler: async (req, reply) => this.handleStart(req, reply),
      },
      {
        method: 'GET',
        path: '/:providerId/callback',
        access: 'public',
        rateLimit: 'auth',
        description: 'OIDC redirect callback for a configured provider',
        handler: async (req, reply) => this.handleCallbackRoute(req, reply),
      },
    ]
    // buildAddonRouteProvider (not a hand-rolled object): forked addons are
    // reached through the addon-routes `invoke` bridge — a provider without
    // it 500s every route hit ("method 'invoke' not found on provider").
    const routeProvider = buildAddonRouteProvider('auth-oidc', routes)

    // Login-method contributions — one `redirect` button per configured
    // IdP, surfaced on the login page's primary (credentials) screen via
    // the public `auth.listLoginMethods` aggregate. Cap-driven: the shell
    // renders whatever this returns with zero OIDC-specific code.
    const loginMethodProvider: ILoginMethodProvider = {
      getLoginMethods: async () => this.buildLoginMethods(),
    }

    this.ctx.logger.info('OIDC auth provider initialized', {
      meta: { providers: [...this.instances.keys()] },
    })

    return [
      { capability: authProviderCapability, provider: authProvider as never },
      { capability: addonRoutesCapability, provider: routeProvider },
      { capability: loginMethodCapability, provider: loginMethodProvider },
      { capability: oidcConnectionsCapability, provider: this.connectionsProvider() },
    ]
  }

  private connectionsProvider(): IOidcConnectionsProvider {
    return {
      connectionFormSchema: async () => OIDC_CONNECTION_FORM_SCHEMA,
      listConnections: async () => {
        const secrets = this.ctx.secrets
        return this.activeProviders.map((row) => {
          const merged = { ...DEFAULT_PROVIDER, ...row }
          return {
            id: merged.id,
            displayName: merged.displayName,
            icon: resolveIconKey(merged.icon, DEFAULT_OIDC_ICON),
            issuerUrl: merged.issuerUrl,
            clientId: merged.clientId,
            configured: connectionConfigured(merged),
            formValues: {
              displayName: merged.displayName,
              icon: merged.icon,
              issuerUrl: merged.issuerUrl,
              clientId: merged.clientId,
              clientSecret: clientSecretView(merged.clientSecret, secrets, merged.id) ?? '',
              redirectUri: merged.redirectUri,
              scopes: merged.scopes,
              usernameClaim: merged.usernameClaim,
            },
          }
        })
      },
      createConnection: async (input) => {
        const result = createOidcConnection(this.providersConfig(), input)
        if (!result.ok) {
          throw new Error(
            result.reason === 'duplicate-id'
              ? `An OIDC connection with id "${input.id}" already exists`
              : `Invalid connection id "${input.id}" — use a lowercase slug`,
          )
        }
        const row = result.config.providers.find((p) => p.id === result.id)
        if (row === undefined) throw new Error(`Invalid connection id "${input.id}"`)
        // Persist FIRST: memory only follows a write the records engine accepted.
        const stored = await this.requireStore().create(row)
        this.activeProviders = [...this.activeProviders, stored]
        this.rebuildInstances()
        return { id: result.id }
      },
      updateConnection: async (input) => {
        const secretPatch = clientSecretPatchOf(input.clientSecret)
        const result = updateOidcConnection(this.providersConfig(), input.id, {
          displayName: input.displayName,
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.issuerUrl !== undefined ? { issuerUrl: input.issuerUrl } : {}),
          ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
          ...secretPatch,
          ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          ...(input.usernameClaim !== undefined ? { usernameClaim: input.usernameClaim } : {}),
        })
        if (!result.ok) throw new Error(`Unknown OIDC connection "${input.id}"`)
        const next = result.config.providers.find((p) => p.id === input.id)
        if (next === undefined) throw new Error(`Unknown OIDC connection "${input.id}"`)
        const { id: _id, clientSecret: _carried, ...fields } = next
        const stored = await this.requireStore().update(input.id, {
          ...fields,
          ...(result.clearClientSecret
            ? { clientSecret: null }
            : secretPatch.clientSecret !== undefined
              ? { clientSecret: secretPatch.clientSecret }
              : {}),
        })
        this.activeProviders = this.activeProviders.map((p) => (p.id === input.id ? stored : p))
        this.rebuildInstances()
        return { ok: true as const }
      },
      deleteConnection: async (input) => {
        if (findOidcProvider(this.providersConfig(), input.id) === null) {
          throw new Error(`Unknown OIDC connection "${input.id}"`)
        }
        await this.requireStore().remove(input.id)
        this.activeProviders = this.activeProviders.filter((p) => p.id !== input.id)
        this.rebuildInstances()
        return { ok: true as const }
      },
    }
  }

  /**
   * Build one `redirect` login-method per configured provider instance.
   * `startUrl` is the addon's public `/start` route for that instance;
   * the login page renders a generic button navigating to it.
   */
  private buildLoginMethods(): readonly LoginMethodContribution[] {
    const out: LoginMethodContribution[] = []
    for (const inst of this.instances.values()) {
      const id = inst.config.id
      out.push({
        kind: 'redirect',
        id: `auth-oidc/${id}`,
        label: inst.config.displayName || DEFAULT_PROVIDER.displayName,
        // A vocabulary key (D780); a pre-picker free-text name draws the default.
        icon: resolveIconKey(inst.config.icon, DEFAULT_PROVIDER.icon),
        startUrl: `/addon/auth-oidc/${id}/start`,
        stage: 'primary',
        // An IdP account is linked to a user before it signs anyone in (D782).
        linkable: true,
        // The same route serves a native app with `?app=1&code_challenge=…` (D858).
        app: { kind: 'browser', startPath: `/addon/auth-oidc/${id}/start` },
      })
    }
    return out
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'oidc',
          title: 'OpenID Connect',
          description:
            'Manage IdP connections in this page’s Settings table (Add / Edit). Each connection’s redirect URI is `<origin>/addon/auth-oidc/<id>/callback`. Credentials stay in the CamStack keychain.',
          fields: [],
        },
      ],
    })
  }

  // ── Instance management ──────────────────────────────────────────

  private providersConfig(): OidcProvidersConfig {
    return { providers: this.activeProviders }
  }

  private requireStore(): OidcProviderStore {
    if (this.providerStore === null) throw new Error('auth-oidc: the records store is not ready')
    return this.providerStore
  }

  private rebuildInstances(): void {
    this.instances.clear()
    const providers = this.activeProviders
    for (const raw of providers) {
      const merged: OidcProviderConfig = { ...DEFAULT_PROVIDER, ...raw }
      if (!merged.id || !INSTANCE_ID_PATTERN.test(merged.id)) {
        if (merged.id) {
          this.ctx.logger.warn('OIDC: provider instance skipped — id must be a lowercase slug', {
            meta: { id: merged.id },
          })
        }
        continue
      }
      this.instances.set(merged.id, {
        config: merged,
        discovery: null,
        discoveryFetchedAt: 0,
        jwks: null,
        jwksUri: null,
      })
    }
  }

  private firstInstance(): InstanceRuntime | null {
    const first = this.instances.values().next()
    return first.done ? null : first.value
  }

  // ── OIDC discovery + URL building ─────────────────────────────────

  private async getDiscovery(providerId: string): Promise<DiscoveryDocument> {
    const inst = this.instances.get(providerId)
    if (!inst) throw new Error(`OIDC: no provider configured with id "${providerId}"`)
    if (inst.discovery && Date.now() - inst.discoveryFetchedAt < 60 * 60_000) {
      return inst.discovery
    }
    const issuer = inst.config.issuerUrl?.replace(/\/+$/, '')
    if (!issuer) throw new Error(`OIDC provider "${providerId}": issuerUrl not configured`)
    const url = `${issuer}/.well-known/openid-configuration`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`)
    }
    const doc = (await res.json()) as DiscoveryDocument
    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error('OIDC discovery response missing required endpoints')
    }
    inst.discovery = doc
    inst.discoveryFetchedAt = Date.now()
    if (doc.jwks_uri && doc.jwks_uri !== inst.jwksUri) {
      inst.jwks = jose.createRemoteJWKSet(new URL(doc.jwks_uri))
      inst.jwksUri = doc.jwks_uri
    }
    return doc
  }

  /** The hub's Network-page address book, or `null` when `local-network` is unreachable. */
  private async addressBook(): Promise<HubAddressBook | null> {
    try {
      return await this.ctx.api.localNetwork.getAddresses.query({ scheme: 'https' })
    } catch (err: unknown) {
      this.ctx.logger.warn('OIDC: hub addresses unavailable from local-network', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * The `redirect_uri` of one sign-in, and the base the browser returns to
   * after the callback (D791). Precedence:
   *
   *  1. The instance's "Redirect URI override", when set: it PINS one origin —
   *     every sign-in returns there, wherever it started.
   *  2. The origin the `/start` request was made at (Host / X-Forwarded-Host /
   *     -Proto + mount prefix), ONLY when the hub advertises that origin
   *     (`request-origin.ts`) — a forged Host never reaches the IdP.
   *  3. The Network page's public endpoint (`roles.publicEndpoint`), else the
   *     development default.
   */
  private async resolveRedirect(
    providerId: string,
    headers: RequestHeaders | null,
  ): Promise<{ redirectUri: string; returnBase: string }> {
    const inst = this.instances.get(providerId)
    if (!inst) throw new Error(`OIDC: no provider configured with id "${providerId}"`)
    const callbackPath = `/addon/auth-oidc/${providerId}/callback`
    const claimed = headers !== null ? claimedRequestOrigins(headers) : []
    const configured = inst.config.redirectUri?.trim()
    if (configured) {
      return this.returnsTo(providerId, 'override', claimed, null, {
        redirectUri: configured,
        returnBase: returnBaseOf(configured, callbackPath),
      })
    }
    const book = await this.addressBook()
    const advertised = book !== null ? advertisedHubOrigins(book) : null
    const fromRequest =
      headers !== null && advertised !== null ? pickRequestOrigin(headers, advertised) : null
    if (fromRequest !== null) {
      const base = `${fromRequest}${requestMountPrefix(headers ?? {})}`
      return this.returnsTo(providerId, 'request', claimed, advertised, {
        redirectUri: `${base}${callbackPath}`,
        returnBase: base,
      })
    }
    const publicEndpoint =
      book !== null ? normalizeOrigin(book.roles.publicEndpoint.resolved ?? '') : null
    const fallback = publicEndpoint ?? 'https://localhost:4443'
    return this.returnsTo(
      providerId,
      publicEndpoint !== null ? 'public-endpoint' : 'default',
      claimed,
      advertised,
      { redirectUri: `${fallback}${callbackPath}`, returnBase: fallback },
    )
  }

  /**
   * Log where a sign-in will return and why. A popup whose flow returns to a
   * different hub address than the page that opened it cannot hand its
   * outcome back by `postMessage` (D794 amendment) — this line is how that is
   * told apart from a severed opener: `source` other than `request` while the
   * `claimed` origin is the one the operator browsed from.
   */
  private returnsTo(
    providerId: string,
    source: 'override' | 'request' | 'public-endpoint' | 'default',
    claimed: readonly string[],
    advertised: ReadonlySet<string> | null,
    result: { redirectUri: string; returnBase: string },
  ): { redirectUri: string; returnBase: string } {
    this.ctx.logger.info('OIDC: sign-in returns to', {
      meta: {
        provider: providerId,
        source,
        returnBase: result.returnBase,
        claimed,
        ...(advertised !== null ? { advertised: [...advertised] } : {}),
      },
    })
    return result
  }

  private async buildLoginUrl(
    providerId: string,
    state: string,
    options: {
      readonly linkIntent?: string
      readonly headers?: RequestHeaders
      readonly popup?: boolean
      readonly browserBinding?: string
      readonly app?: AppFlowRequest
    } = {},
  ): Promise<string> {
    return (await this.prepareLogin(providerId, state, options)).url
  }

  /** The authorize URL, and the origin the sign-in returns to (for the state cookie). */
  private async prepareLogin(
    providerId: string,
    state: string,
    options: {
      readonly linkIntent?: string
      readonly headers?: RequestHeaders
      readonly popup?: boolean
      readonly browserBinding?: string
      readonly app?: AppFlowRequest
    } = {},
  ): Promise<{ readonly url: string; readonly returnBase: string }> {
    const { linkIntent } = options
    const inst = this.instances.get(providerId)
    if (!inst) throw new Error(`OIDC: no provider configured with id "${providerId}"`)
    const doc = await this.getDiscovery(providerId)

    const codeVerifier = crypto.randomBytes(32).toString('base64url')
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const nonce = crypto.randomBytes(16).toString('base64url')

    // Resolved ONCE per login and replayed at the token exchange: the IdP
    // requires the two `redirect_uri` values to be identical, and a derived
    // address could move between the two legs.
    const { redirectUri, returnBase } = await this.resolveRedirect(
      providerId,
      options.headers ?? null,
    )
    // Expired states go first; when still full the new login is REFUSED -
    // a live login is never evicted to make room (D858).
    this.pruneExpiredStates()
    const clientKey = clientKeyOf(options.headers)
    if (
      this.pendingStates.size >= MAX_PENDING_STATES ||
      [...this.pendingStates.values()].filter((p) => p.clientKey === clientKey).length >=
        MAX_PENDING_PER_CLIENT
    ) {
      throw new PendingStatesFullError('Too many sign-ins in progress - try again shortly')
    }
    this.pendingStates.set(state, {
      clientKey,
      codeVerifier,
      nonce,
      providerId,
      redirectUri,
      returnBase,
      popup: options.popup === true,
      createdAt: Date.now(),
      ...(linkIntent !== undefined ? { linkIntent } : {}),
      ...(options.browserBinding !== undefined ? { browserBinding: options.browserBinding } : {}),
      ...(options.app !== undefined ? { app: options.app } : {}),
    })

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: inst.config.clientId,
      redirect_uri: redirectUri,
      scope: inst.config.scopes || DEFAULT_PROVIDER.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    // A step-up must be a login that just happened (D858): ask the IdP for a
    // fresh one; the callback verifies it did (auth_time).
    if (options.app?.purpose === 'step-up') {
      params.set('prompt', 'login')
      params.set('max_age', '0')
    }
    return { url: `${doc.authorization_endpoint}?${params.toString()}`, returnBase }
  }

  /** The pending state for `state`, unless it is gone or older than its TTL. */
  private livePending(state: string): PendingState | undefined {
    const pending = this.pendingStates.get(state)
    if (pending === undefined) return undefined
    return Date.now() - pending.createdAt > STATE_TTL_MS ? undefined : pending
  }

  private pruneExpiredStates(): void {
    const now = Date.now()
    for (const [k, v] of this.pendingStates.entries()) {
      if (now - v.createdAt > STATE_TTL_MS) this.pendingStates.delete(k)
    }
  }

  // ── Callback / token exchange ─────────────────────────────────────

  private async handleCallback(
    code: string,
    state: string,
  ): Promise<{
    userId: string
    username: string
    email?: string
    displayName?: string
    isAdmin: boolean
    linkIntent?: string
    issuer: string
    providerId: string
    returnBase: string
    popup: boolean
    browserBinding?: string
    app?: AppFlowRequest
  }> {
    const pending = this.livePending(state)
    if (!pending) {
      throw new Error('Unknown or expired OIDC state — login session timed out, please retry')
    }
    this.pendingStates.delete(state)

    const providerId = pending.providerId
    const inst = this.instances.get(providerId)
    if (!inst) throw new Error(`OIDC: provider "${providerId}" no longer configured`)

    const doc = await this.getDiscovery(providerId)
    const clientSecret = inst.config.clientSecret
    // A public client (PKCE, no secret) is a valid configuration: send no secret.
    if (typeof clientSecret !== 'string') {
      throw new Error(`OIDC: client secret for "${providerId}" is unavailable`)
    }
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: inst.config.clientId,
        ...(clientSecret.length > 0 ? { client_secret: clientSecret } : {}),
        code_verifier: pending.codeVerifier,
      }),
    })
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '')
      throw new Error(
        `OIDC token exchange failed: ${tokenRes.status} ${tokenRes.statusText} — ${text.slice(0, 200)}`,
      )
    }
    const tokens = (await tokenRes.json()) as OidcTokenResponse

    if (!tokens.id_token) {
      throw new Error('OIDC token response missing id_token')
    }
    if (!inst.jwks) {
      throw new Error('OIDC discovery doc missing jwks_uri — cannot verify id_token signature')
    }
    let payload: jose.JWTPayload
    try {
      const verified = await jose.jwtVerify(tokens.id_token, inst.jwks, {
        issuer: doc.issuer,
        audience: inst.config.clientId,
      })
      payload = verified.payload
    } catch (err) {
      throw new Error(`OIDC id_token verification failed: ${errMsg(err)}`, { cause: err })
    }

    if (typeof payload['nonce'] !== 'string' || payload['nonce'] !== pending.nonce) {
      throw new Error('OIDC id_token nonce mismatch — possible replay attack')
    }

    if (pending.app?.purpose === 'step-up') {
      const authTime = payload['auth_time']
      if (
        typeof authTime !== 'number' ||
        !Number.isFinite(authTime) ||
        authTime * 1000 < pending.createdAt - STEP_UP_MAX_AUTH_AGE_MS
      ) {
        throw new StepUpNotFreshError('OIDC step-up id_token proves no fresh login')
      }
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : null
    if (!sub) {
      throw new Error('OIDC callback: id_token missing required `sub` claim')
    }

    const emailClaim = typeof payload['email'] === 'string' ? payload['email'] : undefined
    const preferredClaim =
      typeof payload['preferred_username'] === 'string' ? payload['preferred_username'] : undefined
    const nameClaim = typeof payload['name'] === 'string' ? payload['name'] : undefined

    const usernameClaim = inst.config.usernameClaim
    const username =
      (usernameClaim === 'preferred_username' && preferredClaim) ||
      (usernameClaim === 'email' && emailClaim) ||
      sub

    // Per-instance userId namespace — `oidc:google:abc` won't collide
    // with `oidc:microsoft:abc` when an operator points two IdPs at
    // the same email.
    const userId = `oidc:${providerId}:${sub}`
    return {
      userId,
      username: String(username),
      ...(emailClaim ? { email: emailClaim } : {}),
      ...(nameClaim ? { displayName: nameClaim } : {}),
      // Never admin from here (D782): the hub signs in the LINKED user from
      // that user's record, and ignores this claim.
      isAdmin: false,
      ...(pending.linkIntent !== undefined ? { linkIntent: pending.linkIntent } : {}),
      // The VERIFIED issuer (jwtVerify enforced it): a link is bound to it (D782).
      issuer: doc.issuer,
      providerId,
      returnBase: pending.returnBase,
      popup: pending.popup,
      ...(pending.browserBinding !== undefined ? { browserBinding: pending.browserBinding } : {}),
      ...(pending.app !== undefined ? { app: pending.app } : {}),
    }
  }

  private validateLocalSessionToken(_token: string): null {
    return null
  }

  // ── HTTP route handlers ───────────────────────────────────────────

  private async handleStart(req: AddonHttpRequest, reply: AddonHttpReply): Promise<void> {
    const providerId = (req.params as Record<string, string>)['providerId'] ?? ''
    if (!this.instances.has(providerId)) {
      reply.code(404)
      reply.send({ error: `Unknown OIDC provider: ${providerId}` })
      return
    }
    const linkParam = (req.query as Record<string, string | undefined>)['link']
    if (linkParam !== undefined && !LINK_INTENT_PATTERN.test(linkParam)) {
      reply.code(400)
      reply.send({ error: 'Malformed link request' })
      return
    }
    const query = req.query as Record<string, string | undefined>
    const popupParam = query['popup']
    // A native app (D858): every parameter is validated BEFORE anything is
    // stored or sent to the IdP, and a refusal is a page that says why.
    let app: AppFlowRequest | undefined
    if (query['app'] === '1') {
      const parsed = parseAppFlowRequest(query)
      if (linkParam !== undefined || popupParam === '1' || !parsed.ok) {
        this.ctx.logger.warn('OIDC app sign-in refused at start', {
          meta: { provider: providerId, reason: parsed.ok ? 'combined-flow' : parsed.reason },
        })
        // The hub renders the refusal in its own styled page (it owns the theme);
        // only a reason CODE travels, so the app's parameters are never echoed.
        const reason: AppStartRefusal = parsed.ok ? 'combined-flow' : parsed.reason
        reply.code(303)
        reply.header('Cache-Control', 'no-store')
        const lang = parseAppPageLang(query['lang'])
        reply.header(
          'Location',
          `${APP_REFUSED_PATH}?reason=${reason}${lang !== undefined ? `&lang=${lang}` : ''}`,
        )
        reply.send('')
        return
      }
      app = parsed.request
    }
    const state = `${app !== undefined ? APP_FLOW_STATE_PREFIX : ''}${crypto.randomBytes(16).toString('base64url')}`
    // Binds the sign-in to THIS browser: the cookie stays here, only its hash
    // travels (pending state → bridge), and the hub's finish compares them.
    const browserState = crypto.randomBytes(32).toString('base64url')
    try {
      const { url, returnBase } = await this.prepareLogin(providerId, state, {
        ...(linkParam !== undefined ? { linkIntent: linkParam } : {}),
        headers: req.headers,
        popup: popupParam === '1',
        browserBinding: crypto.createHash('sha256').update(browserState).digest('hex'),
        ...(app !== undefined ? { app } : {}),
      })
      reply.code(302)
      reply.header('Set-Cookie', ssoStateCookie(browserState, returnBase.startsWith('https:')))
      reply.header('Location', url)
      reply.send('')
    } catch (err) {
      if (err instanceof PendingStatesFullError) {
        this.ctx.logger.warn('OIDC sign-in refused: too many in progress', {
          meta: { provider: providerId },
        })
        if (app !== undefined) {
          reply.code(302)
          reply.header(
            'Location',
            appFlowLocation(app.redirect, { error: 'too-many-requests' }, app.state),
          )
          reply.send('')
          return
        }
        reply.code(429)
        reply.header('Retry-After', '30')
        reply.send({ error: 'Too many sign-ins in progress - try again shortly' })
        return
      }
      reply.code(500)
      reply.send({ error: 'OIDC start failed', message: errMsg(err) })
    }
  }

  private async handleCallbackRoute(req: AddonHttpRequest, reply: AddonHttpReply): Promise<void> {
    const providerId = (req.params as Record<string, string>)['providerId'] ?? ''
    if (!this.instances.has(providerId)) {
      reply.code(404)
      reply.send({ error: `Unknown OIDC provider: ${providerId}` })
      return
    }
    const query = req.query as Record<string, string | undefined>
    const code = query['code']
    const state = query['state']
    const errorParam = query['error']

    // An app flow is answered AT THE APP in every outcome (D858): the pending
    // state names it, and a state that is gone but carries the app prefix gets
    // the fixed default callback. Never a hub error page.
    const pendingApp = state !== undefined ? this.livePending(state)?.app : undefined
    const appFlowState = state?.startsWith(APP_FLOW_STATE_PREFIX) === true
    const answerApp = (error: string): void => {
      this.ctx.logger.warn('OIDC app sign-in refused at callback', {
        meta: { provider: providerId, error },
      })
      if (state !== undefined) this.pendingStates.delete(state)
      reply.code(302)
      reply.header('Cache-Control', 'no-store')
      reply.header(
        'Location',
        pendingApp !== undefined
          ? appFlowLocation(pendingApp.redirect, { error }, pendingApp.state)
          : appFlowLocation(APP_FLOW_DEFAULT_REDIRECT, { error }),
      )
      reply.send('')
    }
    if (appFlowState && pendingApp === undefined) {
      // Expired or replayed: nothing pending to consult, so only the fixed
      // default callback is safe to answer at.
      answerApp(errorParam ? 'idp-error' : 'state-expired')
      return
    }
    if (errorParam && pendingApp !== undefined) {
      answerApp('idp-error')
      return
    }

    if (errorParam) {
      reply.code(400)
      reply.send({
        error: 'OIDC error',
        detail: errorParam,
        description: query['error_description'],
      })
      return
    }
    if (!code || !state) {
      reply.code(400)
      reply.send({ error: 'Missing code or state' })
      return
    }

    try {
      const result = await this.handleCallback(code, state)
      // The flow must finish at the instance it started at: the identity is
      // named from the pending state, the bridge provider from this route.
      if (result.providerId !== providerId) {
        if (result.app !== undefined) {
          answerApp('provider-mismatch')
          return
        }
        reply.code(400)
        reply.send({ error: 'OIDC callback does not match the provider the login started at' })
        return
      }

      // Route through `ctx.api` — `ctx.capabilities` only sees this
      // addon's own group-runner registry and would miss `sso-bridge`
      // when it lives in another process. The api call throws a clear
      // PRECONDITION_FAILED if the provider genuinely isn't registered.
      const { token: bridgeToken } = await this.ctx.api.ssoBridge.signBridgeToken.query({
        claims: {
          userId: result.userId,
          username: result.username,
          isAdmin: result.isAdmin,
          provider: `auth-oidc/${providerId}`,
          ...(result.email ? { email: result.email } : {}),
          ...(result.displayName ? { displayName: result.displayName } : {}),
          ...(result.linkIntent !== undefined ? { linkIntent: result.linkIntent } : {}),
          issuer: result.issuer,
          // Single use: the hub's finish records it and refuses a second time.
          jti: crypto.randomBytes(16).toString('base64url'),
          ...(result.browserBinding !== undefined ? { browserBinding: result.browserBinding } : {}),
          ...(result.app !== undefined
            ? {
                app: {
                  codeChallenge: result.app.codeChallenge,
                  state: result.app.state,
                  purpose: result.app.purpose,
                  redirect: result.app.redirect,
                  ...(result.app.lang !== undefined ? { lang: result.app.lang } : {}),
                },
              }
            : {}),
        },
      })

      // ABSOLUTE, on the origin the sign-in started at (D791): the callback
      // is already there (it is the `redirect_uri`), and naming it keeps the
      // mount prefix a relative `/api/…` would drop.
      const finish = new URLSearchParams({ bridge: bridgeToken })
      if (result.popup) finish.set('popup', '1')
      // An app flow finishes at its own leg, which never sets a web session.
      const finishPath = result.app !== undefined ? 'finish-app' : 'finish'
      reply.code(302)
      reply.header(
        'Location',
        `${result.returnBase}/api/auth/sso/${finishPath}?${finish.toString()}`,
      )
      reply.send('')
    } catch (err) {
      if (pendingApp !== undefined) {
        answerApp(err instanceof StepUpNotFreshError ? 'step-up-not-fresh' : 'idp-failed')
        return
      }
      reply.code(500)
      reply.send({ error: 'OIDC callback failed', message: errMsg(err) })
    }
  }
}

/**
 * The browser-binding cookie (`SSO_STATE_COOKIE`). HttpOnly, Lax (the IdP
 * returns with a top-level GET), path `/` so it reaches the hub's finish under
 * any mount, Secure whenever the sign-in returns over https.
 */
function ssoStateCookie(value: string, secure: boolean): string {
  return [
    `${SSO_STATE_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SSO_STATE_COOKIE_MAX_AGE_SEC}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export default AuthOidcAddon
