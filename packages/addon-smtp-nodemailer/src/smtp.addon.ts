/**
 * SMTP Email addon — wraps `nodemailer` and registers a `smtp-provider` cap collection entry.
 *
 * Every relay is an integration instance (D985, D996): one `relays` record per relay, keyed by
 * the `integrations` registry id and listed on the Integrations page. The addon keeps NO relay
 * setting of its own; the old global settings were moved into a record by the migrations of
 * `./migrations`. A caller of `sendEmail` / `verify` / `getStatus` may name a relay with
 * `instanceId`; without one the first configured relay answers, so every caller written before
 * relays existed keeps working.
 *
 * Transporters are rebuilt lazily whenever a relay's record changes; failures are surfaced via
 * each relay's in-memory `lastError` / `lastVerifiedAt` instead of throwing on boot — operators
 * see the error in the Integrations status badge.
 */
import {
  BaseAddon,
  type ConfigUISchema,
  type IntegrationTestConnectionResult,
  type ISmtpProvider,
  type ProviderRegistration,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  RevConflictError,
  defineAddonMigrations,
  integrationInstancesCapability,
  isSecretFieldView,
  isSecretMarker,
  smtpProviderCapability,
} from '@camstack/types'
import {
  type SmtpCataloguePorts,
  type SmtpRecordState,
  ADDON_MIGRATIONS,
} from './migrations/index.js'
import {
  RelayPool,
  type TransportFactory,
  buildTransportOptions,
  nodemailerFactory,
} from './relay-pool.js'
import {
  RELAY_DEFAULT_BODY,
  RELAY_PORT_BOUNDS,
  type SmtpRelayBody,
  smtpRelaysKind,
} from './relay-record-kinds.js'

/** The addon keeps no setting of its own: the relays are records. */
type SmtpAddonConfig = Readonly<Record<string, unknown>>

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A failure message with the typed password removed, whatever the library echoed. */
function scrub(message: string, secret: string): string {
  return secret.length > 0 ? message.split(secret).join('***') : message
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export class SmtpNodemailerAddon extends BaseAddon<SmtpAddonConfig> {
  private readonly pool: RelayPool
  private instances: RecordIntegrationInstances<SmtpRelayBody> | null = null
  private secretsWarned = false

  /** `factory` is the transporter seam: the loader passes nothing, a spec passes a fake. */
  constructor(private readonly factory: TransportFactory = nodemailerFactory) {
    super({})
    this.pool = new RelayPool(factory, {
      info: (message, context) => this.ctxIfReady?.logger.info(message, context),
      warn: (message, context) => this.ctxIfReady?.logger.warn(message, context),
    })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('smtp-nodemailer needs ctx.records — check execution.placement (hub-only)')
    }
    await records.declare({ relays: smtpRelaysKind })
    this.instances = new RecordIntegrationInstances(records, smtpRelaysKind, {
      description: { instanceMode: 'multiple', kind: 'relays', canTest: true },
      formSchema: () => this.relayForm(),
      initialBody: (name) => ({ ...RELAY_DEFAULT_BODY, name }),
      configured: (body) => body.host.length > 0,
      onChanged: async (id) => {
        await this.refreshOne(id)
      },
      test: (input) => this.probe(input.id, input.values),
    })
    // The addon moves the old settings first, then offers the relays to the Integrations page.
    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()))
    await this.refreshAll()

    const provider: ISmtpProvider = {
      sendEmail: async (input) => this.pool.sendEmail(input.instanceId, input),
      verify: async (input) => this.pool.verify(input?.instanceId),
      getStatus: async (input) => this.pool.status(input?.instanceId),
    }
    return [
      { capability: smtpProviderCapability, provider },
      { capability: integrationInstancesCapability, provider: this.instances.toProvider() },
    ]
  }

  protected async onShutdown(): Promise<void> {
    this.pool.closeAll()
  }

  /** Re-read every relay record and make the pool serve exactly those. */
  private async refreshAll(): Promise<void> {
    if (this.instances === null) return
    let all: Awaited<ReturnType<RecordIntegrationInstances<SmtpRelayBody>['listResolved']>>
    try {
      all = await this.instances.listResolved()
    } catch (err: unknown) {
      // A failed read changes nothing: the pool keeps the relays it has.
      this.ctx.logger.warn('smtp: the relay records could not be read', {
        meta: { error: errMsg(err) },
        tags: { topic: 'smtp', phase: 'records-read-failed' },
      })
      return
    }
    for (const row of all) this.applyRow(row.id, row.body, row.secrets)
    this.pool.retainOnly(new Set(all.map((row) => row.id)))
  }

  /** Re-read ONE relay after a create / update / delete. */
  private async refreshOne(id: string): Promise<void> {
    if (this.instances === null) return
    try {
      const row = await this.instances.readResolved(id)
      if (row === null) this.pool.remove(id)
      else this.applyRow(row.id, row.body, row.secrets)
    } catch (err: unknown) {
      this.ctx.logger.warn('smtp: a relay record could not be read', {
        meta: { error: errMsg(err), integrationId: id },
        tags: { topic: 'smtp', phase: 'records-read-failed' },
      })
    }
  }

  private applyRow(id: string, body: SmtpRelayBody, secrets: 'resolved' | 'unavailable'): void {
    if (secrets === 'unavailable') {
      // A locked keychain is a failed read of the password: keep the relay as it is rather than
      // reconfigure it with an empty one (D49). Warned once per lock.
      if (!this.secretsWarned) {
        this.secretsWarned = true
        this.ctx.logger.warn(
          'smtp: the keychain is locked; relays keep their previous configuration',
          {
            tags: { topic: 'smtp', phase: 'keychain-locked' },
          },
        )
      }
      if (this.pool.has(id)) return
    } else {
      this.secretsWarned = false
    }
    this.pool.apply(id, body)
  }

  /** The ports of the connection migrations: the old settings in, the record out. */
  private migrationPorts(): SmtpCataloguePorts {
    const records = this.ctx.records
    if (records === undefined) throw new Error('records are not available')
    const handle = records.kind(smtpRelaysKind)
    return {
      readStored: async (): Promise<Readonly<Record<string, unknown>>> => {
        const stored = await this.resolveGlobalStore()
        // A password that is still a marker was not resolved: abort before anything is written.
        if (isSecretMarker(stored['password'])) {
          throw new Error('the old SMTP password could not be resolved')
        }
        return stored
      },
      readRawStored: async () => this.resolveGlobalStore(),
      warn: (message: string) => {
        this.ctx.logger.warn(message)
      },
      findIntegration: async () => {
        const existing = await this.ctx.api.integrations.getByAddonId.query({
          addonId: this.ctx.id,
        })
        return existing?.id ?? null
      },
      readRecord: async (id: string): Promise<SmtpRecordState | null> => {
        const row = await handle.getResolved(id)
        if (row === null) return null
        return { host: row.data.host, hasPassword: (row.data.password ?? '').length > 0 }
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
      putRecord: async (id: string, body: SmtpRelayBody): Promise<'created' | 'exists'> => {
        if ((await handle.get(id)) !== null) return 'exists'
        try {
          await handle.put({ id, data: body }, { ifRev: 0 })
        } catch (err: unknown) {
          if (err instanceof RevConflictError) return 'exists'
          throw err
        }
        return 'created'
      },
      clearOldPassword: async () => {
        await this.clearSecrets(['password'])
      },
    }
  }

  /** Probe a relay (EHLO + AUTH) with the form's values, falling back to the stored ones. */
  private async probe(
    id: string | null,
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const stored =
      id !== null && this.instances !== null ? await this.instances.getResolved(id) : null
    const text = (key: 'host' | 'username' | 'fromAddress' | 'fromName'): string => {
      const typed = values[key]
      return typeof typed === 'string' ? typed : (stored?.[key] ?? '')
    }
    const typedPort = values['port']
    const port =
      typeof typedPort === 'number' && Number.isFinite(typedPort)
        ? typedPort
        : (stored?.port ?? RELAY_DEFAULT_BODY.port)
    const typedSecure = values['secure']
    const secure = typeof typedSecure === 'boolean' ? typedSecure : (stored?.secure ?? false)
    // A password typed in the form is used; a redaction token or a secret view means "the stored one".
    const typedPassword = values['password']
    const fresh =
      hasText(typedPassword) &&
      typedPassword !== REDACTED_SECRET &&
      !isSecretFieldView(typedPassword)
    const password = fresh ? typedPassword : (stored?.password ?? '')
    const host = text('host')
    if (host.length === 0) return { success: false, status: 'rejected', error: 'No SMTP host set' }
    if (port < RELAY_PORT_BOUNDS.min || port > RELAY_PORT_BOUNDS.max) {
      return { success: false, status: 'rejected', error: `Port ${port} is out of range` }
    }
    const started = Date.now()
    const transporter = this.factory(
      buildTransportOptions({
        name: stored?.name ?? 'probe',
        host,
        port,
        secure,
        username: text('username'),
        password,
        fromAddress: text('fromAddress'),
        fromName: text('fromName'),
      }),
    )
    try {
      await transporter.verify()
      return { success: true, status: 'validated', latencyMs: Date.now() - started }
    } catch (err: unknown) {
      return { success: false, status: 'inconclusive', error: scrub(errMsg(err), password) }
    } finally {
      transporter.close()
    }
  }

  // ── Instance form ─────────────────────────────────────────────────

  private relayForm(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'smtp-relay',
          title: 'SMTP Relay',
          description:
            'Outbound SMTP relay used by notifications and alerts. Use Test connection to verify it; the Integrations status badge shows the last result.',
          columns: 2,
          fields: [
            {
              type: 'text',
              key: 'host',
              label: 'Host',
              description: 'SMTP host (e.g. `smtp.postmarkapp.com`).',
            },
            {
              type: 'number',
              key: 'port',
              label: 'Port',
              description: 'Common values: 25 (plain), 465 (TLS), 587 (STARTTLS).',
              min: RELAY_PORT_BOUNDS.min,
              max: RELAY_PORT_BOUNDS.max,
              step: 1,
            },
            {
              type: 'boolean',
              key: 'secure',
              label: 'Use TLS on connect',
              description: 'Enable for implicit TLS (port 465). Leave off for STARTTLS on 587/25.',
            },
            {
              type: 'text',
              key: 'username',
              label: 'Username',
              description: 'Leave blank for anonymous relays.',
            },
            {
              type: 'password',
              key: 'password',
              label: 'Password',
              showToggle: true,
            },
            {
              type: 'text',
              key: 'fromAddress',
              label: 'Default From address',
              description:
                'Used when a `sendEmail` caller omits `from`. Must be authorised by your relay.',
            },
            {
              type: 'text',
              key: 'fromName',
              label: 'Default From display name',
              description: 'Optional. Rendered as `"Name" <addr>` in the From header.',
            },
          ],
        },
      ],
    })
  }
}

export default SmtpNodemailerAddon
