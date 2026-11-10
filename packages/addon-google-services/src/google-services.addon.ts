import {
  oauthLandingUrl,
  type OauthLandingOutcome,
  type OauthLandingReason,
  userError,
} from '@camstack/types'
/**
 * Google — hub-only broker kind `google` + calendar-source + Gmail smtp.
 * One OAuth account = one broker entry; feature caps aggregate connected brokers.
 */
import {
  BaseAddon,
  addonRoutesCapability,
  brokerCapability,
  buildAddonRouteProvider,
  calendarSourceCapability,
  composeInstanceKinds,
  defineAddonMigrations,
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  RecordIntegrationInstances,
  smtpProviderCapability,
  type AddonHttpReply,
  type AddonHttpRequest,
  type AddonInitResult,
  type IAddonHttpRoute,
  type IBrokerProvider,
  type ICalendarSourceProvider,
  type ISmtpProvider,
  type RecordsAccess,
} from '@camstack/types'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { GoogleBrokerRegistry, brokerEntryToSettings } from './google-broker-registry.js'
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
  type GoogleClientProbeResult,
  refreshAccessToken,
} from './google-oauth.js'
import {
  DEFAULT_GOOGLE_CONFIG,
  DEFAULT_OAUTH_STATE,
  GOOGLE_CALENDAR_LIST_URL,
  GOOGLE_USERINFO_URL,
  type GoogleOauthAccount,
  type GoogleOauthState,
  type GoogleServicesConfig,
} from './google-types.js'
import { pickOauthRedirectOrigin } from './oauth-redirect-origin.js'
import {
  type GoogleBrokerBody,
  type GoogleCalendarBody,
  googleBrokersEntryKind,
  googleCalendarsEntryKind,
} from './broker-record-kinds.js'
import {
  buildGoogleCalendarInstances,
  GOOGLE_CALENDAR_INSTANCE_KIND,
  type GoogleCalendarOption,
  selectedStampedIds,
} from './google-calendar-instances.js'
import { buildGoogleInstances, googleAccountKind } from './google-instances.js'
import { ADDON_MIGRATIONS, type GoogleMigrationPorts } from './migrations/index.js'
import {
  type LegacyBrokerPorts,
  leftoverLegacyKeys,
} from './migrations/legacy-brokers-to-records.js'
import {
  calendarIdsPortsOver,
  calendarRecordPortsOver,
  legacyOauthAccountPortsOver,
  oauthAccountsPortsOver,
} from './migrations/ports.js'
import { GoogleBrokerStore } from './google-broker-store.js'

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

export class GoogleServicesAddon extends BaseAddon<GoogleServicesConfig> {
  // Declared only so the migrations read the legacy `oauthAccounts` state resolved and release its
  // keychain values; the live session is on the account record (planning#480).
  protected override readonly secretStatePaths = [
    'oauthAccounts.accounts[id].refreshToken',
    'oauthAccounts.accounts[id].accessToken',
  ]

  private registry = new GoogleBrokerRegistry()
  private brokerStore: GoogleBrokerStore | null = null
  private instances: RecordIntegrationInstances<GoogleBrokerBody> | null = null
  private calendarInstances: RecordIntegrationInstances<GoogleCalendarBody> | null = null
  /** The stamped calendar ids each account imports, from the `calendars` records. */
  private calendarSelection: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()
  /** CSRF state → { brokerId, issuedAt } for the in-flight OAuth consents. */
  private pendingStates = new Map<string, { brokerId: string; issuedAt: number }>()
  private publicOrigin: string | null = null

  constructor() {
    super({ ...DEFAULT_GOOGLE_CONFIG })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('google-services: ctx.records is required (hub-only addon)')
    }
    await records.declare({ brokers: googleBrokersEntryKind, calendars: googleCalendarsEntryKind })
    this.brokerStore = GoogleBrokerStore.of(records)
    this.instances = this.buildInstances(records)
    this.calendarInstances = buildGoogleCalendarInstances(records, {
      catalog: (accountId) => this.loadCalendarCatalog(accountId),
      onChanged: () => this.refreshCalendarSelection(),
    })
    await this.migrateAccounts(records)
    await this.reloadAccounts()
    await this.refreshCalendarSelection()
    await this.refreshPublicOrigin()

    const calendarProvider: ICalendarSourceProvider = createGoogleCalendarSource({
      logger: this.ctx.logger,
      accounts: () =>
        this.registry.listEntries().map((entry) => ({
          brokerId: entry.id,
          connected: this.registry.isConnected(entry.id),
          api: createGoogleCalendarApi(() => this.ensureAccessToken(entry.id)),
        })),
      selectedCalendarIds: (brokerId) => this.calendarSelection.get(brokerId) ?? new Map(),
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
        {
          capability: integrationInstancesCapability,
          provider: this.buildInstancesProvider(),
        },
        { capability: calendarSourceCapability, provider: calendarProvider },
        { capability: smtpProviderCapability, provider: smtpProvider },
        { capability: addonRoutesCapability, provider: routeProvider },
      ],
    }
  }

  protected override async onConfigChanged(): Promise<void> {
    await this.reloadAccounts()
  }

  /**
   * Seed the registry from the account records: the client and the session (refresh token,
   * email, scopes, needsReauth). The access token is memory only, so it is carried over for an
   * account whose refresh token did not change. A record the keychain cannot serve keeps the
   * session the registry already had (a locked keychain is never "signed out", D49).
   */
  private async reloadAccounts(): Promise<void> {
    const store = this.requireBrokerStore()
    const read = await store.loadAll()
    const sessions: GoogleOauthAccount[] = read.sessions.map((session) => {
      const prev = this.registry.getOauth(session.id)
      const sameToken = prev !== null && prev.refreshToken === session.refreshToken
      return {
        ...session,
        accessToken: sameToken ? prev.accessToken : '',
        accessExpiresAt: sameToken ? prev.accessExpiresAt : 0,
      }
    })
    for (const id of read.unresolved) {
      const prev = this.registry.getOauth(id)
      if (prev !== null) sessions.push(prev)
    }
    if (read.unresolved.length > 0) {
      this.ctx.logger.warn(
        'google-services: the keychain could not serve some accounts; their sign-in is unknown until it can',
        {
          meta: { accounts: read.unresolved },
        },
      )
    }
    this.registry.seedFrom(read.entries, sessions)
  }

  private requireBrokerStore(): GoogleBrokerStore {
    if (this.brokerStore === null)
      throw new Error('google-services: the brokers store is not ready')
    return this.brokerStore
  }

  /** Write one account's session onto its record: the ONE place a session is persisted. */
  private async persistSession(account: GoogleOauthAccount): Promise<void> {
    await this.requireBrokerStore().saveSession(account.id, {
      refreshToken: account.refreshToken,
      accountEmail: account.accountEmail,
      scopes: account.scopes,
      needsReauth: account.needsReauth,
    })
  }

  private requireInstances(): RecordIntegrationInstances<GoogleBrokerBody> {
    if (this.instances === null)
      throw new Error('google-services: instances used before initialize')
    return this.instances
  }

  /** One provider over the two record kinds: the Google accounts and the calendars they import. */
  private buildInstancesProvider(): IIntegrationInstancesProvider {
    const calendars = this.calendarInstances
    if (calendars === null) throw new Error('google-services: instances used before initialize')
    return composeInstanceKinds(
      [
        {
          kind: {
            ...googleAccountKind({
              connectPath: `/addon/${ADDON_ID}${START_PATH}?brokerId={{brokerId}}`,
              disconnectPath: `/addon/${ADDON_ID}${DISCONNECT_PATH}?brokerId={{brokerId}}`,
            }),
            functionCap: 'broker',
          },
          provider: this.requireInstances().toProvider(),
        },
        {
          kind: {
            id: GOOGLE_CALENDAR_INSTANCE_KIND,
            label: 'Google calendar',
            functionCap: 'calendar-source',
            role: 'services',
          },
          provider: calendars.toProvider(),
        },
      ],
      {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'account',
        canTest: true,
        allowRestoreId: true,
      },
    )
  }

  /** Re-read which calendars each account imports from the records. */
  private async refreshCalendarSelection(): Promise<void> {
    const calendars = this.calendarInstances
    if (calendars === null) return
    this.calendarSelection = selectedStampedIds(await calendars.listResolved())
  }

  /** The accounts as `integration-instances`, over the same `brokers` records (planning#408 P3). */
  private buildInstances(
    records: Pick<RecordsAccess, 'kind' | 'owner'>,
  ): RecordIntegrationInstances<GoogleBrokerBody> {
    return buildGoogleInstances(records, {
      connectPath: `/addon/${ADDON_ID}${START_PATH}?brokerId={{brokerId}}`,
      disconnectPath: `/addon/${ADDON_ID}${DISCONNECT_PATH}?brokerId={{brokerId}}`,
      publicOrigin: () => this.publicOrigin,
      mintId: () => this.registry.allocateId(),
      session: (id) =>
        this.registry.isConnected(id)
          ? 'connected'
          : this.registry.needsReauth(id)
            ? 'reauth'
            : 'none',
      onChanged: async () => {
        await this.reloadAccounts()
      },
      testSaved: (id) => this.probeSavedAccount(id),
      testClient: (clientId, clientSecret) => this.probeOauthClient(clientId, clientSecret),
    })
  }

  /**
   * The `broker` cap is the bus only (D1013): the accounts are the `integration-instances`
   * provider; calendar and mail go through their own caps, so publish and subscribe are refused.
   */
  private buildBrokerProvider(): IBrokerProvider {
    const notSupported = async (): Promise<never> => {
      throw new Error(
        'google-services broker: publish/subscribe/getState are not supported — use calendar-source / smtp-provider',
      )
    }

    return {
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

  /** Probe a saved account: the OAuth client, then (when signed in) a Calendar call. */
  private async probeSavedAccount(id: string): Promise<GoogleClientProbeResult> {
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
          const next = { ...oauth, accountEmail: email }
          await this.persistSession(next)
          this.registry.setOauth(next)
        }
      }
      return { ok: true, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Probe an OAuth client that is not saved yet. */
  private async probeOauthClient(
    clientId: string,
    clientSecret: string,
  ): Promise<GoogleClientProbeResult> {
    try {
      const parsed = z
        .object({
          clientId: z.string().min(1),
          clientSecret: z.string().min(1).meta({ secret: true }),
        })
        .parse({ clientId, clientSecret })
      const redirectUri = await this.resolveRedirectUri()
      return probeGoogleOauthClient({
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
        redirectUri,
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
        scopes: '',
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
        scopes: tokens.scope ?? prev.scopes,
        // A fresh sign-in is what clears a refused token.
        needsReauth: false,
      }
      // The record first: a session the record does not hold is not a sign-in.
      await this.persistSession(next)
      this.registry.setOauth(next)
      if (next.refreshToken.length > 0) {
        void this.resolveGoogleBrokerReconnectAlert(brokerId)
      }
      // Rename broker to account email when still default-ish.
      if (
        next.accountEmail &&
        (entry.name === 'Google account' || entry.name.startsWith('google_'))
      ) {
        const renamed = { ...entry, name: next.accountEmail }
        await this.requireBrokerStore().rename(brokerId, renamed.name)
        this.registry.replaceEntries(
          this.registry.listEntries().map((e) => (e.id === brokerId ? renamed : e)),
        )
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

  /**
   * The `google-services` catalogue (D987): the shared calendar set becomes each broker's own
   * (D985), each broker's set becomes `calendars` records linked to the account (D1013), and the
   * `oauthAccounts` state moves onto the account records (planning#480). The registry is seeded
   * after, from what they wrote.
   */
  private async migrateAccounts(records: Pick<RecordsAccess, 'kind'>): Promise<void> {
    const brokers = records.kind({
      name: googleBrokersEntryKind.name,
      declaration: googleBrokersEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    })
    const ports: GoogleMigrationPorts = {
      ...calendarIdsPortsOver(brokers, (key) => this.readStoredGlobalKey(key)),
      ...calendarRecordPortsOver({
        brokers,
        calendars: records.kind(googleCalendarsEntryKind),
        warn: (message) => this.ctx.logger.warn(message),
      }),
      ...this.legacyBrokerPorts(),
      ...oauthAccountsPortsOver({
        store: this.requireBrokerStore(),
        readStored: (key) => this.readStoredGlobalKey(key),
        warn: (message) => this.ctx.logger.warn(message),
        releaseStateSecrets: () => this.writeOwnStore({ oauthAccounts: { accounts: [] } }),
      }),
    }
    const report = await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, ports))
    if ((await this.requireBrokerStore().listResolved()).length === 0) {
      const left = await leftoverLegacyKeys(ports)
      if (left.length > 0) {
        this.ctx.logger.error(
          'google-services: legacy account data was NOT copied into broker records — Google stays unavailable until it is',
          { meta: { leftoverKeys: left, failed: report.failed } },
        )
      }
    }
  }

  /**
   * The migrations' write of the legacy `oauthAccounts` key, through the secret-aware door
   * (markers in, dropped refs released) that a `this.state` handle writes through. Migration-only:
   * a state handle here would keep the credential blob alive beside the records (planning#480).
   */
  private async writeOwnStore(patch: Record<string, unknown>): Promise<void> {
    const settings = this.ctx.settings
    if (settings === undefined) throw new Error('google-services: the settings store is not ready')
    // biome-ignore lint/plugin: migration-only write of a retired key; the same secret-aware write a state handle makes, without keeping a handle on the credential blob
    await settings.writeAddonStore(patch)
  }

  /** The legacy-broker migration's writes: a broker record and an `oauthAccounts` entry, each read back. */
  private legacyBrokerPorts(): LegacyBrokerPorts {
    return {
      putBroker: async (entry) => {
        const store = this.brokerStore
        if (store === null) throw new Error('google-services: the brokers store is not ready')
        await store.putOne(entry)
      },
      readBroker: async (id) => {
        const store = this.brokerStore
        if (store === null) throw new Error('google-services: the brokers store is not ready')
        const found = (await store.listResolved()).find((b) => b.id === id)
        return found === undefined ? null : found
      },
      ...legacyOauthAccountPortsOver({
        readStored: (key) => this.readStoredGlobalKey(key),
        writeStored: (patch) => this.writeOwnStore(patch),
      }),
    }
  }

  /** The calendars one signed-in account lists, by their own id (the picker of a calendar record). */
  private async loadCalendarCatalog(accountId: string): Promise<readonly GoogleCalendarOption[]> {
    const entry = this.registry.getEntry(accountId)
    if (entry === null || !this.registry.isConnected(entry.id)) return []
    try {
      const api = createGoogleCalendarApi(() => this.ensureAccessToken(entry.id))
      const accountLabel = this.registry.getOauth(entry.id)?.accountEmail || entry.name
      return (await api.listCalendars())
        .map((c) => ({
          value: c.id,
          label: `${c.summary.trim().length > 0 ? c.summary : c.id} (${accountLabel})`,
        }))
        .toSorted((a, b) => a.label.localeCompare(b.label))
    } catch (err) {
      this.ctx.logger.warn('google calendar catalog failed', {
        meta: {
          brokerId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return []
    }
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
          const marked = this.registry.getOauth(brokerId)
          if (marked !== null) await this.persistSession(marked)
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
    const next: GoogleOauthAccount = {
      id: brokerId,
      refreshToken: nextState.refreshToken,
      accessToken: nextState.accessToken,
      accessExpiresAt: nextState.accessExpiresAt,
      accountEmail: nextState.accountEmail,
      scopes: tokens.scope ?? oauth.scopes,
      needsReauth: false,
    }
    // The access token is memory only: the record is written only when the session itself moved
    // (Google rotated the refresh token, or granted other scopes), never on every refresh.
    if (next.refreshToken !== oauth.refreshToken || next.scopes !== oauth.scopes) {
      await this.persistSession(next)
    }
    this.registry.setOauth(next)
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
    // The refresh token leaves the record and the keychain; then the runtime forgets it.
    await this.requireBrokerStore().clearSession(brokerId)
    this.registry.removeOauth(brokerId)
    this.ctx.logger.info('google oauth disconnected', {
      tags: { brokerId },
      meta: { brokerId },
    })
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
}

export default GoogleServicesAddon
