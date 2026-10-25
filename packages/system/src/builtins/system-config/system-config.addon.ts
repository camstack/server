import type { AddonInitResult, ConfigUISchema, ConfigUISchemaWithValues } from '@camstack/types'
import {
  BaseAddon,
  DEFAULT_TOKEN_EXPIRY,
  errMsg,
  hydrateSchema,
  SERVER_NAME_MAX_LENGTH,
  ServerNameSchema,
  shortHostname,
} from '@camstack/types'
import os from 'node:os'
import { parseCidrList, readCidrSetting } from '../../auth/cidr.js'
import {
  AGENT_HTTPS_NAMES_COLLECTION,
  AGENT_HTTPS_NAMES_COLUMNS,
  AgentHttpsNames,
  getProcessAgentHttpsNames,
  setProcessAgentHttpsNames,
} from '../../tls/agent-https-names.js'
import {
  AGENT_DASHBOARD_ORIGINS_FIELD,
  isAllowedAgentDashboardReturnTo,
  isKnownAgentAddress,
  mintAgentUiUnlockTicket,
  parseAgentDashboardOrigins,
} from '../../kernel/moleculer/agent-ui-unlock.js'
import {
  issueMeshLeafForNode,
  MESH_CA_FIELD,
  MESH_NODE_CERTIFICATES_COLLECTION,
  MESH_NODE_CERTIFICATES_COLUMNS,
  MeshCaKeeper,
  openMeshTlsWhenRevocationsLoaded,
  setProcessMeshTlsListenerState,
  MeshCertificateRegistry,
  processMeshCrl,
  requestProcessMeshTlsEnable,
  requireProcessMeshCa,
  setProcessMeshCertificateRegistry,
  type MeshCaSigner,
} from '../../kernel/moleculer/mesh-mtls/index.js'
/** How often superseded and expired mesh certificate rows are reaped. */
const MESH_REAP_MS = 24 * 3_600_000
import { systemConfigMeshActions } from './mesh-actions.js'
import { systemConfigRecordKinds } from './record-kinds.js'

/**
 * Built-in `system-config` addon — Phase 4 of the settings redesign.
 *
 * Exposes the cluster-wide yml-backed sections that the bootstrap
 * loader reads before any addon is instantiated — things that cannot
 * live inside an addon because changing them requires a server
 * restart (port, host, dataPath) or because they own no runtime
 * state of their own (the session token lifetime).
 *
 * Sections exposed — this list is the whole of it:
 *   - server     (port, host, dataPath — READ-ONLY, loaded from config.yaml at bootstrap;
 *                 name = the hub's human name, `server.name`, editable — D861)
 *   - auth       (tokenExpiry = session lifetime, accessTokenExpiry, trustedProxies,
 *                 trustedNetworks)
 *   - cluster    (no operator field remains: the cluster secret and the mesh auth
 *                 mode were removed by D857 — a node's identity is its mesh
 *                 certificate, and agents are paired, not given a secret)
 *
 * Sections NOT exposed (each owned by the addon that implements them):
 *   - logging    → `winston-logging` addon (level + retention)
 *   - recording  → `recording` addon (segment duration, retention)
 *   - retention  → analytics / detection addons (per-table retention)
 *   - ffmpeg     → deleted outright; see the note beside the schema below.
 *
 * Implementation notes:
 *   - Hub-only, and the manifest says so. `ctx.settings` here is
 *     `ConfigManager.createSettingsView`, whose `getSection`/`setSection`
 *     are the `system-settings` keyspace — the SAME keyspace
 *     `ConfigManager.get('auth.tokenExpiry')` resolves, which is what makes
 *     a Save on this form reach `AuthManager.signToken`. An agent's
 *     `ctx.settings` is a different view (`sections` collection) and would
 *     write somewhere nothing reads.
 *   - Reads via `ctx.settings.getSection(section)` and writes via
 *     `ctx.settings.setSection(section, patch)` — the explicit
 *     yml-section pair on `AddonSettingsApi`.
 *   - Does NOT register as a capability provider. It's a pure "settings
 *     surface" addon — its sole purpose is to expose the yml sections
 *     through the new three-level settings API.
 *
 * This addon is declared in `@camstack/system`'s package.json `camstack.addons[]`
 * and loaded automatically via AddonLoader like any other core built-in.
 */

/** Section key → user-facing section title. */
const SECTION_TITLES: Readonly<Record<string, string>> = {
  server: 'Server',
  auth: 'Authentication',
  cluster: 'Cluster',
}

/** The keychain owner of the hub's own secrets (D797). */
const SYSTEM_SECRET_OWNER = 'system'

/** The form key (and the `server` section key) of the hub's human name (D861). */
const SERVER_NAME_FIELD = 'name'

/** Keys that map 1:1 to a given yml section — used by `updateGlobalSettings`
 *  to figure out which section owns each key in the incoming patch. */
const KEY_TO_SECTION: Readonly<Record<string, string>> = {
  // server (read-only)
  port: 'server',
  host: 'server',
  dataPath: 'server',
  // The one editable server key: the hub's human name (D861).
  [SERVER_NAME_FIELD]: 'server',
  // auth
  tokenExpiry: 'auth',
  accessTokenExpiry: 'auth',
  trustedProxies: 'auth',
  trustedNetworks: 'auth',
}

/**
 * Keys a pre-D857 form may still send. They are dropped with a line, never
 * written: the cluster secret and the mesh auth mode no longer exist.
 */
const RETIRED_CLUSTER_KEYS: ReadonlySet<string> = new Set(['clusterSecret', 'meshAuth'])

/**
 * Auth keys holding a list of networks (CIDR or single address). A save with
 * an entry that does not parse is REFUSED whole: dropping it would trust less
 * than the operator wrote, guessing would trust more.
 */
const CIDR_LIST_KEYS: ReadonlySet<string> = new Set(['trustedProxies', 'trustedNetworks'])

/** The section id of the cluster form — System → Cluster renders only this one. */
export const SYSTEM_CONFIG_CLUSTER_SECTION_ID = 'system-config-cluster'

export class SystemConfigAddon extends BaseAddon {
  readonly id = 'system-config'
  private meshCaKeeper: MeshCaKeeper | null = null
  private meshReapTimer: ReturnType<typeof setInterval> | null = null
  private readonly meshGateTimers = new Set<ReturnType<typeof setTimeout>>()
  private stoppedMesh = false
  private loggedNoSettingsStore = false

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<AddonInitResult<typeof systemConfigMeshActions>> {
    // Mesh CA (Release A): key in keychain, cert in cluster.meshCa; enables TLS :6443.
    this.meshCaKeeper = new MeshCaKeeper({
      secrets: this.systemSecrets(),
      readClusterSection: async () => (await this.ctx.settings?.getSection('cluster')) ?? {},
      writeMeshCaCert: async (certPem) => {
        await this.ctx.settings!.setSection('cluster', { [MESH_CA_FIELD]: certPem })
      },
      logger: this.ctx.logger,
      onReady: (ca) => this.onMeshCaReady(ca),
    })
    await this.meshCaKeeper.start()

    this.ctx.logger.info('Initialized — exposes yml-backed sections via getGlobalSettings')
    return {
      customActions: systemConfigMeshActions,
      actionHandlers: {
        mintAgentUiUnlockTicket: async (
          input: unknown,
        ): ReturnType<SystemConfigAddon['mintAgentUiUnlock']> =>
          this.mintAgentUiUnlock(parseMintUnlockInput(input)),
      },
    }
  }

  protected async onShutdown(): Promise<void> {
    setProcessMeshCertificateRegistry(null)
    setProcessMeshTlsListenerState(null)
    setProcessAgentHttpsNames(null)
    this.stoppedMesh = true
    if (this.meshReapTimer !== null) clearInterval(this.meshReapTimer)
    this.meshReapTimer = null
    for (const timer of this.meshGateTimers) clearTimeout(timer)
    this.meshGateTimers.clear()
    this.meshCaKeeper?.stop()
    this.meshCaKeeper = null
  }

  /**
   * The hub's record of mesh leaves (D856): declared and loaded BEFORE the TLS
   * listener opens, so persisted revocations are in the CRL before any node can
   * connect. Best effort: a hub whose settings store is not up still serves the
   * mesh (the registry then fills from the leaves nodes present).
   */
  private async initMeshCertificateRegistry(): Promise<MeshCertificateRegistry | null> {
    const store = this.ctx.api?.settingsStore
    if (!store) {
      if (!this.loggedNoSettingsStore) {
        this.loggedNoSettingsStore = true
        this.ctx.logger.error(
          'No settings store in this process: the revocation registry cannot load, so the mesh TLS listener stays CLOSED and every agent is refused (shown on Identity -> Certificates)',
        )
      }
      return null
    }
    // The names registry is best effort and independent: it must never keep the listener closed.
    const records = this.ctx.records
    const meshKind =
      records === undefined
        ? null
        : (await records.declare(systemConfigRecordKinds),
          records.kind(systemConfigRecordKinds['mesh-node-certificates']))
    void this.loadAgentHttpsNames(store, records)
    try {
      if (records === undefined) {
        await store.declareCollection.mutate({
          collection: MESH_NODE_CERTIFICATES_COLLECTION,
          columns: MESH_NODE_CERTIFICATES_COLUMNS,
          indexes: [{ name: 'idx_mesh_node_certificates_node', columns: ['nodeId'] }],
        })
      }
      const registry = new MeshCertificateRegistry(store, {
        logger: this.ctx.logger,
        meshKind,
      })
      await registry.load()
      const restored = registry.restoreCrl(processMeshCrl())
      const settled = await registry.settleInterruptedRenewals()
      if (settled > 0) {
        this.ctx.logger.warn(
          'A mesh renewal was interrupted by a hub restart - its new leaf was set aside',
          {
            meta: { settled },
          },
        )
      }
      setProcessMeshCertificateRegistry(registry)
      if (restored > 0) {
        this.ctx.logger.info('Mesh revocations restored into the CRL', { meta: { restored } })
      }
      return registry
    } catch (err: unknown) {
      this.ctx.logger.error('Mesh certificate registry unavailable', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  /** Which names the hub certified to which agent. Best effort; nothing waits on it. */
  private async loadAgentHttpsNames(
    store: NonNullable<NonNullable<typeof this.ctx.api>['settingsStore']>,
    records: NonNullable<typeof this.ctx.records> | undefined,
  ): Promise<void> {
    try {
      if (records === undefined) {
        await store.declareCollection.mutate({
          collection: AGENT_HTTPS_NAMES_COLLECTION,
          columns: AGENT_HTTPS_NAMES_COLUMNS,
        })
      }
      const names =
        records === undefined
          ? new AgentHttpsNames(store)
          : new AgentHttpsNames({
              agentHttpsNamesKind: records.kind(systemConfigRecordKinds['agent-https-names']),
              legacyStore: store,
            })
      await names.load()
      setProcessAgentHttpsNames(names)
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'Agent HTTPS names registry unavailable (agent HTTPS issuance will be refused until it loads)',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
    }
  }

  /**
   * The mesh TLS listener opens ONLY after the revocation registry has loaded and its
   * revocations are in the CRL (D856): until then every agent is refused, because an
   * empty CRL would accept a revoked leaf. Retries until the settings store answers.
   */
  private async onMeshCaReady(ca: MeshCaSigner): Promise<void> {
    await openMeshTlsWhenRevocationsLoaded({
      loadRegistry: () => this.initMeshCertificateRegistry(),
      open: async (registry) => {
        const hubLeaf = await issueMeshLeafForNode(ca, 'hub')
        await registry.recordIssued('hub', hubLeaf.certPem, 'boot').catch((err: unknown) => {
          this.ctx.logger.warn('Hub mesh leaf could not be recorded', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
        await registry.reap().catch(() => undefined)
        if (this.meshReapTimer !== null) clearInterval(this.meshReapTimer)
        this.meshReapTimer = setInterval(
          () => void registry.reap().catch(() => undefined),
          MESH_REAP_MS,
        )
        this.meshReapTimer.unref?.()
        await requestProcessMeshTlsEnable({
          caCertPem: ca.certPem,
          certPem: hubLeaf.certPem,
          keyPem: hubLeaf.keyPem,
        })
        this.ctx.logger.info(
          'Mesh CA ready — revocations loaded, TLS material offered to the transporter',
        )
      },
      retry: (fn, ms) => {
        if (this.stoppedMesh) return
        const timer = setTimeout(fn, ms)
        timer.unref?.()
        this.meshGateTimers.add(timer)
      },
      onState: (state) => setProcessMeshTlsListenerState(state),
      onWaiting: (attempt) => {
        // Loud on the first miss, then every 20th (~5 min): the state itself is on the admin page.
        if (attempt === 1 || attempt % 20 === 0) {
          this.ctx.logger.error(
            'Mesh TLS stays CLOSED: the revocation registry has not loaded, so agents are refused rather than accepted with an empty CRL',
            { meta: { attempt } },
          )
        }
      },
      onError: (err) =>
        this.ctx.logger.error('Mesh certificate registry failed to load', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        }),
    })
  }

  /** D821 — short-lived ticket for the agent's `:4444` unlock session. */
  private async mintAgentUiUnlock(input: MintUnlockHandlerInput): Promise<{
    ticket: string
    exp: number
    nodeId: string
    dashboardUrl?: string
  }> {
    const ca = requireProcessMeshCa()
    if (input.dashboardBaseUrl !== undefined) {
      const origins = await this.readAgentDashboardOrigins()
      if (!isAllowedAgentDashboardReturnTo(input.dashboardBaseUrl, origins)) {
        throw new Error(
          'dashboardBaseUrl is not an allowed agent dashboard origin (:4444 or agentDashboardOrigins)',
        )
      }
      // A ticket goes only to an address the hub itself knows for THIS node (its id, or the address of
      // its live mesh socket - the names its HTTPS certificate carries), unless the operator listed
      // the origin explicitly.
      const known = getProcessAgentHttpsNames()?.namesOf(input.nodeId) ?? null
      if (!isKnownAgentAddress(input.dashboardBaseUrl, known, origins)) {
        throw new Error(
          `dashboardBaseUrl is not an address this hub knows for "${input.nodeId}" - open the agent at its own address`,
        )
      }
    }
    // ES256 by the mesh CA key (D857): the agent verifies it with the CA it pinned at pairing.
    const ticket = mintAgentUiUnlockTicket({ caKeyPem: ca.keyPem, nodeId: input.nodeId })
    const payloadJson = Buffer.from(ticket.split('.')[1] ?? '', 'base64url').toString('utf8')
    const exp = (JSON.parse(payloadJson) as { exp?: number }).exp ?? 0
    const dashboardUrl =
      input.dashboardBaseUrl === undefined
        ? undefined
        : (() => {
            const u = new URL(input.dashboardBaseUrl)
            u.searchParams.set('ticket', ticket)
            return u.toString()
          })()
    return {
      ticket,
      exp,
      nodeId: input.nodeId,
      ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
    }
  }

  private async readAgentDashboardOrigins(): Promise<readonly string[]> {
    try {
      const section = await this.ctx.settings?.getSection('cluster')
      return parseAgentDashboardOrigins(section?.[AGENT_DASHBOARD_ORIGINS_FIELD])
    } catch {
      return []
    }
  }

  /** The keychain handle for owner `system`; `null` where there is no door. */
  private systemSecrets() {
    const forOwner = this.ctx.secrets?.forOwner ?? null
    return forOwner === null ? null : forOwner(SYSTEM_SECRET_OWNER)
  }

  // ── Three-level settings API (only `getGlobalSettings` is implemented) ──

  private buildGlobalSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 'system-config-server',
          title: SECTION_TITLES['server']!,
          description:
            'The name of this server, and its connection settings (read-only, loaded from config.yaml at bootstrap).',
          descriptionKey: 'server:global.s_system-config-server.description',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: SERVER_NAME_FIELD,
              label: 'Server name',
              description:
                `Shown in the admin UI and on the apps' sign-in screen (1 to ${SERVER_NAME_MAX_LENGTH} ` +
                "characters). Leave empty to use this machine's hostname.",
              placeholder: hostnameWithoutDomain(),
              span: 2,
            },
            {
              type: 'info',
              key: 'server-restart-note',
              label: 'Restart required',
              labelKey: 'server:global.s_system-config-server.server-restart-note.label',
              content:
                'Port, host and data path are read-only. Change them in config.yaml and restart.',
              variant: 'warning',
            },
            {
              type: 'text',
              key: 'port',
              label: 'Port',
              labelKey: 'server:global.s_system-config-server.port.label',
              description: 'Listening port',
              descriptionKey: 'server:global.s_system-config-server.port.description',
              disabled: true,
            },
            {
              type: 'text',
              key: 'host',
              label: 'Host',
              labelKey: 'server:global.s_system-config-server.host.label',
              description: 'Bind address',
              descriptionKey: 'server:global.s_system-config-server.host.description',
              disabled: true,
            },
            {
              type: 'text',
              key: 'dataPath',
              label: 'Data Path',
              labelKey: 'server:global.s_system-config-server.dataPath.label',
              description: 'Root data directory',
              descriptionKey: 'server:global.s_system-config-server.dataPath.description',
              disabled: true,
              span: 2,
            },
          ],
        },
        {
          id: 'system-config-auth',
          title: SECTION_TITLES['auth']!,
          description: 'Token and session settings.',
          descriptionKey: 'server:global.s_system-config-auth.description',
          columns: 1,
          fields: [
            {
              type: 'text',
              key: 'tokenExpiry',
              label: 'Session lifetime',
              labelKey: 'server:global.s_system-config-auth.tokenExpiry.label',
              description:
                'How long a sign-in lasts without being used, as a duration string (e.g. 7d, ' +
                '30d). Every refresh starts it again, so a device in use stays signed in; one ' +
                'left unopened this long must sign in again. A bare number is rejected — it ' +
                'would be read as milliseconds. Applies from the next sign-in or refresh.',
              descriptionKey: 'server:global.s_system-config-auth.tokenExpiry.description',
              placeholder: DEFAULT_TOKEN_EXPIRY,
              default: DEFAULT_TOKEN_EXPIRY,
            },
            {
              type: 'text',
              key: 'accessTokenExpiry',
              label: 'Access token lifetime',
              labelKey: 'server:global.s_system-config-auth.accessTokenExpiry.label',
              description:
                'How long one access token lives before the app silently swaps it for a new ' +
                'one (e.g. 2h; between 5m and 24h, never longer than the session). Shorter ' +
                'limits how long a copied token is useful. Apps that predate refresh tokens ' +
                'get one token for the whole session instead.',
              descriptionKey: 'server:global.s_system-config-auth.accessTokenExpiry.description',
              placeholder: '2h',
              default: '2h',
            },
            {
              type: 'tags',
              key: 'trustedProxies',
              label: 'Trusted reverse proxies',
              labelKey: 'server:global.s_system-config-auth.trustedProxies.label',
              description:
                'Addresses or CIDR ranges (e.g. 192.168.1.2 or 10.0.0.0/24) of reverse proxies in ' +
                'front of the hub. Only a request whose direct sender is one of these — or this ' +
                'host itself, as with the Cloudflare tunnel — has its X-Forwarded-For / ' +
                'CF-Connecting-IP read as the real client address for rate limits. Leave empty ' +
                'unless a proxy on another host forwards to the hub.',
              descriptionKey: 'server:global.s_system-config-auth.trustedProxies.description',
              creatable: true,
            },
            {
              type: 'info',
              key: 'trustedNetworksWarning',
              label: 'Skipping two-factor authentication',
              labelKey: 'server:global.s_system-config-auth.trustedNetworksWarning.label',
              variant: 'danger',
              content:
                'A sign-in made DIRECTLY from a network listed below skips the second factor ' +
                '(TOTP or passkey): anyone on that network who knows or guesses a password gets ' +
                'in with the password alone — including a compromised camera or a guest device. ' +
                'Requests that come through the Cloudflare tunnel, the public address or any ' +
                'reverse proxy never skip it, whatever address they claim. Every skip is ' +
                'recorded in the authentication audit log. Leave empty (the default) to always ' +
                'ask for the second factor.',
            },
            {
              type: 'tags',
              key: 'trustedNetworks',
              label: 'Trusted networks (skip the second factor)',
              labelKey: 'server:global.s_system-config-auth.trustedNetworks.label',
              description:
                'Addresses or CIDR ranges, e.g. 192.168.1.0/24. Keep it as narrow as you can — ' +
                'a single trusted VLAN, not the whole LAN.',
              descriptionKey: 'server:global.s_system-config-auth.trustedNetworks.description',
              creatable: true,
            },
          ],
        },
        {
          id: SYSTEM_CONFIG_CLUSTER_SECTION_ID,
          title: SECTION_TITLES['cluster']!,
          description:
            'Agents join this hub by pairing (System → Cluster → Agents): the hub signs a ' +
            'certificate for the agent after the operator confirms the same 6-digit code on the ' +
            "hub and in the agent's own page. There is no shared cluster secret.",
          columns: 1,
          fields: [],
        },
        // Removed: the global `ffmpeg` section (binaryPath / hwAccel /
        // threadCount). These were a cross-node footgun — `getSection('ffmpeg')`
        // is node-local (empty on agents). Each ffmpeg consumer now resolves
        // node-locally: binaryPath via ensureFfmpeg() + a per-node override
        // (decoder-ffmpeg / stream-broker `binaryPath@<node>`); hwaccel via
        // ctx.kernel.hwaccel + a per-node `hwaccel@<node>`; threadCount is gone
        // (always auto).
      ],
    }
  }

  async getGlobalSettings(): Promise<ConfigUISchemaWithValues> {
    const schema = this.buildGlobalSchema()
    if (!this.ctx.settings) {
      return hydrateSchema(schema, {})
    }

    // Read all yml sections in parallel and merge their values into a
    // single flat record keyed by field name. The `KEY_TO_SECTION` map
    // guarantees uniqueness (each key belongs to exactly one section).
    const sectionNames = Object.keys(SECTION_TITLES)
    const merged: Record<string, unknown> = {}
    for (const section of sectionNames) {
      try {
        const values = await this.ctx.settings!.getSection(section)
        Object.assign(merged, values)
      } catch (err: unknown) {
        // A section that could not be read is NOT a section at its defaults:
        // hydrating `{}` would show the operator the default token lifetime as
        // if it were the saved one (D315, D675). Fail the form instead.
        this.ctx.logger.warn('system-config: a settings section could not be read', {
          meta: { section, error: errMsg(err) },
        })
        throw err
      }
    }

    // A keychain marker is drawn as a "set" view, never the value (D789).
    return hydrateSchema(schema, merged, { inlineSecretsAsViews: true })
  }

  /**
   * The admin UI / `addonSettings` cap prefer {@link BaseAddon.updateGlobalSettingsAsOperator}.
   * That BaseAddon path writes the generic addon store and never reaches the
   * yml sections. Route the operator write through the same section-aware path
   * as {@link updateGlobalSettings}.
   */
  override async updateGlobalSettingsAsOperator(
    patch: Record<string, unknown>,
    _nodeId?: string,
  ): Promise<void> {
    await this.updateGlobalSettings(patch)
  }

  /**
   * The value to store for a `name` in a save, or `undefined` for "leave the row
   * alone". The whole form posts every field, so an empty box on a hub that was
   * never named is the NORMAL case and must write nothing (D861: a seed never
   * overwrites); an empty box over a stored name is the operator clearing it,
   * which stores `''` (readers treat it as unset). Anything else must be a valid
   * name — refused whole, like the network lists.
   */
  private async normalizeServerName(value: unknown): Promise<string | undefined> {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new Error('The server name must be text')
    if (value.trim() === '') {
      const current = (await this.ctx.settings!.getSection('server'))[SERVER_NAME_FIELD]
      return typeof current === 'string' && current !== '' ? '' : undefined
    }
    const parsed = ServerNameSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? 'The server name is not valid')
    }
    return parsed.data
  }

  async updateGlobalSettings(patch: Record<string, unknown>): Promise<void> {
    if (!this.ctx.settings) {
      throw new Error('system-config: ctx.settings not available — cannot write sections')
    }

    // Group the patch keys by the section they belong to, then write
    // each section in one shot via ctx.settings.setSection(). The
    // server section is read-only, so any keys targeting it are skipped
    // with a warning.
    const perSection = new Map<string, Record<string, unknown>>()
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'meshClearPort') {
        this.ctx.logger.warn(
          'cluster.meshClearPort is retired (D826) — the hub mesh is TLS-only; ignoring this patch',
        )
        continue
      }
      if (key === AGENT_DASHBOARD_ORIGINS_FIELD) {
        this.ctx.logger.warn(
          'cluster.agentDashboardOrigins is no longer writable from settings — ignoring this patch',
        )
        continue
      }
      if (RETIRED_CLUSTER_KEYS.has(key)) {
        this.ctx.logger.warn(
          `cluster.${key} is retired (D857) — agents are paired by certificate; ignoring this patch`,
        )
        continue
      }
      const section = KEY_TO_SECTION[key]
      if (section === undefined) {
        this.ctx.logger.warn('update ignored unknown key (not mapped to any section)', {
          meta: { key },
        })
        continue
      }
      if (key === SERVER_NAME_FIELD) {
        const name = await this.normalizeServerName(value)
        if (name === undefined) continue
        const bucket = perSection.get('server') ?? {}
        bucket[key] = name
        perSection.set('server', bucket)
        continue
      }
      if (section === 'server') {
        this.ctx.logger.warn('update ignored read-only server-section key', { meta: { key } })
        continue
      }
      if (CIDR_LIST_KEYS.has(key)) {
        const { invalid } = parseCidrList(readCidrSetting(value))
        if (invalid.length > 0) {
          throw new Error(`Not a network address or CIDR range: ${invalid.join(', ')}`)
        }
      }
      let bucket = perSection.get(section)
      if (!bucket) {
        bucket = {}
        perSection.set(section, bucket)
      }
      bucket[key] = value
    }

    for (const [section, sectionPatch] of perSection) {
      await this.ctx.settings!.setSection(section, sectionPatch)
      this.ctx.logger.info('Wrote keys to section', {
        meta: { section, keyCount: Object.keys(sectionPatch).length },
      })
    }
  }
}

/** This machine's hostname without its domain: what an unnamed hub is called. */
function hostnameWithoutDomain(): string {
  return shortHostname(os.hostname())
}

interface MintUnlockHandlerInput {
  readonly nodeId: string
  readonly dashboardBaseUrl?: string
}

function parseMintUnlockInput(input: unknown): MintUnlockHandlerInput {
  if (input === null || typeof input !== 'object') {
    throw new Error('system-config: mintAgentUiUnlockTicket requires { nodeId }')
  }
  const nodeId = Reflect.get(input, 'nodeId')
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    throw new Error('system-config: mintAgentUiUnlockTicket requires { nodeId }')
  }
  const dashboardBaseUrl = Reflect.get(input, 'dashboardBaseUrl')
  return {
    nodeId,
    ...(typeof dashboardBaseUrl === 'string' ? { dashboardBaseUrl } : {}),
  }
}

export default SystemConfigAddon
