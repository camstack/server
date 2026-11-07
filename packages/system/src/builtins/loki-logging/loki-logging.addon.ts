/**
 * Loki logging addon — ships this node's log entries to a Grafana Loki instance.
 *
 * OPT-IN. It is a builtin so it is always available, but it does nothing until an
 * operator supplies a URL: `url` defaults to empty and `LokiDestination` treats
 * that as inert. Whether it is used at all is the per-destination
 * `log-destination` capability toggle — the ONE enable (D777); the old private
 * `enabled` setting is retired by a ledger migration (`migrations/retired-enabled-flag.ts`). The provider is
 * registered either way, so the Logging page can show it and the operator can
 * turn it on without a restart of anything else.
 *
 * Sits at the same level as `winston-logging` (rotated files), `console-logging`
 * (stdout) and `hub-forwarder` (agent → hub): all four are `log-destination`
 * collection providers, `LogManager` fans every entry to all of them, and each is
 * independently configurable. Enabling this one does not disable any other.
 *
 * Why Loki's push API rather than Promtail: see the docblock in `loki-payload.ts`.
 */
import type {
  ConfigUISchema,
  IntegrationTestConnectionResult,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseAddon,
  type ResolvedInstance,
  defineAddonMigrations,
  integrationInstancesCapability,
  logDestinationCapability,
  isSecretFieldView,
  isSecretMarker,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  RevConflictError,
  bareAddonId,
  isInstanceEnabled,
  isSameAddonId,
} from '@camstack/types'
import type { LokiConfig } from './loki-destination.js'
import { LokiDestinationSet } from './loki-destination-set.js'
import {
  type LokiCataloguePorts,
  type LokiRecordState,
  type RegistryState,
  REGISTRY_TOGGLE_TO_RECORD_ID,
} from './migrations/index.js'
import {
  LOKI_DEFAULT_BODY,
  type LokiDestinationBody,
  lokiDestinationsKind,
} from './loki-record-kinds.js'
import { ADDON_MIGRATIONS, INITIALIZE_MIGRATIONS } from './migrations/index.js'

/**
 * The addon keeps NO connection setting of its own (D985): the connection is a `destinations`
 * record. What remains in the settings store is the D777 retirement marker only.
 */
type LokiAddonConfig = Readonly<Record<string, unknown>>

/** An agent re-reads the record on this period; the hub applies a change at once (`onChanged`). */
const AGENT_REFRESH_MS = 30_000

/** The headers the destination itself sends: tenant and basic auth. */
function probeHeaders(auth: {
  readonly username: string
  readonly tenantId: string
  readonly password: string
}): Record<string, string> {
  const headers: Record<string, string> = {}
  if (auth.tenantId.trim().length > 0) headers['X-Scope-OrgID'] = auth.tenantId.trim()
  if (auth.username.length > 0) {
    const token = Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
    headers['authorization'] = `Basic ${token}`
  }
  return headers
}

/** A failure message with the userinfo of any URL in it (and the typed URL's own) removed. */
export function stripUserinfo(message: string, typedUrl: string): string {
  let out = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
  try {
    const parsed = new URL(typedUrl)
    for (const secret of [parsed.username, parsed.password]) {
      if (secret.length > 0) out = out.split(decodeURIComponent(secret)).join('***')
    }
  } catch {
    // an unparseable URL carries no userinfo to strip
  }
  return out
}

/** Where the connection probe asks: Loki answers `ready` once its ring is up. */
const READY_PATH = '/ready'

export class LokiLoggingAddon extends BaseAddon<LokiAddonConfig> {
  private destination: LokiDestinationSet | null = null
  private instances: RecordIntegrationInstances<LokiDestinationBody> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private shuttingDown = false
  private declared = false
  /** Instances whose keychain lock was already warned about — once per lock, per instance. */
  private readonly secretsWarned = new Set<string>()

  constructor() {
    super({})
  }

  private isHub(): boolean {
    return (this.ctx.kernel.localNodeId ?? 'hub') === 'hub'
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.destination = new LokiDestinationSet()
    this.shuttingDown = false
    const registrations: ProviderRegistration[] = [
      { capability: logDestinationCapability, provider: this.destination },
    ]
    const records = this.ctx.records
    if (records !== undefined) {
      const hub = this.isHub()
      // An agent boots while the hub may be unreachable: a refused declare must not fail the
      // boot, the poll below declares again and recovers. The hub owns the data, so it fails loud.
      if (hub) await this.ensureDeclared()
      else await this.ensureDeclaredQuietly()
      this.instances = new RecordIntegrationInstances(records, lokiDestinationsKind, {
        description: {
          role: 'services',
          instanceMode: 'multiple',
          kind: 'destination',
          canTest: true,
        },
        formSchema: () => this.connectionForm(),
        initialBody: (name) => ({ ...LOKI_DEFAULT_BODY, name }),
        configured: (body) => body.url.length > 0,
        onChanged: async () => {
          await this.refreshFromRecord()
        },
        test: (input) => this.probe(input.id, input.values),
      })
      if (hub) {
        // The hub owns the integration row and the record: it moves the old settings
        // first, then offers the connection to the Integrations page (D985).
        await this.runMigrations(
          defineAddonMigrations(await this.initializeCatalogue(), this.migrationPorts()),
        )
        registrations.push({
          capability: integrationInstancesCapability,
          provider: this.instances.toProvider(),
        })
      } else {
        this.refreshTimer = setInterval(() => void this.refreshFromRecord(), AGENT_REFRESH_MS)
        this.refreshTimer.unref?.()
      }
      await this.refreshFromRecord()
    }
    await this.destination.initialize()
    // Logged once, at boot, by the ADDON — not by the destination, which must
    // never log (it would feed itself). Safe here because it happens before the
    // destination is registered and cannot recurse.
    const urls = this.destination
      .getStatuses()
      .filter((status) => status.configured)
      .map((status) => status.instanceId)
    this.ctx.logger.info(
      urls.length > 0
        ? `Loki logging initialized with ${String(urls.length)} destination(s): ${urls.join(', ')}`
        : 'Loki logging registered but inactive (no destination configured)',
    )
    return registrations
  }

  private async ensureDeclared(): Promise<void> {
    const records = this.ctx.records
    if (records === undefined || this.declared) return
    await records.declare({ destinations: lokiDestinationsKind })
    this.declared = true
  }

  private async ensureDeclaredQuietly(): Promise<void> {
    try {
      await this.ensureDeclared()
    } catch (err: unknown) {
      this.ctx.logger.warn('Loki logging: the connection kind could not be declared yet', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Re-read every connection record and reconcile the live destinations with them: a new record
   * starts one, an edit reconfigures it, a deleted record closes its client. A record whose
   * secret cannot be read (locked keychain) keeps the configuration it had (D49) and is skipped
   * if it never had one; the others are unaffected.
   */
  private async refreshFromRecord(): Promise<void> {
    if (this.instances === null || this.shuttingDown) return
    let resolved: readonly ResolvedInstance<LokiDestinationBody>[]
    try {
      if (!this.declared) await this.ensureDeclared()
      resolved = await this.instances.listResolved()
    } catch (err: unknown) {
      // A failed read changes nothing: the destinations keep the config they have.
      this.ctx.logger.warn('Loki logging: the connection records could not be read', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    const configs = new Map<string, LokiConfig>()
    const keep = new Set<string>()
    for (const instance of resolved) {
      if (instance.secrets === 'unavailable') {
        keep.add(instance.id)
        if (!this.secretsWarned.has(instance.id)) {
          this.secretsWarned.add(instance.id)
          this.ctx.logger.warn(
            `Loki logging: the keychain is locked; destination ${instance.id} keeps its previous configuration`,
          )
        }
        continue
      }
      this.secretsWarned.delete(instance.id)
      configs.set(instance.id, this.destinationConfig(instance.body))
    }
    await this.destination?.apply(configs, keep)
  }

  /**
   * The catalogue to offer while initialising. Seq 3 cannot decide before registration, so it is
   * left out (`INITIALIZE_MIGRATIONS`) — unless the ledger already holds it APPLIED: then the full
   * catalogue is offered and the engine skips it, whereas a subset would make it log the id as a
   * database newer than this code on every boot. A ledger that cannot be read offers the subset.
   */
  private async initializeCatalogue(): Promise<typeof ADDON_MIGRATIONS> {
    try {
      const { entries } = await this.ctx.api.migrations.listLedger.query({})
      const done = entries.some(
        (e) => e.id === REGISTRY_TOGGLE_TO_RECORD_ID && e.status === 'applied',
      )
      return done ? ADDON_MIGRATIONS : INITIALIZE_MIGRATIONS
    } catch {
      return INITIALIZE_MIGRATIONS
    }
  }

  /** The ports of the connection migrations: the old settings in, the record out. */
  private migrationPorts(): LokiCataloguePorts {
    const records = this.ctx.records
    const instances = this.instances
    if (records === undefined || instances === null) throw new Error('records are not available')
    const handle = records.kind(lokiDestinationsKind)
    return {
      readStored: async (): Promise<Readonly<Record<string, unknown>>> => {
        const stored = await this.resolveGlobalStore()
        // A password that is still a marker was not resolved: abort before anything is written.
        const password = stored['password']
        if (isSecretMarker(password)) throw new Error('the old Loki password could not be resolved')
        return stored
      },
      readRawStored: async () => this.resolveGlobalStore(),
      info: (message: string) => {
        this.ctx.logger.info(message)
      },
      warn: (message: string) => {
        this.ctx.logger.warn(message)
      },
      findIntegration: async () => {
        const existing = await this.ctx.api.integrations.getByAddonId.query({
          addonId: this.ctx.id,
        })
        return existing?.id ?? null
      },
      readRecord: async (id: string): Promise<LokiRecordState | null> => {
        const row = await handle.getResolved(id)
        if (row === null) return null
        return {
          url: row.data.url,
          hasPassword: (row.data.password ?? '').length > 0,
        }
      },
      ensureIntegration: async (name: string) => {
        const existing = await this.ctx.api.integrations.getByAddonId.query({
          addonId: this.ctx.id,
        })
        if (existing !== null && existing !== undefined) return existing.id
        const created = await this.ctx.api.integrations.create.mutate({
          addonId: this.ctx.id,
          name,
          skipRestart: true,
        })
        return created.id
      },
      putRecord: async (id: string, body: LokiDestinationBody): Promise<'created' | 'exists'> => {
        if ((await handle.get(id)) !== null) return 'exists'
        try {
          await handle.put({ id, data: body }, { ifRev: 0 })
        } catch (err: unknown) {
          if (err instanceof RevConflictError) return 'exists'
          throw err
        }
        return 'created'
      },
      readRegistryState: async (): Promise<RegistryState> => {
        const providers = await this.ctx.api.addons.listCapabilityProviders.query({
          capName: logDestinationCapability.name,
        })
        const own = providers.find((p) => isSameAddonId(p.addonId, this.ctx.id))
        if (own === undefined) return 'unregistered'
        return own.isActive ? 'active' : 'inactive'
      },
      findToggleRecord: async () => {
        const [first] = await instances.listResolved()
        return first === undefined ? null : { id: first.id, enabled: first.enabled }
      },
      disableRecord: async (id: string) => {
        await handle.patch(id, { enabled: false })
      },
      enableRegistry: async () => {
        await this.ctx.api.addons.setCapabilityProviderEnabled.mutate({
          capName: logDestinationCapability.name,
          addonId: bareAddonId(this.ctx.id),
          enabled: true,
        })
      },
      clearOldPassword: async () => {
        await this.clearSecrets(['password'])
      },
    }
  }

  /** Probe a Loki instance (`/ready`) with the form's values, falling back to the stored ones. */
  private async probe(
    id: string | null,
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const stored =
      id !== null && this.instances !== null ? await this.instances.getResolved(id) : null
    const typed = (key: 'url' | 'username' | 'tenantId'): string => {
      const value = values[key]
      return typeof value === 'string' && value.length > 0 ? value : (stored?.[key] ?? '')
    }
    const url = typed('url')
    if (url.length === 0) return { success: false, status: 'rejected', error: 'No Loki URL set' }
    // A password typed in the form is used; a redaction token or a secret view means "the stored one".
    const password = values['password']
    const fresh =
      typeof password === 'string' &&
      password.length > 0 &&
      password !== REDACTED_SECRET &&
      !isSecretFieldView(password)
    const headers = probeHeaders({
      username: typed('username'),
      tenantId: typed('tenantId'),
      password: fresh ? password : (stored?.password ?? ''),
    })
    const started = Date.now()
    try {
      const res = await fetch(new URL(READY_PATH, url), {
        headers,
        signal: AbortSignal.timeout(stored?.timeoutMs ?? LOKI_DEFAULT_BODY.timeoutMs),
      })
      return res.ok
        ? {
            success: true,
            status: 'validated',
            latencyMs: Date.now() - started,
          }
        : {
            success: false,
            status: 'rejected',
            error: `Loki answered HTTP ${res.status}`,
          }
    } catch (err: unknown) {
      return {
        success: false,
        status: 'inconclusive',
        error: stripUserinfo(err instanceof Error ? err.message : String(err), url),
      }
    }
  }

  /**
   * Registration is done: the hub calls this after the providers are registered, so
   * `listCapabilityProviders` now sees Loki. The registry-toggle migration cannot decide before
   * that (the pass inside `onInitialize` fails, tolerated), so it runs ONCE here, hub-only. A
   * failure is logged and writes nothing; the `tolerate` ledger row keeps it for the next boot.
   */
  override postBrokerStart(): void {
    super.postBrokerStart()
    if (!this.isHub() || this.instances === null || this.shuttingDown) return
    void this.runRegistryToggleMigration()
  }

  private async runRegistryToggleMigration(): Promise<void> {
    try {
      const report = await this.runMigrations(
        defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()),
      )
      if (report.failed.includes(REGISTRY_TOGGLE_TO_RECORD_ID)) {
        this.ctx.logger.warn('Loki logging: the registry-toggle migration is kept for next boot')
        return
      }
      await this.refreshFromRecord()
    } catch (err: unknown) {
      this.ctx.logger.warn('Loki logging: the registry-toggle migration could not run', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  protected async onShutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    await this.destination?.shutdown()
    this.destination = null
  }

  /**
   * React to a settings change (URL, level, batching) without a
   * restart — the contract this addon advertises. `BaseAddon` has already
   * reloaded `this.config` by the time this runs; re-apply it to the live
   * destination so setting or clearing the URL actually starts (or stops)
   * pushing. Without this the destination keeps its boot-time config forever.
   */
  protected async onConfigChanged(): Promise<void> {
    // The settings store holds no connection any more: a settings write (the D777
    // marker, the migration's key removal) never changes the destination.
    await this.refreshFromRecord()
  }

  /**
   * `node` is a Loki LABEL, so it must be the node's real identity and must not
   * be operator-editable — a typo would fork the stream and split a node's history
   * in two. `kernel.localNodeId` is the Moleculer node id (`'hub'` on the hub, the
   * agent's own name elsewhere), which is exactly the bounded value wanted here.
   *
   * NOT named `resolveConfig`: `BaseAddon` already has a protected
   * `resolveConfig()` that reloads persisted settings, and shadowing it with a
   * different signature is a type error — usefully, since silently overriding it
   * would have broken this addon's settings reload.
   */
  private destinationConfig(body: LokiDestinationBody): LokiConfig {
    // The destination's own gate is "enabled AND a URL is set". `enabled` is the instance's switch
    // on the record (D996, `setInstanceEnabled`); the registry toggle (D777) is no longer the
    // operator's switch and is left on.
    return {
      enabled: isInstanceEnabled(body),
      url: body.url,
      job: body.job,
      node: this.ctx.kernel.localNodeId ?? 'hub',
      level: body.level,
      batchIntervalMs: body.batchIntervalMs,
      batchSize: body.batchSize,
      extraLabels: body.extraLabels,
      tenantId: body.tenantId,
      username: body.username,
      password: body.password ?? '',
      timeoutMs: body.timeoutMs,
    }
  }

  getDestination(): LokiDestinationSet {
    if (!this.destination) throw new Error('Loki logging not initialized')
    return this.destination
  }

  private connectionForm(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'loki-logging',
          title: 'Loki',
          titleKey: 'server:globalSettings.s_loki-logging.title',
          description:
            'Ship this node’s logs to a Grafana Loki instance. Independent of the rotated-file and console destinations. Turn it on or off with the Enable/Disable control on this destination — the same one every other destination uses.',
          descriptionKey: 'server:globalSettings.s_loki-logging.description',
          columns: 2,
          fields: [
            this.field({
              type: 'text',
              key: 'url',
              label: 'Loki URL',
              labelKey: 'server:globalSettings.s_loki-logging.url.label',
              description: 'Base URL, e.g. http://loki:3100 — the /loki/api/v1/push path is added.',
              descriptionKey: 'server:globalSettings.s_loki-logging.url.description',
              placeholder: 'http://loki:3100',
              default: '',
            }),
            this.field({
              type: 'select',
              key: 'level',
              label: 'Minimum level',
              labelKey: 'server:globalSettings.s_loki-logging.level.label',
              default: 'info',
              options: [
                {
                  value: 'debug',
                  label: 'Debug',
                  labelKey: 'server:globalSettings.s_loki-logging.level.o_debug.label',
                },
                {
                  value: 'info',
                  label: 'Info',
                  labelKey: 'server:globalSettings.s_loki-logging.level.o_info.label',
                },
                {
                  value: 'warn',
                  label: 'Warn',
                  labelKey: 'server:globalSettings.s_loki-logging.level.o_warn.label',
                },
                {
                  value: 'error',
                  label: 'Error',
                  labelKey: 'server:globalSettings.s_loki-logging.level.o_error.label',
                },
              ],
            }),
            this.field({
              type: 'text',
              key: 'job',
              label: 'Job label',
              labelKey: 'server:globalSettings.s_loki-logging.job.label',
              description: 'The Loki `job` label. Keep it fixed — labels are indexed.',
              descriptionKey: 'server:globalSettings.s_loki-logging.job.description',
              default: 'camstack',
            }),
            this.field({
              type: 'text',
              key: 'extraLabels',
              label: 'Extra labels',
              labelKey: 'server:globalSettings.s_loki-logging.extraLabels.label',
              description:
                'Static `key=value,key2=value2`. Low-cardinality only: per-entry values belong in the line body, and a high-cardinality label will bring Loki down.',
              descriptionKey: 'server:globalSettings.s_loki-logging.extraLabels.description',
              placeholder: 'env=home,site=garage',
              default: '',
            }),
            this.field({
              type: 'text',
              key: 'tenantId',
              label: 'Tenant ID',
              labelKey: 'server:globalSettings.s_loki-logging.tenantId.label',
              description:
                'Sent as X-Scope-OrgID. Required by Grafana Cloud and multi-tenant Loki.',
              descriptionKey: 'server:globalSettings.s_loki-logging.tenantId.description',
              default: '',
            }),
            this.field({
              type: 'text',
              key: 'username',
              label: 'Username',
              labelKey: 'server:globalSettings.s_loki-logging.username.label',
              description: 'HTTP basic auth. Leave empty for none.',
              descriptionKey: 'server:globalSettings.s_loki-logging.username.description',
              default: '',
            }),
            this.field({
              type: 'password',
              key: 'password',
              label: 'Password',
              labelKey: 'server:globalSettings.s_loki-logging.password.label',
              default: '',
            }),
            this.field({
              type: 'number',
              key: 'batchIntervalMs',
              label: 'Flush interval',
              labelKey: 'server:globalSettings.s_loki-logging.batchIntervalMs.label',
              description: 'How often a partial batch is pushed.',
              descriptionKey: 'server:globalSettings.s_loki-logging.batchIntervalMs.description',
              min: 250,
              max: 60_000,
              step: 250,
              default: 5_000,
              unit: 'ms',
            }),
            this.field({
              type: 'number',
              key: 'batchSize',
              label: 'Batch size',
              labelKey: 'server:globalSettings.s_loki-logging.batchSize.label',
              description: 'Push early once this many entries are queued.',
              descriptionKey: 'server:globalSettings.s_loki-logging.batchSize.description',
              min: 1,
              max: 5_000,
              step: 10,
              default: 200,
            }),
            this.field({
              type: 'number',
              key: 'timeoutMs',
              label: 'Request timeout',
              labelKey: 'server:globalSettings.s_loki-logging.timeoutMs.label',
              min: 1_000,
              max: 60_000,
              step: 500,
              default: 10_000,
              unit: 'ms',
            }),
          ],
        },
      ],
    })
  }
}
