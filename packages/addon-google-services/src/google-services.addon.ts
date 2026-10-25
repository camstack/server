import {
  oauthLandingUrl,
  type OauthLandingOutcome,
  type OauthLandingReason,
  userError,
} from '@camstack/types'
/**
 * Google Services — hub-only broker kind `google` + calendar-source + Gmail smtp.
 * One OAuth account = one broker entry; feature caps aggregate connected brokers.
 */
import {
  BaseAddon,
  addonRoutesCapability,
  brokerCapability,
  buildAddonRouteProvider,
  calendarSourceCapability,
  smtpProviderCapability,
  type AddonHttpReply,
  type AddonHttpRequest,
  type AddonInitResult,
  type DurableState,
  type IAddonHttpRoute,
  type IBrokerProvider,
  type ICalendarSourceProvider,
  type ISmtpProvider,
} from '@camstack/types'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  GoogleBrokerRegistry,
  brokerEntryToSettings,
  migrateLegacyToBrokers,
  stampCalendarId,
} from './google-broker-registry.js'
import {
  buildGoogleBrokerSettingsSchema,
  buildGoogleFeatureSettingsSchema,
} from './google-broker-settings-schema.js'
import { createGoogleCalendarApi, createGoogleCalendarSource } from './google-calendar-source.js'
import { createGmailSmtpProvider } from './google-gmail-smtp.js'
import {
  buildGoogleBrokerReconnectAlert,
  googleBrokerReconnectAlertId,
  isInvalidGrantRefreshError,
} from './google-broker-reconnect-alert.js'
import {
  applyTokenResponse,
  buildAuthorizeUrl,
  exchangeCode,
  needsRefresh,
  probeGoogleOauthClient,
  refreshAccessToken,
} from './google-oauth.js'
import type { GoogleSettingsCap } from './google-settings-copy.js'
import {
  DEFAULT_GOOGLE_CONFIG,
  DEFAULT_OAUTH_STATE,
  GOOGLE_BROKER_KIND,
  GOOGLE_BROKER_KIND_LABEL,
  GOOGLE_CALENDAR_LIST_URL,
  GOOGLE_USERINFO_URL,
  GoogleOauthAccountsStateSchema,
  type GoogleOauthAccount,
  type GoogleOauthAccountsState,
  type GoogleOauthState,
  type GoogleServicesConfig,
} from './google-types.js'
import { pickOauthRedirectOrigin } from './oauth-redirect-origin.js'
import { googleBrokersEntryKind } from './broker-record-kinds.js'
import { GoogleBrokerStore } from './google-broker-store.js'
import type { GoogleBrokerEntry } from './google-types.js'

const ADDON_ID = 'google-services'

/** A callback failure the landing page can name by code. */
class GoogleCallbackError extends Error {
  constructor(
    readonly reason: OauthLandingReason,
    message: string,
  ) {
    super(message)
  }
}
const CALLBACK_PATH = '/oauth/callback'
const START_PATH = '/oauth/start'
const DISCONNECT_PATH = '/oauth/disconnect'

const LegacyOauthStateSchema = z.object({
  refreshToken: z.string().default('').meta({ secret: true }),
  accessToken: z.string().default('').meta({ secret: true }),
  accessExpiresAt: z.number().default(0),
  accountEmail: z.string().default(''),
})

export class GoogleServicesAddon extends BaseAddon<GoogleServicesConfig> {
  protected override readonly secretStatePaths = [
    'oauthAccounts.accounts[id].refreshToken',
    'oauthAccounts.accounts[id].accessToken',
    // Legacy singleton oauth blob — kept until migrate clears it.
    'oauth.refreshToken',
    'oauth.accessToken',
  ]

  private oauthAccountsHandle: DurableState<GoogleOauthAccountsState> | null = null
  private registry = new GoogleBrokerRegistry()
  private brokerStore: GoogleBrokerStore | null = null
  private activeBrokers: readonly GoogleBrokerEntry[] = []
  /** CSRF state → { brokerId, issuedAt } for the in-flight OAuth consents. */
  private pendingStates = new Map<string, { brokerId: string; issuedAt: number }>()
  private publicOrigin: string | null = null

  constructor() {
    super({ ...DEFAULT_GOOGLE_CONFIG })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    this.oauthAccountsHandle = this.state('oauthAccounts', GoogleOauthAccountsStateSchema, {
      accounts: [],
    })
    let oauthAccounts = await this.oauthAccountsHandle.get()

    const legacyHandle = this.state('oauth', LegacyOauthStateSchema, { ...DEFAULT_OAUTH_STATE })
    const legacyOauth = await legacyHandle.get()

    const migrated = migrateLegacyToBrokers(this.config, legacyOauth)
    if (migrated.didMigrate) {
      await this.updateGlobalSettings({
        brokers: [...migrated.brokers],
        clientId: undefined,
        clientSecret: undefined,
        calendarFilter: undefined,
        fromAddress: undefined,
        fromName: undefined,
      })
      if (migrated.oauthAccounts.length > 0) {
        oauthAccounts = { accounts: [...migrated.oauthAccounts] }
        await this.oauthAccountsHandle.set(oauthAccounts)
      }
      await legacyHandle.set({ ...DEFAULT_OAUTH_STATE })
      this.ctx.logger.info('google-services: migrated singleton OAuth to broker google_001', {
        meta: { brokerId: 'google_001', accountEmail: legacyOauth.accountEmail || undefined },
      })
    } else if (
      oauthAccounts.accounts.length === 0 &&
      legacyOauth.refreshToken.length > 0 &&
      this.config.brokers.length > 0
    ) {
      // Brokers already present but tokens still on legacy blob (partial upgrade).
      const primary = this.config.brokers[0]!
      oauthAccounts = {
        accounts: [
          {
            id: primary.id,
            refreshToken: legacyOauth.refreshToken,
            accessToken: legacyOauth.accessToken,
            accessExpiresAt: legacyOauth.accessExpiresAt,
            accountEmail: legacyOauth.accountEmail,
            needsReauth: false,
          },
        ],
      }
      await this.oauthAccountsHandle.set(oauthAccounts)
      await legacyHandle.set({ ...DEFAULT_OAUTH_STATE })
    }

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('google-services: ctx.records is required (hub-only addon)')
    }
    await records.declare({ brokers: googleBrokersEntryKind })
    this.brokerStore = GoogleBrokerStore.of(records)
    this.activeBrokers = await this.loadPersistedBrokers()
    if ((await this.brokerStore.listResolved()).length === 0 && this.config.brokers.length > 0) {
      await this.brokerStore.replaceAll(this.config.brokers)
      this.activeBrokers = await this.loadPersistedBrokers()
    }

    this.registry.seedFrom(this.activeBrokers, oauthAccounts.accounts)
    await this.refreshPublicOrigin()

    const calendarProvider: ICalendarSourceProvider = createGoogleCalendarSource({
      logger: this.ctx.logger,
      accounts: () =>
        this.registry.listEntries().map((entry) => ({
          brokerId: entry.id,
          connected: this.registry.isConnected(entry.id),
          api: createGoogleCalendarApi(() => this.ensureAccessToken(entry.id)),
        })),
      selectedCalendarIds: () => new Set(this.config.calendarIds ?? []),
    })

    const smtpProvider: ISmtpProvider = createGmailSmtpProvider({
      accounts: () =>
        this.registry.listEntries().map((entry) => {
          const oauth = this.registry.getOauth(entry.id)
          return {
            brokerId: entry.id,
            accountEmail: oauth?.accountEmail ?? '',
            fromAddress: entry.fromAddress,
            fromName: entry.fromName,
            connected: this.registry.isConnected(entry.id),
            getAccessToken: () => this.ensureAccessToken(entry.id),
          }
        }),
    })

    const routes: readonly IAddonHttpRoute[] = [
      {
        method: 'GET',
        path: START_PATH,
        access: 'admin',
        description: 'Begin Google OAuth for a broker (Calendar + Gmail send)',
        handler: async (req, reply) => this.handleStart(req, reply),
      },
      {
        method: 'GET',
        path: CALLBACK_PATH,
        access: 'public',
        rateLimit: 'auth',
        description: 'Google OAuth callback',
        handler: async (req, reply) => this.handleCallback(req, reply),
      },
      {
        method: 'GET',
        path: DISCONNECT_PATH,
        access: 'admin',
        description: 'Clear Google OAuth tokens for a broker (Sign out)',
        handler: async (req, reply) => this.handleDisconnect(req, reply),
      },
    ]
    const routeProvider = buildAddonRouteProvider(ADDON_ID, routes)

    this.ctx.logger.info('Initialized — google broker + calendar-source + gmail smtp', {
      meta: {
        brokerCount: this.registry.size(),
        connectedCount: this.registry.connectedSize(),
        publicOrigin: this.publicOrigin ?? undefined,
      },
    })

    return {
      providers: [
        { capability: brokerCapability, provider: this.buildBrokerProvider() },
        { capability: calendarSourceCapability, provider: calendarProvider },
        { capability: smtpProviderCapability, provider: smtpProvider },
        { capability: addonRoutesCapability, provider: routeProvider },
      ],
    }
  }

  protected override async onConfigChanged(): Promise<void> {
    const accounts = this.registry.listOauthAccounts()
    this.activeBrokers = await this.loadPersistedBrokers()
    this.registry.seedFrom(this.activeBrokers, accounts)
  }

  private buildBrokerProvider(): IBrokerProvider {
    const ownerAddonId = this.ctx.id
    const owns = (id: string): boolean => this.registry.getEntry(id) !== null
    const notSupported = async (): Promise<never> => {
      throw new Error(
        'google-services broker: publish/subscribe/getState are not supported — use calendar-source / smtp-provider',
      )
    }

    return {
      list: async ({ kind }) => this.registry.listBrokerInfos(ownerAddonId, kind),
      get: async ({ id }) => {
        const entry = this.registry.getEntry(id)
        return entry ? this.registry.toBrokerInfo(entry, ownerAddonId) : null
      },
      listProviders: async () => [
        {
          addonId: ownerAddonId,
          kinds: [
            {
              kind: GOOGLE_BROKER_KIND,
              label: GOOGLE_BROKER_KIND_LABEL,
              // Admin-ui fills {{brokerId}} and opens in a popup (?popup=1).
              interactiveConnectPath: `/addon/${ADDON_ID}${START_PATH}?brokerId={{brokerId}}`,
              interactiveDisconnectPath: `/addon/${ADDON_ID}${DISCONNECT_PATH}?brokerId={{brokerId}}`,
            },
          ],
        },
      ],
      add: async ({ kind, name, settings, id }) => {
        if (kind !== GOOGLE_BROKER_KIND) {
          throw new Error(
            `google-services: only kind '${GOOGLE_BROKER_KIND}' is handled here (got '${kind}')`,
          )
        }
        const entry = this.registry.createEntry(name, settings, id !== undefined ? { id } : {})
        await this.persistBrokers()
        return { id: entry.id }
      },
      remove: async ({ id }) => {
        if (!owns(id)) return
        this.registry.removeEntry(id)
        await this.persistBrokers()
        await this.persistOauthAccounts()
      },
      testConnection: async ({ id }) => {
        if (!owns(id)) return { ok: false, error: 'unknown broker' }
        const entry = this.registry.getEntry(id)
        if (entry === null) return { ok: false, error: 'unknown broker' }
        if (!entry.clientId || !entry.clientSecret) {
          return { ok: false, error: 'Configure Client ID and Client secret first' }
        }
        let redirectUri: string
        try {
          redirectUri = await this.resolveRedirectUri()
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        if (!this.registry.isConnected(id)) {
          // Not signed in yet — still prove the OAuth client is real.
          return probeGoogleOauthClient({
            clientId: entry.clientId,
            clientSecret: entry.clientSecret,
            redirectUri,
          })
        }
        try {
          const started = Date.now()
          // Always refresh on Test — a stale/empty access token still leaves
          // isConnected true (refresh present) and userinfo then 401s with
          // "missing required authentication credential".
          // Probe Calendar (granted by calendar.readonly). Do NOT use userinfo
          // here: tokens minted before userinfo.email was in GOOGLE_OAUTH_SCOPES
          // 401 on userinfo with "missing required authentication credential".
          const token = await this.ensureAccessToken(id, { forceRefresh: true })
          if (token.trim().length === 0) {
            return {
              ok: false,
              error: 'No access token after refresh — Sign out and Sign in again',
            }
          }
          let res = await fetch(GOOGLE_CALENDAR_LIST_URL, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (res.status === 401) {
            const retryToken = await this.ensureAccessToken(id, { forceRefresh: true })
            res = await fetch(GOOGLE_CALENDAR_LIST_URL, {
              headers: { Authorization: `Bearer ${retryToken}` },
            })
          }
          if (!res.ok) {
            const text = await res.text()
            return {
              ok: false,
              error: `Google Calendar probe failed (${res.status}): ${text.slice(0, 200)}`,
            }
          }
          // Best-effort email fill when the token already has userinfo.email.
          const email = await this.fetchAccountEmail(token)
          if (email.length > 0) {
            const oauth = this.registry.getOauth(id)
            if (oauth !== null && oauth.accountEmail !== email) {
              this.registry.setOauth({ ...oauth, accountEmail: email })
              await this.persistOauthAccounts()
            }
          }
          return { ok: true, latencyMs: Date.now() - started }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
      getSettings: async ({ id }) => {
        const entry = this.registry.getEntry(id)
        if (entry === null) return null
        return brokerEntryToSettings(entry)
      },
      setSettings: async ({ id, settings }) => {
        if (!owns(id)) return
        this.registry.updateEntry(id, settings)
        await this.persistBrokers()
      },
      getBrokerConfig: async ({ id }) => {
        const entry = this.registry.getEntry(id)
        if (entry === null) return null
        const oauth = this.registry.getOauth(id)
        return {
          ...brokerEntryToSettings(entry),
          accountEmail: oauth?.accountEmail ?? '',
          connected: this.registry.isConnected(id),
        }
      },
      getSettingsSchema: async ({ kind }) => {
        if (kind !== GOOGLE_BROKER_KIND) return null
        return buildGoogleBrokerSettingsSchema(this.publicOrigin)
      },
      testSettings: async ({ kind, settings }) => {
        if (kind !== GOOGLE_BROKER_KIND) return { ok: false, error: `unsupported kind: ${kind}` }
        try {
          const parsed = z
            .object({
              clientId: z.string().min(1),
              clientSecret: z.string().min(1).meta({ secret: true }),
            })
            .parse(settings)
          const redirectUri = await this.resolveRedirectUri()
          return probeGoogleOauthClient({
            clientId: parsed.clientId,
            clientSecret: parsed.clientSecret,
            redirectUri,
          })
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
      publish: notSupported,
      subscribe: notSupported,
      unsubscribe: notSupported,
      getState: notSupported,
      getStatus: async () => ({
        brokerCount: this.registry.size(),
        connectedCount: this.registry.connectedSize(),
      }),
    }
  }

  private async handleStart(req: AddonHttpRequest, reply: AddonHttpReply): Promise<void> {
    const brokerIdRaw = req.query['brokerId']
    const brokerId = typeof brokerIdRaw === 'string' ? brokerIdRaw.trim() : ''
    if (!brokerId) {
      reply.status(400).send({
        error: 'Missing brokerId query parameter — Connect from Connectivity → Brokers → Edit.',
      })
      return
    }
    const entry = this.registry.getEntry(brokerId)
    if (entry === null) {
      reply.status(404).send({ error: `Unknown Google broker: ${brokerId}` })
      return
    }
    if (!entry.clientId || !entry.clientSecret) {
      reply.status(400).send({
        error: 'Configure Client ID and Client secret on this broker, Save, then Connect.',
      })
      return
    }
    let redirectUri: string
    try {
      redirectUri = await this.resolveRedirectUri()
    } catch (err) {
      reply.status(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    const state = randomBytes(16).toString('hex')
    this.pendingStates.set(state, { brokerId, issuedAt: Date.now() })
    this.prunePendingStates()
    const url = buildAuthorizeUrl(
      {
        clientId: entry.clientId,
        clientSecret: entry.clientSecret,
        redirectUri,
      },
      state,
    )
    reply.redirect(url)
  }

  private async handleCallback(req: AddonHttpRequest, reply: AddonHttpReply): Promise<void> {
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : ''
    const err = req.query['error']
    if (err) {
      const pendingPeek = state ? this.pendingStates.get(state) : undefined
      if (pendingPeek !== undefined) this.pendingStates.delete(state)
      await this.landOnAdminUi(reply, {
        status: 'error',
        addonId: ADDON_ID,
        ...(pendingPeek !== undefined ? { brokerId: pendingPeek.brokerId } : {}),
        reason: err === 'access_denied' ? 'access_denied' : 'invalid_request',
      })
      return
    }
    const code = req.query['code']
    const pending = state ? this.pendingStates.get(state) : undefined
    if (!code || !state || pending === undefined) {
      await this.landOnAdminUi(reply, {
        status: 'error',
        addonId: ADDON_ID,
        reason: 'invalid_state',
      })
      return
    }
    this.pendingStates.delete(state)
    const { brokerId } = pending
    const entry = this.registry.getEntry(brokerId)
    if (entry === null) {
      await this.landOnAdminUi(reply, {
        status: 'error',
        addonId: ADDON_ID,
        brokerId,
        reason: 'unknown_broker',
      })
      return
    }
    try {
      const redirectUri = await this.resolveRedirectUri()
      const tokens = await exchangeCode(
        {
          clientId: entry.clientId,
          clientSecret: entry.clientSecret,
          redirectUri,
        },
        code,
      )
      const prev = this.registry.getOauth(brokerId) ?? {
        id: brokerId,
        ...DEFAULT_OAUTH_STATE,
        needsReauth: false,
      }
      if (!tokens.refresh_token && (!prev.refreshToken || prev.needsReauth)) {
        throw new GoogleCallbackError(
          'no_refresh_token',
          'Google did not return a refresh_token. Revoke CamStack access in Google Account → Security and retry with prompt=consent.',
        )
      }
      const applied = applyTokenResponse(
        {
          refreshToken: prev.needsReauth && tokens.refresh_token ? '' : prev.refreshToken,
          accessToken: prev.accessToken,
          accessExpiresAt: prev.accessExpiresAt,
          accountEmail: prev.accountEmail,
        },
        tokens,
      )
      const email = await this.fetchAccountEmail(applied.accessToken)
      const next: GoogleOauthAccount = {
        id: brokerId,
        refreshToken: applied.refreshToken,
        accessToken: applied.accessToken,
        accessExpiresAt: applied.accessExpiresAt,
        accountEmail: email || applied.accountEmail,
        // A fresh sign-in is what clears a refused token.
        needsReauth: false,
      }
      this.registry.setOauth(next)
      await this.persistOauthAccounts()
      if (next.refreshToken.length > 0) {
        void this.resolveGoogleBrokerReconnectAlert(brokerId)
      }
      // Rename broker to account email when still default-ish.
      if (
        next.accountEmail &&
        (entry.name === 'Google account' || entry.name.startsWith('google_'))
      ) {
        const renamed = { ...entry, name: next.accountEmail }
        this.registry.replaceEntries(
          this.registry.listEntries().map((e) => (e.id === brokerId ? renamed : e)),
        )
        await this.persistBrokers()
      }
      this.ctx.logger.info('google oauth connected', {
        tags: { brokerId },
        meta: {
          brokerId,
          hasRefresh: next.refreshToken.length > 0,
          accountEmail: next.accountEmail || undefined,
        },
      })
      await this.landOnAdminUi(reply, { status: 'success', addonId: ADDON_ID, brokerId })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.ctx.logger.warn('google oauth callback failed', {
        meta: { brokerId, error: message },
      })
      await this.landOnAdminUi(reply, {
        status: 'error',
        addonId: ADDON_ID,
        brokerId,
        reason: e instanceof GoogleCallbackError ? e.reason : 'exchange_failed',
      })
    }
  }

  /**
   * Every OAuth completion ends in CamStack: a redirect to the admin-ui
   * completion page (`/sso-complete`) on the hub's public address (the
   * `local-network` palette role), carrying a status and a reason CODE — never
   * a token, a code or an error message. The page hands a popup's outcome to
   * its opener and closes it, or, in a full-page flow, shows the result and
   * returns to Connectivity.
   */
  private async landOnAdminUi(reply: AddonHttpReply, outcome: OauthLandingOutcome): Promise<void> {
    await this.refreshPublicOrigin()
    reply.redirect(oauthLandingUrl(this.publicOrigin, outcome))
  }

  private async fetchAccountEmail(accessToken: string): Promise<string> {
    try {
      const res = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return ''
      const body = (await res.json()) as { email?: string }
      return typeof body.email === 'string' ? body.email.trim() : ''
    } catch {
      return ''
    }
  }

  private prunePendingStates(): void {
    const cutoff = Date.now() - 10 * 60_000
    for (const [k, v] of this.pendingStates) {
      if (v.issuedAt < cutoff) this.pendingStates.delete(k)
    }
  }

  private async loadPersistedBrokers(): Promise<readonly GoogleBrokerEntry[]> {
    const store = this.brokerStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.brokers
  }

  private async persistBrokers(): Promise<void> {
    const entries = [...this.registry.listEntries()]
    this.activeBrokers = entries
    const store = this.brokerStore
    if (store !== null) {
      await store.replaceAll(entries)
      return
    }
    await this.updateGlobalSettings({ brokers: entries })
  }

  private async persistOauthAccounts(): Promise<void> {
    if (!this.oauthAccountsHandle) return
    await this.oauthAccountsHandle.set({ accounts: [...this.registry.listOauthAccounts()] })
  }

  /** Stamped catalog for Connectivity → Calendars (`optionsFrom`). */
  private async loadStampedCalendarCatalog(): Promise<
    readonly { readonly value: string; readonly label: string }[]
  > {
    const out: { value: string; label: string }[] = []
    for (const entry of this.registry.listEntries()) {
      if (!this.registry.isConnected(entry.id)) continue
      try {
        const api = createGoogleCalendarApi(() => this.ensureAccessToken(entry.id))
        const list = await api.listCalendars()
        const accountLabel = this.registry.getOauth(entry.id)?.accountEmail || entry.name
        for (const c of list) {
          const summary = c.summary.trim().length > 0 ? c.summary : c.id
          out.push({
            value: stampCalendarId(entry.id, c.id),
            label: `${summary} (${accountLabel})`,
          })
        }
      } catch (err) {
        this.ctx.logger.warn('google calendar catalog failed', {
          meta: {
            brokerId: entry.id,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    return out.toSorted((a, b) => a.label.localeCompare(b.label))
  }

  private async emitGoogleBrokerReconnectAlert(
    brokerId: string,
    brokerName: string,
  ): Promise<void> {
    const emit = this.ctx.api.alerts?.emit
    if (emit === undefined) {
      this.ctx.logger.warn('google broker reconnect alert skipped — alerts capability missing', {
        meta: { brokerId },
      })
      return
    }
    try {
      await emit.mutate(buildGoogleBrokerReconnectAlert(brokerId, brokerName))
    } catch (err) {
      this.ctx.logger.warn('google broker reconnect alert emit failed', {
        meta: { brokerId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async resolveGoogleBrokerReconnectAlert(brokerId: string): Promise<void> {
    const update = this.ctx.api.alerts?.update
    if (update === undefined) return
    try {
      await update.mutate({
        alertId: googleBrokerReconnectAlertId(brokerId),
        patch: { status: 'completed', read: true },
      })
    } catch (err) {
      this.ctx.logger.warn('google broker reconnect alert resolve failed', {
        meta: { brokerId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async ensureAccessToken(
    brokerId: string,
    opts: { readonly forceRefresh?: boolean } = {},
  ): Promise<string> {
    const entry = this.registry.getEntry(brokerId)
    const oauth = this.registry.getOauth(brokerId)
    if (entry === null || oauth === null || !oauth.refreshToken.trim()) {
      throw new Error(
        `Google broker ${brokerId} is not connected — use Sign in under Connectivity → Brokers`,
      )
    }
    if (oauth.needsReauth) {
      // Google already refused this refresh token: asking again only adds noise.
      throw new Error(
        `Google broker ${brokerId} needs a new sign-in — use Sign in under Connectivity → Brokers`,
      )
    }
    if (!entry.clientId.trim() || !entry.clientSecret.trim()) {
      throw userError(
        'google.client-credentials-required',
        undefined,
        'Configure Client ID and Client secret before refreshing the Google token',
      )
    }
    const state: GoogleOauthState = {
      refreshToken: oauth.refreshToken.trim(),
      accessToken: oauth.accessToken.trim(),
      accessExpiresAt: oauth.accessExpiresAt,
      accountEmail: oauth.accountEmail,
    }
    if (!opts.forceRefresh && !needsRefresh(state)) {
      return state.accessToken
    }
    let tokens
    try {
      tokens = await refreshAccessToken(
        { clientId: entry.clientId.trim(), clientSecret: entry.clientSecret.trim() },
        state.refreshToken,
      )
    } catch (err) {
      if (isInvalidGrantRefreshError(err)) {
        // Record it: status, Sign-in visibility and the alert then agree.
        if (this.registry.markNeedsReauth(brokerId)) {
          await this.persistOauthAccounts()
        }
        void this.emitGoogleBrokerReconnectAlert(brokerId, entry.name)
      }
      throw err
    }
    if (typeof tokens.access_token !== 'string' || tokens.access_token.trim().length === 0) {
      throw new Error(
        'Google token refresh returned an empty access_token — Sign out and Sign in again',
      )
    }
    const nextState = applyTokenResponse(state, tokens)
    this.registry.setOauth({
      id: brokerId,
      refreshToken: nextState.refreshToken,
      accessToken: nextState.accessToken,
      accessExpiresAt: nextState.accessExpiresAt,
      accountEmail: nextState.accountEmail,
      needsReauth: false,
    })
    await this.persistOauthAccounts()
    return nextState.accessToken
  }

  private async handleDisconnect(req: AddonHttpRequest, reply: AddonHttpReply): Promise<void> {
    const brokerIdRaw = req.query['brokerId']
    const brokerId = typeof brokerIdRaw === 'string' ? brokerIdRaw.trim() : ''
    if (!brokerId) {
      reply.status(400).send({ error: 'Missing brokerId query parameter' })
      return
    }
    const entry = this.registry.getEntry(brokerId)
    if (entry === null) {
      reply.status(404).send({ error: `Unknown Google broker: ${brokerId}` })
      return
    }
    this.registry.removeOauth(brokerId)
    await this.persistOauthAccounts()
    this.ctx.logger.info('google oauth disconnected', { tags: { brokerId }, meta: { brokerId } })
    await this.landOnAdminUi(reply, {
      status: 'success',
      addonId: ADDON_ID,
      brokerId,
      action: 'disconnect',
    })
  }

  private async resolveRedirectUri(): Promise<string> {
    await this.refreshPublicOrigin()
    if (!this.publicOrigin) {
      throw new Error(
        'No hub public address available from local-network — set a Public endpoint on the Network page (OAuth2 redirects use that role, not Internal).',
      )
    }
    return `${this.publicOrigin.replace(/\/$/, '')}/addon/${ADDON_ID}${CALLBACK_PATH}`
  }

  private async refreshPublicOrigin(): Promise<void> {
    try {
      const book = await this.ctx.api.localNetwork.getAddresses.query({})
      this.publicOrigin = pickOauthRedirectOrigin(book)
    } catch {
      this.publicOrigin = null
    }
  }

  /**
   * Connectivity Calendars / Email: point at Brokers (no duplicate OAuth fields).
   * Addon page without cap: same pointer + note.
   */
  protected globalSettingsSchema(cap?: string) {
    const scoped = asSettingsCap(cap)
    return this.schema(buildGoogleFeatureSettingsSchema(scoped, this.publicOrigin))
  }

  override async getGlobalSettings(
    overlay?: Record<string, unknown>,
    cap?: string,
    nodeId?: string,
  ) {
    await this.refreshPublicOrigin()
    if (cap !== 'calendar-source') {
      return super.getGlobalSettings(overlay, cap, nodeId)
    }
    const catalog = await this.loadStampedCalendarCatalog()
    return super.getGlobalSettings(
      {
        ...overlay,
        calendarIds: this.config.calendarIds ?? [],
        ...(catalog.length > 0 ? { _calendarCatalog: catalog } : {}),
      },
      cap,
      nodeId,
    )
  }
}

function asSettingsCap(cap: string | undefined): GoogleSettingsCap {
  if (cap === 'calendar-source' || cap === 'smtp-provider') return cap
  return undefined
}

export default GoogleServicesAddon
