/**
 * Waste Collections — hub-only calendar-source over the vendored HACS
 * `waste_collection_schedule` Python core (full source catalog).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AddonInitResult,
  BaseAddon,
  calendarSourceCapability,
  defineAddonMigrations,
  type ICalendarSourceProvider,
  type InstanceChange,
  integrationInstancesCapability,
  type ProviderRegistration,
  type RawSecretMigrationReport,
} from '@camstack/types'
import { wasteCollectionsActions } from './custom-actions.js'
import { fetchWasteSource } from './fetch-source.js'
import { ADDON_MIGRATIONS, SOURCES_FROM_SETTINGS_ID } from './migrations/index.js'
import { resolveFetchScript } from './python-paths.js'
import { sealPlaintextCredentials } from './seal-plaintext.js'
import { allocateSourceId, SOURCE_ID_PATTERN } from './source-id.js'
import { createWasteCalendarSource } from './waste-calendar-source.js'
import {
  findCatalogService,
  listCatalogCountries,
  listCatalogServices,
  matchCatalogService,
  mergeServiceArgs,
  serviceDisplayLabel,
  serviceFormSchema,
} from './waste-catalog.js'
import {
  hasCredential,
  redactArgs,
  restoreRedactedArgs,
  WASTE_SECRET_STATE_PATHS,
} from './waste-secrets.js'
import { WasteSourceInstances } from './waste-source-instances.js'
import { plainWasteSourceKind, wasteSourceEntryKind } from './waste-source-record-kinds.js'
import { WasteSourceStore, withUnmigratedLegacyRows } from './waste-source-store.js'
import {
  DEFAULT_WASTE_CONFIG,
  sourceArgs,
  WasteArgValueSchema,
  type WasteCollectionEntry,
  type WasteConfig,
  WasteConfigSchema,
  type WasteSourceConfig,
  WasteSourceConfigSchema,
} from './waste-types.js'

export { wasteCollectionsActions as customActions } from './custom-actions.js'

const DAY_MS = 24 * 60 * 60 * 1000

interface CacheFile {
  readonly updatedAt: number
  readonly bySourceId: Readonly<Record<string, readonly WasteCollectionEntry[]>>
}

export class WasteCollectionsAddon extends BaseAddon<WasteConfig> {
  /** A source's credential arguments are keychain-backed (D880). */
  protected override readonly secretStatePaths = WASTE_SECRET_STATE_PATHS

  private pythonPath: string | null = null
  private scriptPath = ''
  private cache: Map<string, readonly WasteCollectionEntry[]> = new Map()
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private refreshInFlight: Promise<void> | null = null
  private sourceStore: WasteSourceStore | null = null
  private activeSources: readonly WasteSourceConfig[] = []
  /** The migration has not landed: the legacy setting is served, read-only, until it does. */
  private legacyServed = false

  constructor() {
    super({ ...DEFAULT_WASTE_CONFIG })
  }

  protected async onInitialize(): Promise<AddonInitResult<typeof wasteCollectionsActions>> {
    this.scriptPath = resolveFetchScript()
    this.loadCacheFromDisk()

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('waste-collections: ctx.records is required (hub-only addon)')
    }
    // The secret kind is declared only once no credential is left as plain text (it would hide
    // the text for good). If sealing failed, this boot runs on the plain declaration.
    const sealed = await sealPlaintextCredentials(records, this.ctx.secrets, this.ctx.logger)
    const plainBoot = sealed.state === 'failed'
    if (!plainBoot) await records.declare({ 'waste-source': wasteSourceEntryKind })
    const store = WasteSourceStore.of(
      records,
      plainBoot ? plainWasteSourceKind : wasteSourceEntryKind,
    )
    this.sourceStore = store
    await this.migrateLegacySources(store)
    this.activeSources = await this.loadPersistedSources()
    const instances = plainBoot
      ? null
      : new WasteSourceInstances(records, {
          onChanged: (id, change) => this.onInstanceChanged(id, change),
          fetchDeps: () =>
            this.pythonPath === null
              ? null
              : { pythonPath: this.pythonPath, scriptPath: this.scriptPath },
        })

    try {
      this.pythonPath = await this.ctx.deps.ensurePython()
    } catch (err) {
      this.ctx.logger.warn('waste-collections: embedded Python unavailable', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      this.pythonPath = null
    }

    if (this.pythonPath) {
      // Fire-and-forget initial refresh; calendars stay empty until it lands.
      void this.refreshAll('boot')
      this.refreshTimer = setInterval(() => {
        void this.refreshAll('timer')
      }, DAY_MS)
      this.ctx.addDisposer(async () => {
        if (this.refreshTimer !== null) {
          clearInterval(this.refreshTimer)
          this.refreshTimer = null
        }
      })
    } else {
      this.ctx.logger.warn(
        'waste-collections: registering calendar-source with empty cache (Python missing)',
      )
    }

    const provider: ICalendarSourceProvider = createWasteCalendarSource({
      logger: this.ctx.logger,
      listConfigured: () => this.configuredSources(),
      getEntries: (id) => this.cache.get(id) ?? [],
    })

    this.ctx.logger.info('Initialized — waste calendar-source', {
      meta: {
        sourceCount: this.configuredSources().length,
        cachedSources: this.cache.size,
        python: this.pythonPath !== null,
      },
    })

    return {
      providers: [
        { capability: calendarSourceCapability, provider },
        ...(instances === null
          ? []
          : [{ capability: integrationInstancesCapability, provider: instances.toProvider() }]),
      ],
      customActions: wasteCollectionsActions,
      actionHandlers: {
        fetchNow: async (input) => this.fetchNow(input),
        listSources: async () => this.listSources(),
        listCountries: async () => listCatalogCountries(),
        listServices: async (input) =>
          listCatalogServices(input.countryId).map((s) => ({
            id: s.id,
            label: serviceDisplayLabel(s),
            title: s.label,
            module: s.module,
          })),
        serviceFormSchema: async (input) => {
          const service = findCatalogService(input.serviceId)
          if (!service) throw new Error(`unknown service '${input.serviceId}'`)
          return serviceFormSchema(service)
        },
        createSource: async (input) => this.createSource(input),
        updateSource: async (input) => this.updateSource(input),
        deleteSource: async (input) => this.deleteSource(input),
        migrateSources: async (input) => this.migrateSources(input.apply),
      },
    }
  }

  protected override async onConfigChanged(): Promise<void> {
    await this.reloadSources('config-changed')
  }

  /** An instance was created, edited, switched or deleted: re-read the records and refresh. */
  private async onInstanceChanged(id: string, change: InstanceChange): Promise<void> {
    this.ctx.logger.info('waste source instance changed', {
      meta: { sourceId: id, change },
    })
    if (change === 'deleted') await this.pruneLegacyRows((legacyId) => legacyId !== id)
    await this.reloadSources(`instance-${change}`)
  }

  private async reloadSources(reason: string): Promise<void> {
    this.activeSources = await this.loadPersistedSources()
    // Drop cache rows for removed sources; refresh newly enabled ones.
    const ids = new Set(this.configuredSources().map((s) => s.id))
    for (const key of [...this.cache.keys()]) {
      if (!ids.has(key)) this.cache.delete(key)
    }
    this.persistCache()
    void this.refreshAll(reason)
  }

  /**
   * The sources a pre-record install kept in the settings become records (D987). A step that
   * fails leaves the settings where they are and is logged by id: the sources stay unavailable
   * until it lands, never half-copied.
   */
  private async migrateLegacySources(store: WasteSourceStore): Promise<void> {
    const report = await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, {
        readStored: (key) => this.readStoredGlobalKey(key),
        listSourceIds: () => store.listIds(),
        putSource: async (source) => {
          await store.putIfAbsent(source)
        },
        readSource: (id) => store.readResolved(id),
        warn: (message) => this.ctx.logger.warn(message),
      }),
    )
    this.legacyServed =
      !report.declared ||
      report.failed.includes(SOURCES_FROM_SETTINGS_ID) ||
      report.blocked.includes(SOURCES_FROM_SETTINGS_ID)
    if (this.legacyServed) {
      this.ctx.logger.warn(
        'waste-collections: the sources migration has not landed - the legacy sources not yet in records are served read-only beside the records until it does',
        { meta: { declared: report.declared, failed: report.failed, blocked: report.blocked } },
      )
    }
    if (report.failed.length > 0) {
      this.ctx.logger.error(
        'waste-collections: the sources migration failed - legacy rows without a record stay served from the legacy setting until it lands',
        { meta: { failed: report.failed } },
      )
    }
  }

  // ── Custom actions ────────────────────────────────────────────────

  /**
   * The stored sources, each parsed against the schema. A row that does not parse
   * is skipped AND logged: a source that silently vanishes reads as a calendar
   * that never existed.
   */
  private parseConfigSources(rawList: readonly unknown[]): WasteSourceConfig[] {
    const out: WasteSourceConfig[] = []
    for (const raw of rawList) {
      const parsed = WasteSourceConfigSchema.safeParse(raw)
      if (parsed.success) out.push(parsed.data)
      else {
        this.ctx.logger.warn('waste-collections: a stored source does not parse - skipped', {
          meta: {
            sourceId:
              typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
                ? raw.id
                : null,
          },
        })
      }
    }
    return out
  }

  private async loadPersistedSources(): Promise<readonly WasteSourceConfig[]> {
    // Records are the truth once the store exists: an emptied store is empty, never a reason to
    // read the legacy settings back (they would resurrect what the operator deleted).
    const store = this.sourceStore
    if (store === null) return this.parseConfigSources(this.config.sources)
    const records = await store.listResolved()
    if (!this.legacyServed) return records
    // The migration has not landed: a legacy row with no record yet is still served, read-only.
    // Writes go to the records as ever; a row leaves this view as soon as a record has its id.
    return withUnmigratedLegacyRows(records, this.parseConfigSources(this.config.sources))
  }

  private async persistSources(sources: readonly WasteSourceConfig[]): Promise<void> {
    this.activeSources = [...sources]
    const store = this.sourceStore
    if (store !== null) {
      await store.replaceAll(sources)
      const kept = new Set(sources.map((s) => s.id))
      await this.pruneLegacyRows((legacyId) => kept.has(legacyId))
      return
    }
    await this.updateGlobalSettings({ sources: [...sources] })
  }

  /**
   * A source deleted at the records leaves the legacy setting too, or it would reappear beside the
   * records (while the migration is pending) or be copied back by it.
   */
  private async pruneLegacyRows(keep: (id: string) => boolean): Promise<void> {
    const legacy = this.parseConfigSources(this.config.sources)
    const remaining = legacy.filter((row) => keep(row.id))
    if (remaining.length === legacy.length) return
    await this.updateGlobalSettings({ sources: remaining })
  }

  configuredSources(): readonly WasteSourceConfig[] {
    if (this.activeSources.length > 0 || this.sourceStore !== null) return this.activeSources
    return this.parseConfigSources(this.config.sources)
  }

  listSources(): readonly {
    id: string
    label: string
    module: string
    enabled: boolean
    formValues: Record<string, unknown>
    serviceId?: string
    countryId?: string
  }[] {
    return this.configuredSources().map((s) => {
      let args: Record<string, unknown> = {}
      try {
        args = sourceArgs(s)
      } catch {
        // A locked credential must not hide the source: show it, redacted.
        args = { ...s.args }
      }
      const matched = matchCatalogService(s.module, args)
      const formValues: Record<string, unknown> = {
        label: s.label,
        enabled: s.enabled,
        ...redactArgs(args),
      }
      // Prefer operator-facing fields; drop defaults already fixed on the service.
      if (matched) {
        for (const key of Object.keys(matched.defaultArgs)) {
          delete formValues[key]
        }
      }
      return {
        id: s.id,
        label: s.label,
        module: s.module,
        enabled: s.enabled,
        formValues,
        serviceId: matched?.id,
        countryId: matched?.countryId,
      }
    })
  }

  async createSource(input: {
    id?: string
    label: string
    serviceId: string
    args: Record<string, unknown>
    enabled?: boolean
  }): Promise<{ id: string }> {
    const existing = this.configuredSources().map((s) => s.id)
    let id: string
    if (input.id !== undefined) {
      if (!SOURCE_ID_PATTERN.test(input.id)) {
        throw new Error('id must be a lowercase slug (e.g. ics-home, junker)')
      }
      if (existing.includes(input.id)) {
        throw new Error(`source '${input.id}' already exists`)
      }
      id = input.id
    } else {
      id = allocateSourceId(input.label, existing)
    }
    const service = findCatalogService(input.serviceId)
    if (!service) throw new Error(`unknown service '${input.serviceId}'`)
    const row = WasteSourceConfigSchema.parse({
      id,
      label: input.label,
      module: service.module,
      args: this.typedArgs(mergeServiceArgs(service, restoreRedactedArgs(input.args, {}))),
      enabled: input.enabled ?? true,
    })
    await this.persistSources([...this.configuredSources(), row])
    return { id }
  }

  async updateSource(input: {
    id: string
    label: string
    serviceId?: string
    args?: Record<string, unknown>
    enabled?: boolean
  }): Promise<{ ok: true }> {
    const sources = this.configuredSources()
    const idx = sources.findIndex((s) => s.id === input.id)
    if (idx < 0) throw new Error(`source '${input.id}' not found`)
    const prev = sources[idx]!
    let prevArgs: Record<string, unknown> = {}
    try {
      prevArgs = sourceArgs(prev)
    } catch {
      prevArgs = { ...prev.args }
    }

    let module = prev.module
    let args: Record<string, unknown> = prevArgs
    if (input.serviceId !== undefined) {
      const service = findCatalogService(input.serviceId)
      if (!service) throw new Error(`unknown service '${input.serviceId}'`)
      module = service.module
      args = mergeServiceArgs(service, restoreRedactedArgs(input.args ?? {}, prevArgs))
    } else if (input.args !== undefined) {
      const sent = restoreRedactedArgs(input.args, prevArgs)
      const matched = matchCatalogService(prev.module, prevArgs)
      args = matched ? mergeServiceArgs(matched, sent) : { ...prevArgs, ...sent }
    }

    // No `argsJson`: the rewritten row is the typed shape, which also retires a legacy one.
    const next = WasteSourceConfigSchema.parse({
      id: prev.id,
      label: input.label,
      module,
      args: this.typedArgs(args),
      enabled: input.enabled ?? prev.enabled,
    })
    await this.persistSources(sources.map((s, i) => (i === idx ? next : s)))
    return { ok: true }
  }

  /** Validate an argument bag against the typed value schema (a nested object is refused). */
  private typedArgs(
    args: Record<string, unknown>,
  ): Record<string, WasteSourceConfig['args'][string]> {
    const out: Record<string, WasteSourceConfig['args'][string]> = {}
    for (const [key, value] of Object.entries(args)) out[key] = WasteArgValueSchema.parse(value)
    return out
  }

  /**
   * D880: rewrite every legacy source (free `argsJson`) as typed `args`; its
   * credentials go to the keychain through the normal save path. Then every
   * credential is read back and compared with what the legacy row held; on any
   * difference the legacy rows are written back, so nothing is lost. Dry run
   * unless `apply`. Idempotent. Counts only - never an argument, a ref or an id.
   */
  async migrateSources(apply: boolean): Promise<RawSecretMigrationReport> {
    const sources = this.configuredSources()
    const legacy = sources.filter((s) => s.argsJson !== undefined)
    const rawRows = legacy.filter((s) => {
      try {
        return hasCredential(sourceArgs(s))
      } catch {
        return false
      }
    })
    const markerRows = sources.filter(
      (s) => s.argsJson === undefined && hasCredential(s.args),
    ).length
    const report = (over: Partial<RawSecretMigrationReport>): RawSecretMigrationReport => ({
      apply,
      rows: sources.length,
      raw: rawRows.length,
      markers: markerRows,
      migrated: 0,
      failed: 0,
      remainingRaw: rawRows.length,
      unresolvedMarkers: this.unresolvedSecrets.length,
      redundantCopies: legacy.length,
      verified: rawRows.length === 0 && this.unresolvedSecrets.length === 0,
      ...over,
    })
    if (!apply || legacy.length === 0) return report({})

    // Per row: a row that cannot be converted (malformed JSON, a nested value) stays
    // exactly as it is and is counted failed - it never stops the others.
    const expected = new Map<string, Record<string, unknown>>()
    const unconverted = new Set<string>()
    const migrated = sources.map((s): WasteSourceConfig => {
      if (s.argsJson === undefined) return s
      try {
        const args = sourceArgs(s)
        const row = WasteSourceConfigSchema.parse({
          id: s.id,
          label: s.label,
          module: s.module,
          args: this.typedArgs(args),
          enabled: s.enabled,
        })
        expected.set(s.id, args)
        return row
      } catch {
        // Not the error: its text could quote the row.
        unconverted.add(s.id)
        return s
      }
    })
    const failedRows = unconverted.size
    if (expected.size === 0) {
      return report({ failed: failedRows, remainingRaw: legacy.length })
    }
    try {
      await this.persistSources(migrated)
    } catch {
      return report({ failed: legacy.length })
    }
    const back = new Map(this.configuredSources().map((s) => [s.id, s]))
    const intact = [...expected].every(([id, args]) => {
      const row = back.get(id)
      return (
        row !== undefined &&
        row.argsJson === undefined &&
        JSON.stringify(sortedEntries(row.args)) === JSON.stringify(sortedEntries(args))
      )
    })
    if (!intact || this.unresolvedSecrets.length > 0) {
      await this.rollbackMigration(sources, expected)
      return report({ failed: legacy.length })
    }
    return report({
      migrated: expected.size,
      failed: failedRows,
      remainingRaw: failedRows,
      unresolvedMarkers: 0,
      redundantCopies: legacy.length,
      verified: failedRows === 0,
    })
  }

  /**
   * Put the legacy rows back. A converted row's `args` is written as `null`, which
   * the save path reads as "this object is gone": it deletes the keychain refs the
   * migration created (a plain `{}` would keep them). Never throws - the report
   * says failed either way, and the legacy JSON stays authoritative.
   */
  private async rollbackMigration(
    sources: readonly WasteSourceConfig[],
    converted: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    try {
      await this.updateGlobalSettingsAsOperator({
        sources: sources.map((s) => (converted.has(s.id) ? { ...s, args: null } : s)),
      })
    } catch {
      this.ctx.logger.error(
        'waste-collections: the migration rollback failed - keychain refs may be orphaned (System -> Secrets)',
      )
    }
  }

  async deleteSource(input: { id: string }): Promise<{ ok: true }> {
    const sources = this.configuredSources()
    if (!sources.some((s) => s.id === input.id)) {
      throw new Error(`source '${input.id}' not found`)
    }
    await this.persistSources(sources.filter((s) => s.id !== input.id))
    return { ok: true }
  }

  async fetchNow(input?: { sourceId?: string }): Promise<{
    ok: true
    refreshed: {
      sourceId: string
      entryCount: number
      error?: string
    }[]
  }> {
    const targets = this.configuredSources().filter((s) => {
      if (!s.enabled) return false
      if (input?.sourceId !== undefined) return s.id === input.sourceId
      return true
    })
    const refreshed: {
      sourceId: string
      entryCount: number
      error?: string
    }[] = []
    for (const s of targets) {
      try {
        const entries = await this.fetchOne(s)
        this.cache.set(s.id, entries)
        refreshed.push({ sourceId: s.id, entryCount: entries.length })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.ctx.logger.warn('waste fetchNow failed', {
          meta: { sourceId: s.id, module: s.module, error },
        })
        refreshed.push({ sourceId: s.id, entryCount: 0, error })
      }
    }
    this.persistCache()
    return { ok: true, refreshed }
  }

  // ── Refresh ───────────────────────────────────────────────────────

  private async refreshAll(reason: string): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.runRefresh(reason).finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private async runRefresh(reason: string): Promise<void> {
    const enabled = this.configuredSources().filter((s) => s.enabled)
    this.ctx.logger.info('waste refresh start', {
      meta: { reason, count: enabled.length },
    })
    for (const s of enabled) {
      try {
        const entries = await this.fetchOne(s)
        this.cache.set(s.id, entries)
        this.ctx.logger.info('waste source refreshed', {
          meta: {
            sourceId: s.id,
            module: s.module,
            entryCount: entries.length,
          },
        })
      } catch (err) {
        this.ctx.logger.warn('waste source refresh failed — keeping prior cache', {
          meta: {
            sourceId: s.id,
            module: s.module,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    this.persistCache()
  }

  private async fetchOne(s: WasteSourceConfig): Promise<readonly WasteCollectionEntry[]> {
    if (!this.pythonPath) {
      throw new Error('embedded Python is not available')
    }
    return fetchWasteSource(
      { pythonPath: this.pythonPath, scriptPath: this.scriptPath },
      { source: s.module, args: sourceArgs(s) },
    )
  }

  // ── Cache persistence ─────────────────────────────────────────────

  private cachePath(): string {
    return join(this.ctx.dataDir, 'waste-cache.json')
  }

  private loadCacheFromDisk(): void {
    const path = this.cachePath()
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as CacheFile
      this.cache = new Map(Object.entries(raw.bySourceId ?? {}))
    } catch (err) {
      this.ctx.logger.warn('waste-collections: cache load failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private persistCache(): void {
    try {
      mkdirSync(this.ctx.dataDir, { recursive: true })
      const bySourceId: Record<string, readonly WasteCollectionEntry[]> = {}
      for (const [id, entries] of this.cache) bySourceId[id] = entries
      const body: CacheFile = { updatedAt: Date.now(), bySourceId }
      writeFileSync(this.cachePath(), `${JSON.stringify(body)}\n`, 'utf8')
    } catch (err) {
      this.ctx.logger.warn('waste-collections: cache persist failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  // ── Settings ──────────────────────────────────────────────────────

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'refresh',
          title: 'Refresh',
          description:
            'Sources are managed in the table above (Add / Edit): pick a country and a service, then fill only that service’s fields. Each source becomes one calendar under System → Calendars.',
          columns: 2,
          fields: [
            {
              type: 'addon-action-button',
              key: '_fetchNow',
              label: 'Refresh',
              buttonLabel: 'Fetch now',
              description:
                'Sources refresh once at boot and then every 24 hours; this refreshes every enabled source immediately.',
              addonId: 'waste-collections',
              action: 'fetchNow',
              variant: 'primary',
              paramsStatic: {},
            },
          ],
        },
      ],
    })
  }
}

export default WasteCollectionsAddon

/** Re-parse helper for tests. */
export function parseWasteConfig(raw: unknown): WasteConfig {
  return WasteConfigSchema.parse(raw)
}

/** Type-only re-export so the entry module types stay discoverable. */
export type { ProviderRegistration }

function sortedEntries(args: Readonly<Record<string, unknown>>): [string, unknown][] {
  return Object.entries(args).toSorted(([a], [b]) => (a < b ? -1 : 1))
}
