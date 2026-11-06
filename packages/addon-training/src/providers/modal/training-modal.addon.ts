/**
 * `training-modal` — the Modal `training-provider` (D807).
 *
 * Inert until the operator enters a Modal token on an **account** (the `loki-logging` posture):
 * the provider registers anyway so the Training page can list and create accounts. Each account
 * is one `training-account` record (D985, D996), reachable through the `integration-instances`
 * cap and edited with the instances table; region, GPU, cost cap, maximum runtime and the
 * failed-job grace period are per-account settings (operator decision 2026-10-08: they depend on
 * the user's account). The token secret is a keychain marker bound to the record. The accounts
 * the settings held before moved into records under their own ids by the migrations of
 * `./migrations`.
 */
import {
  type AddonInitResult,
  BaseAddon,
  type DurableState,
  type IntegrationTestConnectionResult,
  type ProviderRegistration,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  RevConflictError,
  SECRET_CLEAR,
  defineAddonMigrations,
  integrationInstancesCapability,
  isSecretFieldView,
  isSecretMarker,
  trainingProviderCapability,
  type SecretFieldView,
} from '@camstack/types'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  DEFAULT_MODAL_ENTRY_NAME,
  type ModalEntriesConfig,
  type ModalEntryRecord,
  normalizeModalEntry,
} from './modal-entries.js'
import { MODAL_ENTRY_CONFIG_SCHEMA } from './modal-entry-schema.js'
import {
  ModalTrainingProvider,
  type ModalJobLedger,
  type ModalJobRecord,
} from './modal-provider.js'
import { MODAL_DEFAULT_GPU } from './modal-pricing.js'
import { ModalAuthError } from './modal-gateway.js'
import { ModalSdkGateway } from './modal-sdk-gateway.js'
import {
  ADDON_MIGRATIONS,
  FLAT_ACCOUNT_ID,
  type ModalCataloguePorts,
  type ModalRecordState,
} from './migrations/index.js'
import {
  type TrainingAccountBody,
  trainingAccountEntryKind,
} from './training-account-record-kinds.js'

export type TrainingModalConfig = ModalEntriesConfig

const LEDGER_KEY = 'modalJobs'
const ACCOUNT_KIND = 'training-account'

const ModalJobRecordSchema = z.object({
  jobKey: z.string(),
  entryId: z.string().default(''),
  sandboxId: z.string().nullable(),
  gpuType: z.string(),
  region: z.string(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  exitCode: z.number().nullable(),
  cancelled: z.boolean(),
})
const LedgerSchema = z.record(z.string(), ModalJobRecordSchema)

const FETCH_TIMEOUT_MS = 30_000

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${String(res.status)}`)
  return res.text()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The account record as the provider reads it: the row id plus the resolved body. */
function entryOf(id: string, body: TrainingAccountBody): ModalEntryRecord {
  return normalizeModalEntry({
    id,
    name: body.name,
    tokenId: body.tokenId,
    tokenSecret: body.tokenSecret ?? '',
    environment: body.environment,
    gpuType: body.gpuType,
    region: body.region,
    costCapUsd: body.costCapUsd,
    maxRuntimeHours: body.maxRuntimeHours,
    failedDatasetGraceHours: body.failedDatasetGraceHours,
  })
}

/** What the create form starts with, and what an account created without values holds. */
function initialAccountBody(name: string): TrainingAccountBody {
  return {
    name: name.trim() === '' ? DEFAULT_MODAL_ENTRY_NAME : name.trim(),
    tokenId: '',
    environment: '',
    gpuType: MODAL_DEFAULT_GPU,
    region: '',
    costCapUsd: 5,
    maxRuntimeHours: 4,
    failedDatasetGraceHours: 24,
  }
}

export class TrainingModalAddon extends BaseAddon<TrainingModalConfig> {
  private ledgerState: DurableState<Record<string, ModalJobRecord>> | null = null
  private readonly gateways = new Map<string, { key: string; gateway: ModalSdkGateway }>()
  private instances: RecordIntegrationInstances<TrainingAccountBody> | null = null
  /** The accounts as their records say, secrets resolved; what the provider reads synchronously. */
  private readonly accounts = new Map<string, { entry: ModalEntryRecord; enabled: boolean }>()
  private secretsWarned = false

  /**
   * The old `entries[id].tokenSecret` and flat `tokenSecret` stay declared until the migrations of
   * `./migrations` have moved them: a blocked migration must still resolve them.
   */
  protected override readonly secretStatePaths = ['entries[id].tokenSecret', 'tokenSecret']

  constructor() {
    super({
      entries: [],
      tokenId: '',
      tokenSecret: '',
      environment: '',
      gpuType: MODAL_DEFAULT_GPU,
      region: '',
      costCapUsd: 5,
      maxRuntimeHours: 4,
      failedDatasetGraceHours: 24,
    })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('training-modal: ctx.records is required (hub-only addon)')
    }
    await records.declare({ [ACCOUNT_KIND]: trainingAccountEntryKind })
    const instances = new RecordIntegrationInstances(records, trainingAccountEntryKind, {
      description: { role: 'services', instanceMode: 'multiple', kind: 'account', canTest: true },
      formSchema: () => MODAL_ENTRY_CONFIG_SCHEMA,
      initialBody: (name) => initialAccountBody(name),
      mintId: () => randomUUID(),
      configured: (body) => (body.tokenId ?? '').trim() !== '' && (body.tokenSecret ?? '') !== '',
      onChanged: async (id) => {
        await this.refreshOne(id)
      },
      test: (input) => this.probe(input.id, input.values),
    })
    this.instances = instances

    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()))
    await this.refreshAll()

    this.ledgerState = this.state<Record<string, ModalJobRecord>>(LEDGER_KEY, LedgerSchema, {})
    const peer = this.ctx.peerBytes
    if (peer === undefined) throw new Error('training-modal needs the peer-bytes facility')
    const provider = new ModalTrainingProvider({
      addonId: this.ctx.id,
      // A switched-off account is not offered for a new job; a running one still resolves.
      listEntries: () => [...this.accounts.values()].filter((a) => a.enabled).map((a) => a.entry),
      entry: (entryId) => this.accounts.get(entryId)?.entry ?? null,
      gateway: (entryId) => this.gatewayFor(entryId),
      secretViews: () => this.readEntrySecretViews(),
      ledger: this.ledger(),
      peer,
      fetchText,
      now: () => Date.now(),
      logger: this.ctx.logger,
    })
    this.ctx.logger.info('Modal training provider ready', {
      meta: {
        accounts: this.accounts.size,
        configured: [...this.accounts.values()].some(
          (a) => a.entry.tokenId.trim() !== '' && String(a.entry.tokenSecret).trim() !== '',
        ),
      },
    })
    const providers: ProviderRegistration[] = [
      { capability: trainingProviderCapability, provider },
      { capability: integrationInstancesCapability, provider: instances.toProvider() },
    ]
    return { providers }
  }

  protected async onShutdown(): Promise<void> {
    for (const { gateway } of this.gateways.values()) gateway.close()
    this.gateways.clear()
  }

  protected async onConfigChanged(): Promise<void> {
    // A new token means a new client; drop every cached gateway.
    for (const { gateway } of this.gateways.values()) gateway.close()
    this.gateways.clear()
  }

  private gatewayFor(entryId: string): ModalSdkGateway | null {
    const entry = this.accounts.get(entryId)?.entry
    if (entry === undefined) return null
    const tokenId = (entry.tokenId ?? '').trim()
    const tokenSecret = (typeof entry.tokenSecret === 'string' ? entry.tokenSecret : '').trim()
    if (tokenId === '' || tokenSecret === '') return null
    const environment = (entry.environment ?? '').trim()
    // The secret is part of the key: a changed token is a new client.
    const key = `${tokenId}\u0000${environment}\u0000${tokenSecret}`
    const cached = this.gateways.get(entryId)
    if (cached !== undefined && cached.key === key) return cached.gateway
    cached?.gateway.close()
    const gateway = new ModalSdkGateway({
      tokenId,
      tokenSecret,
      environment,
    })
    this.gateways.set(entryId, { key, gateway })
    return gateway
  }

  private closeGateway(entryId: string): void {
    const cached = this.gateways.get(entryId)
    if (cached === undefined) return
    cached.gateway.close()
    this.gateways.delete(entryId)
  }

  // ── Accounts as records ───────────────────────────────────────────

  /** Re-read every account record and serve exactly those. */
  private async refreshAll(): Promise<void> {
    if (this.instances === null) return
    let all: Awaited<ReturnType<RecordIntegrationInstances<TrainingAccountBody>['listResolved']>>
    try {
      all = await this.instances.listResolved()
    } catch (err: unknown) {
      // A failed read changes nothing: the addon keeps the accounts it has (D49).
      this.ctx.logger.warn('training-modal: the account records could not be read', {
        meta: { error: errMsg(err) },
        tags: { topic: 'training-modal', phase: 'records-read-failed' },
      })
      return
    }
    for (const row of all) this.applyRow(row.id, row.body, row.enabled, row.secrets)
    const live = new Set(all.map((row) => row.id))
    for (const id of [...this.accounts.keys()]) {
      if (live.has(id)) continue
      this.accounts.delete(id)
      this.closeGateway(id)
    }
  }

  /** Re-read ONE account after a create / update / delete / switch. */
  private async refreshOne(id: string): Promise<void> {
    if (this.instances === null) return
    try {
      const row = await this.instances.readResolved(id)
      if (row === null) {
        this.accounts.delete(id)
        this.closeGateway(id)
      } else this.applyRow(row.id, row.body, row.enabled, row.secrets)
    } catch (err: unknown) {
      this.ctx.logger.warn('training-modal: an account record could not be read', {
        meta: { error: errMsg(err), integrationId: id },
        tags: { topic: 'training-modal', phase: 'records-read-failed' },
      })
    }
  }

  private applyRow(
    id: string,
    body: TrainingAccountBody,
    enabled: boolean,
    secrets: 'resolved' | 'unavailable',
  ): void {
    if (secrets === 'unavailable' && this.accounts.has(id)) {
      // A locked keychain is a failed read of the token: keep the account as it is rather than
      // reconfigure it with an empty secret (D49). Warned once per lock.
      if (!this.secretsWarned) {
        this.secretsWarned = true
        this.ctx.logger.warn(
          'training-modal: the keychain is locked; accounts keep their previous configuration',
          { tags: { topic: 'training-modal', phase: 'keychain-locked' } },
        )
      }
      return
    }
    if (secrets === 'resolved') this.secretsWarned = false
    this.accounts.set(id, { entry: entryOf(id, body), enabled })
  }

  /** Keychain views for the edit form, from the record door (a reveal ref bound to the row). */
  private async readEntrySecretViews(): Promise<ReadonlyMap<string, SecretFieldView | null>> {
    const map = new Map<string, SecretFieldView | null>()
    if (this.instances === null) return map
    for (const view of await this.instances.listInstances()) {
      const secret = view.formValues['tokenSecret']
      map.set(view.id, isSecretFieldView(secret) ? secret : null)
    }
    return map
  }

  /** Ask Modal whether the typed (or stored) token is accepted. */
  private async probe(
    id: string | null,
    values: Readonly<Record<string, unknown>>,
  ): Promise<IntegrationTestConnectionResult> {
    const stored =
      id !== null && this.instances !== null ? await this.instances.getResolved(id) : null
    const typedId = values['tokenId']
    const tokenId = (typeof typedId === 'string' ? typedId : (stored?.tokenId ?? '')).trim()
    const typedSecret = values['tokenSecret']
    const fresh =
      typeof typedSecret === 'string' &&
      typedSecret.length > 0 &&
      typedSecret !== REDACTED_SECRET &&
      !isSecretFieldView(typedSecret)
    const tokenSecret = (fresh ? typedSecret : (stored?.tokenSecret ?? '')).trim()
    const typedEnv = values['environment']
    const environment = (
      typeof typedEnv === 'string' ? typedEnv : (stored?.environment ?? '')
    ).trim()
    if (tokenId === '' || tokenSecret === '') {
      return { success: false, status: 'inconclusive', error: 'Enter a Modal token id and secret' }
    }
    const gateway = new ModalSdkGateway({ tokenId, tokenSecret, environment })
    const started = Date.now()
    try {
      await gateway.checkAuth()
      return { success: true, status: 'validated', latencyMs: Date.now() - started }
    } catch (err: unknown) {
      const message = errMsg(err).split(tokenSecret).join('***')
      if (err instanceof ModalAuthError) {
        return {
          success: false,
          status:
            err.reason === 'invalid' || err.reason === 'forbidden' ? 'rejected' : 'inconclusive',
          error: message,
        }
      }
      return { success: false, status: 'inconclusive', error: message }
    } finally {
      gateway.close()
    }
  }

  /** The ports of the account migrations: the old settings in, the records out. */
  private migrationPorts(): ModalCataloguePorts {
    const records = this.ctx.records
    if (records === undefined) throw new Error('records are not available')
    const handle = records.kind(trainingAccountEntryKind)
    return {
      readStored: async (): Promise<Readonly<Record<string, unknown>>> => {
        const stored = await this.resolveGlobalStore()
        // A secret that is still a marker was not resolved: abort before anything is written.
        if (isSecretMarker(stored['tokenSecret'])) {
          throw new Error('the old flat Modal token secret could not be resolved')
        }
        const list = stored['entries']
        if (Array.isArray(list)) {
          for (const row of list) {
            if (
              typeof row === 'object' &&
              row !== null &&
              isSecretMarker(Reflect.get(row, 'tokenSecret'))
            ) {
              throw new Error('an old Modal token secret could not be resolved')
            }
          }
        }
        return stored
      },
      readRawStored: async () => this.resolveGlobalStore(),
      warn: (message: string) => {
        this.ctx.logger.warn(message)
      },
      readRecord: async (id: string): Promise<ModalRecordState | null> => {
        const row = await handle.getResolved(id)
        if (row === null) return null
        return { tokenId: row.data.tokenId, hasSecret: (row.data.tokenSecret ?? '').length > 0 }
      },
      putRecord: async (id: string, body: TrainingAccountBody): Promise<'created' | 'exists'> => {
        if ((await handle.get(id)) !== null) return 'exists'
        try {
          await handle.put({ id, data: body }, { ifRev: 0 })
        } catch (err: unknown) {
          if (err instanceof RevConflictError) return 'exists'
          throw err
        }
        return 'created'
      },
      clearOldSecrets: async (ids: readonly string[]) => {
        // The clear instruction on a row's secret removes its keychain value and its marker.
        if (ids.includes(FLAT_ACCOUNT_ID)) await this.clearSecrets(['tokenSecret'])
        const rows = this.config.entries
        if (!rows.some((row) => ids.includes(row.id))) return
        await this.updateGlobalSettings({
          ...this.config,
          entries: rows.map((row) =>
            ids.includes(row.id) ? { ...row, tokenSecret: SECRET_CLEAR } : row,
          ),
        })
      },
    }
  }

  private ledger(): ModalJobLedger {
    const state = (): DurableState<Record<string, ModalJobRecord>> => {
      if (this.ledgerState === null) throw new Error('training-modal ledger not initialised')
      return this.ledgerState
    }
    return {
      get: async (jobKey) => (await state().get())[jobKey] ?? null,
      put: async (record) => {
        await state().update((prev) => ({ ...prev, [record.jobKey]: record }))
      },
      remove: async (jobKey) => {
        await state().update((prev) => {
          const { [jobKey]: _gone, ...rest } = prev
          return rest
        })
      },
      list: async () => Object.values(await state().get()),
    }
  }
}

/** @deprecated Use entry settings; kept for type imports in tests. */
export type { ModalSettings } from './modal-provider.js'
