/**
 * `training-modal` — the Modal `training-provider` (D807).
 *
 * Inert until the operator enters a Modal token on an **entry** (the
 * `loki-logging` posture): the provider registers anyway so the Training page
 * can list types and create entries. Region, GPU, cost cap, maximum runtime and
 * the failed-job grace period are per-entry settings (operator decision
 * 2026-10-08: they depend on the user's account). The token secret is a
 * `password` field on each entry row, so BaseAddon keeps it in the keychain
 * (D787) — it is read from `this.config` and handed to the SDK client
 * constructor only.
 *
 * A pre-multi-entry flat config migrates to one entry named "Default" on boot.
 */
import {
  type AddonInitResult,
  BaseAddon,
  type DurableState,
  SECRET_CLEAR,
  trainingProviderCapability,
  type SecretFieldView,
} from '@camstack/types'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { entryTokenSecretView, flatTokenSecretView } from './entry-secret-view.js'
import {
  createModalEntry,
  deleteModalEntry,
  effectiveModalEntries,
  ensureModalEntryIds,
  findModalEntry,
  migrateLegacyModalConfig,
  updateModalEntry,
  type ModalEntriesConfig,
} from './modal-entries.js'
import {
  ModalTrainingProvider,
  type ModalJobLedger,
  type ModalJobRecord,
} from './modal-provider.js'
import { MODAL_DEFAULT_GPU } from './modal-pricing.js'
import { ModalSdkGateway } from './modal-sdk-gateway.js'
import { trainingAccountEntryKind } from './training-account-record-kinds.js'

export type TrainingModalConfig = ModalEntriesConfig

const LEDGER_KEY = 'modalJobs'

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

export class TrainingModalAddon extends BaseAddon<TrainingModalConfig> {
  private ledgerState: DurableState<Record<string, ModalJobRecord>> | null = null
  private readonly gateways = new Map<string, { key: string; gateway: ModalSdkGateway }>()

  /**
   * Entry secrets live on `entries[id].tokenSecret` (and legacy flat
   * `tokenSecret`). Declared here — not via an editable-array form — so the
   * Training → Providers page is the only UI that edits entries.
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
    await records.declare({ 'training-account': trainingAccountEntryKind })

    let next = this.config
    let migratedLegacy = false
    if (next.entries.length === 0) {
      const migrated = migrateLegacyModalConfig(next, () => randomUUID())
      migratedLegacy = migrated !== next
      next = migrated
    }
    next = ensureModalEntryIds(next, () => randomUUID())
    if (next !== this.config) await this.updateGlobalSettings(next)
    // Writing `tokenSecret: ''` KEEPS a keychain value (D787). After a legacy
    // migrate the flat secret must be cleared or delete of every entry
    // resurrects a synthetic `legacy-default`.
    if (migratedLegacy) await this.clearSecrets(['tokenSecret'])
    this.ledgerState = this.state<Record<string, ModalJobRecord>>(LEDGER_KEY, LedgerSchema, {})
    const peer = this.ctx.peerBytes
    if (peer === undefined) throw new Error('training-modal needs the peer-bytes facility')
    const provider = new ModalTrainingProvider({
      addonId: this.ctx.id,
      listEntries: () => effectiveModalEntries(this.config),
      entry: (entryId) => findModalEntry(this.config, entryId),
      gateway: (entryId) => this.gatewayFor(entryId),
      createEntry: async (input) => {
        const result = createModalEntry(this.config, input, () => randomUUID())
        if (!result.ok) throw new Error(`cannot create entry: ${result.reason}`)
        await this.updateGlobalSettings(result.config)
        return { entryId: result.entryId }
      },
      updateEntry: async (entryId, patch) => {
        const { clearTokenSecret, ...rest } = patch
        const result = updateModalEntry(this.config, entryId, rest)
        if (!result.ok) throw new Error(`cannot update entry: ${result.reason}`)
        if (clearTokenSecret === true) {
          await this.updateGlobalSettings({
            ...result.config,
            entries: result.config.entries.map((entry) =>
              entry.id === entryId ? { ...entry, tokenSecret: SECRET_CLEAR } : entry,
            ),
          })
        } else {
          await this.updateGlobalSettings(result.config)
        }
        this.closeGateway(entryId)
      },
      deleteEntry: async (entryId) => {
        const result = deleteModalEntry(this.config, entryId)
        if (!result.ok) throw new Error(`cannot delete entry: ${result.reason}`)
        await this.updateGlobalSettings(result.config)
        // Flat legacy `tokenSecret` survives `''` writes — clear it or the
        // synthetic Default entry comes back after the last real delete.
        await this.clearSecrets(['tokenSecret'])
        this.closeGateway(entryId)
      },
      secretViews: () => this.readEntrySecretViews(),
      ledger: this.ledger(),
      peer,
      fetchText,
      now: () => Date.now(),
      logger: this.ctx.logger,
    })
    this.ctx.logger.info('Modal training provider ready', {
      meta: {
        entries: effectiveModalEntries(this.config).length,
        configured: effectiveModalEntries(this.config).some((e) => {
          const secret = typeof e.tokenSecret === 'string' ? e.tokenSecret : ''
          return (e.tokenId ?? '').trim() !== '' && secret.trim() !== ''
        }),
      },
    })
    return { providers: [{ capability: trainingProviderCapability, provider }] }
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
    const entry = findModalEntry(this.config, entryId)
    if (entry === null) return null
    const tokenId = (entry.tokenId ?? '').trim()
    const tokenSecret = (typeof entry.tokenSecret === 'string' ? entry.tokenSecret : '').trim()
    if (tokenId === '' || tokenSecret === '') return null
    const environment = (entry.environment ?? '').trim()
    const key = `${tokenId}\u0000${environment}`
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

  /**
   * Keychain views for the Providers edit form. Addon-facing reads answer
   * VALUES (D798), so we cannot recover markers from `readStoredGlobalKey`.
   * When a secret is present on the resolved entry we emit the deterministic
   * keychain ref (`ctx.secrets.ref`) so `SecretFieldControl` can reveal.
   */
  private async readEntrySecretViews(): Promise<ReadonlyMap<string, SecretFieldView | null>> {
    const map = new Map<string, SecretFieldView | null>()
    const secrets = this.ctx.secrets
    for (const entry of effectiveModalEntries(this.config)) {
      map.set(entry.id, entryTokenSecretView(entry.tokenSecret, secrets, entry.id))
    }
    map.set('legacy-default', flatTokenSecretView(this.config.tokenSecret, secrets))
    return map
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

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'providers',
          title: 'Modal accounts',
          description:
            'Create and edit Modal workspace entries under Training → Providers. Credentials stay in the CamStack keychain.',
          fields: [],
        },
      ],
    })
  }
}

/** @deprecated Use entry settings; kept for type imports in tests. */
export type { ModalSettings } from './modal-provider.js'
