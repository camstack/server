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
  type ICalendarSourceProvider,
  type InstanceChange,
  integrationInstancesCapability,
  type ProviderRegistration,
} from '@camstack/types'
import { z } from 'zod'
import { wasteCollectionsActions } from './custom-actions.js'
import { fetchWasteSource } from './fetch-source.js'
import {
  ADDON_MIGRATIONS,
  SOURCES_FROM_SETTINGS_ID,
  type WasteSourceKindDefinition,
  wasteSourcePortsOver,
} from './migrations/index.js'
import { resolveFetchScript } from './python-paths.js'
import { sealPlaintextCredentials } from './seal-plaintext.js'
import { createWasteCalendarSource } from './waste-calendar-source.js'
import { listCatalogCountries, listCatalogServices, serviceDisplayLabel } from './waste-catalog.js'
import { WASTE_SECRET_STATE_PATHS } from './waste-secrets.js'
import { WasteSourceInstances } from './waste-source-instances.js'
import { plainWasteSourceKind, wasteSourceEntryKind } from './waste-source-record-kinds.js'
import { WasteSourceStore } from './waste-source-store.js'
import {
  DEFAULT_WASTE_CONFIG,
  sourceArgs,
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
  /**
   * Legacy source ids the operator deleted while the migration was pending. The legacy setting is
   * never written (a raw write of the addon blob is gone with the addon-level API, D986); this
   * list keeps such a row from being copied into a record by the migration when it lands.
   */
  private readonly deletedLegacyIds = this.state(
    'deletedLegacySourceIds',
    z.array(z.string()),
    [] as string[],
  )

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
    await this.migrateLegacySources(plainBoot ? plainWasteSourceKind : wasteSourceEntryKind)
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
        listCountries: async () => listCatalogCountries(),
        listServices: async (input) =>
          listCatalogServices(input.countryId).map((s) => ({
            id: s.id,
            label: serviceDisplayLabel(s),
            title: s.label,
            module: s.module,
          })),
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
    if (change === 'deleted') await this.forgetLegacyRow(id)
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
  private async migrateLegacySources(kind: WasteSourceKindDefinition): Promise<void> {
    const skipIds = new Set(await this.deletedLegacyIds.get())
    const report = await this.runMigrations(ADDON_MIGRATIONS, (api) =>
      wasteSourcePortsOver(api, kind, skipIds),
    )
    if (report.failed.length > 0 || report.blocked.includes(SOURCES_FROM_SETTINGS_ID)) {
      this.ctx.logger.error(
        'waste-collections: the sources migration has not landed - the sources still in the legacy setting are unavailable until it does (the records are the only store)',
        { meta: { declared: report.declared, failed: report.failed, blocked: report.blocked } },
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
    // Records are the one store: an emptied store is empty, never a reason to read the legacy
    // settings back (they would resurrect what the operator deleted).
    return this.sourceStore === null ? [] : this.sourceStore.listResolved()
  }

  /**
   * A source deleted at the records is remembered as gone while a legacy row of that id may still
   * sit in the settings, or it would be copied back by the migration. The legacy setting itself is left as it is.
   */
  private async forgetLegacyRow(id: string): Promise<void> {
    const legacy = this.parseConfigSources(this.config.sources)
    if (!legacy.some((row) => row.id === id)) return
    await this.deletedLegacyIds.update((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }

  configuredSources(): readonly WasteSourceConfig[] {
    return this.activeSources
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
}

export default WasteCollectionsAddon

/** Re-parse helper for tests. */
export function parseWasteConfig(raw: unknown): WasteConfig {
  return WasteConfigSchema.parse(raw)
}

/** Type-only re-export so the entry module types stay discoverable. */
export type { ProviderRegistration }
