import { randomUUID } from 'node:crypto'
import {
  BaseAddon,
  type AddonInitResult,
  type ConfigUISchema,
  type IntegrationTestConnectionResult,
  type ProviderRegistration,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  RevConflictError,
  defineAddonMigrations,
  integrationInstancesCapability,
  isSecretFieldView,
  isSecretMarker,
  turnProviderCapability,
} from '@camstack/types'
import { CloudflareTurnService } from './cloudflare-turn'
import type { CloudflareTurnConfig, TestCredentialsResult } from './cloudflare-turn'
import { cloudflareTurnActions, type CloudflareTurnActions } from './cloudflare-turn-actions'
import {
  ADDON_MIGRATIONS,
  type CloudflareTurnCataloguePorts,
  type CloudflareTurnRecordState,
} from './migrations/index'
import {
  CLOUDFLARE_TURN_DEFAULT_BODY,
  CLOUDFLARE_TURN_RECORD_ID,
  type CloudflareTurnBody,
  cloudflareTurnAccountsKind,
} from './turn-record-kinds'

/**
 * Static `customActions` re-export — picked up by the addon-service-factory
 * when this addon runs in a forked group-runner (the factory reads the
 * module's named export so the Moleculer actions get registered with the
 * canonical schemas). Without this the hub's custom-action dispatch
 * surfaces "no custom action X" because the catalog isn't visible.
 */
export { cloudflareTurnActions as customActions } from './cloudflare-turn-actions'

/** The addon keeps no setting of its own: the account is a record. */
type CloudflareTurnAddonConfig = Readonly<Record<string, unknown>>

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A failure message with the typed token removed, whatever the remote echoed. */
function scrub(message: string, secret: string): string {
  return secret.length > 0 ? message.split(secret).join('***') : message
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Cloudflare TURN (D985, D996): every account is an `accounts` record (a TURN app each),
 * reachable through the `integration-instances` cap and edited on the TURN Servers page. The
 * ICE servers a session receives are the union over the ENABLED accounts. The first account
 * keeps the id `cloudflare-turn` it was created under; the old settings were moved into it by
 * the migrations of `./migrations`.
 */
export class CloudflareTurnAddon extends BaseAddon<CloudflareTurnAddonConfig> {
  /** One service per enabled, configured account, by record id. */
  private readonly services = new Map<string, CloudflareTurnService>()
  private instances: RecordIntegrationInstances<CloudflareTurnBody> | null = null
  private secretsWarned = false

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<AddonInitResult<CloudflareTurnActions>> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('cloudflare-turn needs ctx.records — check execution.placement (hub-only)')
    }
    await records.declare({ accounts: cloudflareTurnAccountsKind })
    this.instances = new RecordIntegrationInstances(records, cloudflareTurnAccountsKind, {
      description: {
        instanceMode: 'multiple',
        kind: 'accounts',
        canTest: true,
      },
      formSchema: () => this.accountForm(),
      initialBody: (name) => ({ ...CLOUDFLARE_TURN_DEFAULT_BODY, name }),
      mintId: () => `cf-turn-${randomUUID().slice(0, 8)}`,
      configured: (body) => body.keyId.trim().length > 0 && (body.apiToken ?? '').length > 0,
      onChanged: async (id) => {
        await this.refreshOne(id)
      },
      test: (input) => this.probe(input.id, input.values),
    })
    // The addon moves the old settings first, then serves the account.
    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()))
    await this.refreshAll()
    this.ctx.logger.info('Cloudflare TURN initialized')
    const providers: ProviderRegistration[] = [
      {
        capability: turnProviderCapability,
        // Read through `this.services` on every call: a changed record swaps its service.
        provider: { getTurnServers: async () => this.collectTurnServers() },
      },
      {
        capability: integrationInstancesCapability,
        provider: this.instances.toProvider(),
      },
    ]
    return {
      providers,
      customActions: cloudflareTurnActions,
      actionHandlers: {
        testCredentials: async (): Promise<TestCredentialsResult> => {
          // Bypass the cache so the test reflects the LIVE record.
          const config = await this.storedConfig()
          return new CloudflareTurnService(config, this.ctx.logger).testCredentials()
        },
      },
    }
  }

  protected async onShutdown(): Promise<void> {
    this.services.clear()
  }

  /** The union over the enabled accounts; one that fails serves nothing and the rest still answer. */
  private async collectTurnServers() {
    const lists = await Promise.all(
      [...this.services.values()].map((service) => service.getTurnServers().catch(() => [])),
    )
    return lists.flat()
  }

  /** The stored key id + token for the probe; empty strings when the record is absent. */
  private async storedConfig(): Promise<CloudflareTurnConfig> {
    const stored =
      this.instances === null ? null : await this.instances.getResolved(CLOUDFLARE_TURN_RECORD_ID)
    return { accountId: stored?.keyId ?? '', apiToken: stored?.apiToken ?? '' }
  }

  /** Re-read every account record and serve exactly those. */
  private async refreshAll(): Promise<void> {
    if (this.instances === null) return
    let all: Awaited<ReturnType<RecordIntegrationInstances<CloudflareTurnBody>['listResolved']>>
    try {
      all = await this.instances.listResolved()
    } catch (err: unknown) {
      // A failed read changes nothing: the addon keeps the accounts it has.
      this.ctx.logger.warn('cloudflare-turn: the account records could not be read', {
        meta: { error: errMsg(err) },
        tags: { topic: 'cloudflare-turn', phase: 'records-read-failed' },
      })
      return
    }
    for (const row of all) this.applyRow(row.id, row.body, row.enabled, row.secrets)
    const live = new Set(all.map((row) => row.id))
    for (const id of [...this.services.keys()]) if (!live.has(id)) this.services.delete(id)
  }

  /** Re-read ONE account after a create / update / delete / switch. */
  private async refreshOne(id: string): Promise<void> {
    if (this.instances === null) return
    try {
      const row = await this.instances.readResolved(id)
      if (row === null) this.services.delete(id)
      else this.applyRow(row.id, row.body, row.enabled, row.secrets)
    } catch (err: unknown) {
      this.ctx.logger.warn('cloudflare-turn: an account record could not be read', {
        meta: { error: errMsg(err), integrationId: id },
        tags: { topic: 'cloudflare-turn', phase: 'records-read-failed' },
      })
    }
  }

  private applyRow(
    id: string,
    body: CloudflareTurnBody,
    enabled: boolean,
    secrets: 'resolved' | 'unavailable',
  ): void {
    if (secrets === 'unavailable') {
      // A locked keychain is a failed read of the token: keep the service as it is rather than
      // reconfigure it with an empty one (D49). Warned once per lock.
      if (!this.secretsWarned) {
        this.secretsWarned = true
        this.ctx.logger.warn(
          'cloudflare-turn: the keychain is locked; accounts keep their previous configuration',
          { tags: { topic: 'cloudflare-turn', phase: 'keychain-locked' } },
        )
      }
      return
    }
    this.secretsWarned = false
    const keyId = body.keyId.trim()
    const apiToken = body.apiToken ?? ''
    if (enabled && keyId.length > 0 && apiToken.length > 0) {
      this.services.set(
        id,
        new CloudflareTurnService({ accountId: keyId, apiToken }, this.ctx.logger),
      )
    } else {
      this.services.delete(id)
    }
  }

  /** Probe the Cloudflare TURN API with the form's values, falling back to the stored ones. */
  private async probe(
    id: string | null,
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const stored =
      id !== null && this.instances !== null ? await this.instances.getResolved(id) : null
    const typedKey = values['keyId']
    const keyId = typeof typedKey === 'string' ? typedKey.trim() : (stored?.keyId ?? '')
    // A token typed in the form is used; a redaction token or a secret view means "the stored one".
    const typedToken = values['apiToken']
    const fresh =
      hasText(typedToken) && typedToken !== REDACTED_SECRET && !isSecretFieldView(typedToken)
    const apiToken = fresh ? typedToken : (stored?.apiToken ?? '')
    const started = Date.now()
    const result = await new CloudflareTurnService(
      { accountId: keyId, apiToken },
      this.ctx.logger,
    ).testCredentials()
    if (result.ok) {
      return {
        success: true,
        status: 'validated',
        latencyMs: Date.now() - started,
      }
    }
    const unauthorised = result.status === 401 || result.status === 403
    return {
      success: false,
      status: unauthorised ? 'rejected' : 'inconclusive',
      error: scrub(result.hint ?? result.body, apiToken),
    }
  }

  /** The ports of the connection migrations: the old settings in, the record out. */
  private migrationPorts(): CloudflareTurnCataloguePorts {
    const records = this.ctx.records
    if (records === undefined) throw new Error('records are not available')
    const handle = records.kind(cloudflareTurnAccountsKind)
    return {
      readStored: async (): Promise<Readonly<Record<string, unknown>>> => {
        const stored = await this.resolveGlobalStore()
        // A token that is still a marker was not resolved: abort before anything is written.
        if (isSecretMarker(stored['apiToken'])) {
          throw new Error('the old Cloudflare TURN API token could not be resolved')
        }
        return stored
      },
      readRawStored: async () => this.resolveGlobalStore(),
      warn: (message: string) => {
        this.ctx.logger.warn(message)
      },
      readRecord: async (): Promise<CloudflareTurnRecordState | null> => {
        const row = await handle.getResolved(CLOUDFLARE_TURN_RECORD_ID)
        if (row === null) return null
        return {
          keyId: row.data.keyId,
          hasApiToken: (row.data.apiToken ?? '').length > 0,
        }
      },
      putRecord: async (body: CloudflareTurnBody): Promise<'created' | 'exists'> => {
        if ((await handle.get(CLOUDFLARE_TURN_RECORD_ID)) !== null) return 'exists'
        try {
          await handle.put({ id: CLOUDFLARE_TURN_RECORD_ID, data: body }, { ifRev: 0 })
        } catch (err: unknown) {
          if (err instanceof RevConflictError) return 'exists'
          throw err
        }
        return 'created'
      },
      clearOldApiToken: async () => {
        await this.clearSecrets(['apiToken'])
      },
    }
  }

  // ── Instance form ─────────────────────────────────────────────────

  private accountForm(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'credentials',
          title: 'Cloudflare Credentials',
          titleKey: 'cloudflare:globalSettings.s_credentials.title',
          description: 'API credentials for fetching TURN relay tokens from Cloudflare Realtime.',
          descriptionKey: 'cloudflare:globalSettings.s_credentials.description',
          fields: [
            {
              type: 'info' as const,
              key: 'turnHelp',
              label: 'How to get the TURN Key ID + API Token',
              labelKey: 'cloudflare:globalSettings.s_credentials.turnHelp.label',
              format: 'html' as const,
              content:
                '<ul>' +
                '<li>Open ' +
                '<a href="https://dash.cloudflare.com/?to=/:account/realtime/turn/overview" ' +
                'target="_blank" rel="noopener noreferrer">' +
                'Cloudflare Dashboard → Realtime → TURN</a>.</li>' +
                '<li>Pick the <strong>TURN</strong> section and click ' +
                '<strong>Create TURN App</strong> (or pick an existing one).</li>' +
                '<li>Cloudflare generates a pair: <strong>Token ID</strong> ' +
                '(hex string, also shown as "Key ID" in some docs) and an ' +
                '<strong>API Token</strong>. Both are app-scoped — they are ' +
                '<em>NOT</em> the same as your Cloudflare Account ID.</li>' +
                '<li>Paste them in the fields below.</li>' +
                '<li>The integration calls ' +
                '<code>rtc.live.cloudflare.com/v1/turn/keys/&lt;TokenId&gt;/credentials/generate-ice-servers</code> ' +
                'to mint short-lived ICE credentials per WebRTC session.</li>' +
                '</ul>',
              variant: 'info' as const,
            },
            {
              type: 'text',
              key: 'keyId',
              label: 'TURN Key ID',
              labelKey: 'cloudflare:globalSettings.s_credentials.accountId.label',
              description:
                "Token ID of the Realtime TURN app (NOT your Cloudflare Account ID — it's a separate hex id generated when you create the TURN app).",
              descriptionKey: 'cloudflare:globalSettings.s_credentials.accountId.description',
              placeholder: 'a1b2c3d4e5f6...',
              required: true,
            },
            {
              type: 'password',
              key: 'apiToken',
              label: 'API Token',
              labelKey: 'cloudflare:globalSettings.s_credentials.apiToken.label',
              description:
                'The API Token shown alongside the Token ID when you created the TURN app. App-scoped — separate from any Cloudflare global API token.',
              descriptionKey: 'cloudflare:globalSettings.s_credentials.apiToken.description',
              showToggle: true,
              required: true,
            },
            {
              type: 'info' as const,
              key: 'usageHelp',
              label: 'Usage & free quota',
              labelKey: 'cloudflare:globalSettings.s_credentials.usageHelp.label',
              format: 'html' as const,
              content:
                "<p>Cloudflare's TURN credentials endpoint we use (<code>Calls:Read</code> " +
                'scope) does not return usage / remaining-free-credit. Check current ' +
                'consumption + free quota in the dashboard:</p>' +
                '<ul>' +
                '<li><a href="https://dash.cloudflare.com/?to=/:account/realtime/turn/overview" ' +
                'target="_blank" rel="noopener noreferrer">' +
                'Cloudflare Dashboard → Realtime → TURN</a> — overview of TURN apps ' +
                'with usage graphs and current-month consumption.</li>' +
                '</ul>' +
                '<p class="text-foreground-subtle text-xs">Wiring a live counter requires ' +
                'a separate API token with <code>Account → Analytics → Read</code> scope ' +
                "and Cloudflare's GraphQL Analytics endpoint. Filed as a follow-up; " +
                'use the dashboard link above in the meantime.</p>',
              variant: 'info' as const,
            },
          ],
        },
      ],
    })
  }
}
