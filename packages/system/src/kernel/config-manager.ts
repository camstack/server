import type { AddonStoreRead, FeatureManifest, ISettingsStoreProvider } from '@camstack/types'
import { asJsonObject } from '@camstack/types/addon'
import { type AppConfig, type BootstrapConfig, RUNTIME_DEFAULTS } from './config-schema.js'
import type {
  ISettingsStore,
  KernelAddonSettingsView,
  SettingsViewBackend,
} from './settings-view-types.js'

export type {
  AddonSettingsView,
  ISettingsStore,
  KernelAddonSettingsView,
  SettingsViewBackend,
} from './settings-view-types.js'

import {
  buildRawAppConfig,
  loadBootstrapConfig,
  writeBootstrapSection,
} from './bootstrap-config.js'
import { createDoorSettingsView, loadSystemSettingsPrefix } from './settings-door-view.js'
import { SettingsReadUnavailableError } from './settings-read-error.js'
import { createStoreSettingsView } from './store-settings-view.js'
import { SystemSettingsMirror, type SystemSettingsPreload } from './system-settings-mirror.js'
import {
  filterStoreSection,
  isPreloadedSystemKey,
  PRELOADED_SYSTEM_KEYS,
  PRELOADED_SYSTEM_PREFIXES,
  storeMayAnswer,
} from './system-settings-policy.js'

export type { SystemSettingsPreload } from './system-settings-mirror.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Which backend a `ConfigManager` read can reach right now. */
type SettingsBackendMode = 'store' | 'door' | 'unwired'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ConfigManager {
  // NOTE: the `console.*` calls in `bootstrap-config.ts` (`loadYaml` /
  // `applyEnvOverrides`) are deliberate, documented
  // residuals. `ConfigManager` is a pure bootstrap component constructed at
  // the very start of hub boot (NestJS DI, before `LogManager` and the
  // Moleculer broker exist), so there is no `IScopedLogger` or `$hub.log`
  // transport to route through. Wiring one in would mean threading a logger
  // through `server/backend` construction — out of scope for the D8
  // log-forwarding work, which only affects `packages/kernel/src`.

  // Non-readonly so update() can sync the in-memory view after a write.
  private bootstrapConfig: BootstrapConfig
  private settingsStore: ISettingsStore | null = null
  private settingsDoor: ISettingsStoreProvider | null = null
  /** Boot-time mirror of the preloaded `system-settings` keys (door mode, D675). */
  private readonly systemMirror = new SystemSettingsMirror()

  constructor(private readonly configPath: string) {
    this.bootstrapConfig = loadBootstrapConfig(configPath)
  }

  /**
   * Wire the settings-store backend. Called once, after the `settings-store`
   * capability provider has registered (normally during Phase-1 infra boot).
   * Before this call, runtime reads/writes fall back to bootstrap + defaults.
   */
  setSettingsStore(store: ISettingsStore): void {
    this.settingsStore = store
  }

  /**
   * Wire the async `settings-store` door. Used when the engine is isolated
   * (no sync `ISettingsStore` handle on hub-main). {@link createSettingsView}
   * prefers the sync store when both are present.
   */
  setSettingsDoor(door: ISettingsStoreProvider): void {
    this.settingsDoor = door
    this.systemMirror.load(door)
  }

  /**
   * Resolves once the boot read of the preloaded `system-settings` keys has
   * settled — the hook the addon registry uses to log it and to replay the
   * capability preferences onto providers that registered before it (D675).
   * `null` when no door has been wired (a sync store needs no preload).
   */
  whenSystemSettingsPreloaded(): Promise<SystemSettingsPreload> | null {
    return this.systemMirror.whenLoaded()
  }

  private backendMode(): SettingsBackendMode {
    if (this.settingsStore !== null) return 'store'
    if (this.settingsDoor !== null) return 'door'
    return 'unwired'
  }

  /** The refusal every sync addon-scoped reader raises without a sync store. */
  private refuseSyncRead(reader: string, subject: string): SettingsReadUnavailableError {
    const mode = this.backendMode()
    return mode === 'door'
      ? new SettingsReadUnavailableError(
          `ConfigManager.${reader}`,
          'door-only',
          `${subject}: the settings engine is isolated and has no synchronous handle — read it through the settings view (createSettingsView / readAddonStoreResult)`,
        )
      : new SettingsReadUnavailableError(
          `ConfigManager.${reader}`,
          'not-wired',
          `${subject}: no settings backend is wired yet`,
        )
  }

  /**
   * Get a config value by dot-notation path.
   * Priority: bootstrap config (yaml + env) → settings-store → RUNTIME_DEFAULTS.
   *
   * The store layer (D675) never answers a bootstrap-owned key outside the
   * allow-list (`storeMayAnswer`). With only the door (production) it answers
   * the PRELOADED keys from the boot mirror and REFUSES the rest
   * ({@link SettingsReadUnavailableError}) — it used to skip the store in
   * silence. Before any backend is wired it is absent (boot-time readers).
   *
   * Returns `unknown` — callers must narrow via `typeof`/type guards, OR use
   * the generic overload at their own risk. The generic overload exists only
   * as a convenience alias for legacy call sites; it performs NO runtime
   * check and is the one documented type-level bridge in this function.
   */
  get(configPath: string): unknown
  get<T>(configPath: string): T | undefined
  get<T>(configPath: string): T | undefined {
    const resolved = this.resolveConfigValue(configPath)
    // Single generic type-level bridge — see @camstack/types RuntimeDefaultsShape
    // for the canonical typed alternative to `get<T>`.
    return resolved as T | undefined
  }

  private resolveConfigValue(configPath: string): unknown {
    // First: check bootstrap config (server, auth)
    const bootstrapValue = this.getFromBootstrap(configPath)
    if (bootstrapValue !== undefined) return bootstrapValue

    // Second: the settings-store layer (see the method doc for the modes).
    const storeValue = this.readStoreLayer(configPath)
    if (storeValue !== undefined) return storeValue

    // Third: check runtime defaults (backward compat when store not yet wired)
    if (configPath in RUNTIME_DEFAULTS) {
      return RUNTIME_DEFAULTS[configPath]
    }

    // Fourth: try nested lookup in runtime defaults
    return this.getFromRuntimeDefaults(configPath) ?? undefined
  }

  /**
   * The settings-store layer of {@link get}: the stored value, `undefined`
   * when the store holds nothing (or may not answer this key), or a THROW
   * when the store cannot be asked.
   */
  private readStoreLayer(configPath: string): unknown {
    if (!storeMayAnswer(configPath)) return undefined
    switch (this.backendMode()) {
      case 'store': {
        const store = this.settingsStore
        if (store === null) return undefined
        const storeValue = store.getSystem(configPath)
        if (storeValue !== undefined) return storeValue
        // Also try prefix-based nested lookup against store keys
        return this.getNestedFromSystemSettings(configPath) ?? undefined
      }
      case 'door':
        if (isPreloadedSystemKey(configPath)) return this.systemMirror.get(configPath)
        throw new SettingsReadUnavailableError(
          'ConfigManager.get',
          'door-only',
          `"${configPath}" may be stored, and the isolated engine cannot be read synchronously — only ${[...PRELOADED_SYSTEM_PREFIXES, ...PRELOADED_SYSTEM_KEYS].join(', ')} are mirrored at boot`,
        )
      case 'unwired':
        return undefined
    }
  }

  /**
   * Write a value to the settings-store. Resolves only once the write LANDED:
   * on the isolated engine it awaits the door, and a failed write REJECTS and
   * is not reported back by the mirror (D675 — it used to be fire-and-forget,
   * so a lost write read as saved for the life of the process). Rejects when
   * no store is wired.
   */
  async set(key: string, value: unknown): Promise<void> {
    if (this.settingsStore !== null) {
      this.settingsStore.setSystem(key, value)
      return
    }
    const door = this.settingsDoor
    if (door === null) {
      throw new SettingsReadUnavailableError(
        'ConfigManager.set',
        'not-wired',
        `"${key}" cannot be written: no settings backend is wired yet`,
      )
    }
    await door.set({ collection: 'system-settings', key, value })
    this.systemMirror.noteWrite(key, value)
  }

  /**
   * Bulk-read all keys that belong to a logical section.
   * A "section" is the first segment of a dot-notation key (e.g. 'features', 'logging').
   *
   * Sources are merged in priority order (lowest → highest):
   *   1. RUNTIME_DEFAULTS — kernel constants.
   *   2. Bootstrap config  — values loaded from config.yaml at boot.
   *   3. Settings-store    — runtime writes via the `settings-store` capability.
   *
   * Higher layers override earlier ones. Merging (instead of short-circuiting
   * on the first non-null source) prevents a single store-seeded key from
   * shadowing the rest of the section that only lives in config.yaml.
   * The kernel is agnostic about the store backend — any `ISettingsStore`
   * implementation (sqlite, redis, in-memory, …) behaves identically here.
   *
   * D675: a bootstrap-owned section takes ONLY allow-listed keys from the
   * store (a stale stored `auth.jwtSecret` never answers), and with only the
   * door wired this sync read THROWS — the settings view's `getSection` reads
   * the door.
   */
  getSection(section: string): Record<string, unknown> {
    const mode = this.backendMode()
    if (mode === 'door') {
      throw new SettingsReadUnavailableError(
        'ConfigManager.getSection',
        'door-only',
        `section "${section}": the settings engine is isolated — read it through the settings view (ctx.settings.getSection)`,
      )
    }
    const merged = this.sectionBase(section)
    // Settings-store (highest priority — explicit user writes persisted via the cap)
    if (mode === 'store') {
      const nested = this.getNestedFromSystemSettings(section)
      if (nested) Object.assign(merged, filterStoreSection(section, nested))
    }
    return merged
  }

  /** Runtime defaults, then config.yaml + env — the layers under the store. */
  private sectionBase(section: string): Record<string, unknown> {
    const merged: Record<string, unknown> = {}
    // 1. Runtime defaults (kernel constants)
    const defaults = asJsonObject(this.getFromRuntimeDefaults(section))
    if (defaults) Object.assign(merged, defaults)
    // 2. Bootstrap config (YAML + env)
    const bootstrapRecord: Record<string, unknown> = { ...this.bootstrapConfig }
    const bootstrapSection = asJsonObject(bootstrapRecord[section])
    if (bootstrapSection) Object.assign(merged, bootstrapSection)
    return merged
  }

  /**
   * {@link getSection} through the async door — what the door-backed settings
   * view answers (D675). Same layers, same allow-list; a failed door read
   * THROWS rather than handing back the defaults as if nothing were stored.
   */
  private async readSectionThroughDoor(
    door: ISettingsStoreProvider,
    section: string,
  ): Promise<Record<string, unknown>> {
    const merged = this.sectionBase(section)
    const stored = await loadSystemSettingsPrefix(door, `${section}.`, (key) =>
      storeMayAnswer(`${section}.${key}`),
    )
    Object.assign(merged, filterStoreSection(section, stored))
    return merged
  }

  /**
   * Bulk-write a logical section to the settings-store.
   * Each entry in `data` is persisted under the key `section.<entryKey>`.
   */
  setSection(section: string, data: Record<string, unknown>): void {
    if (this.settingsStore === null) {
      throw new Error(
        '[ConfigManager] SettingsStore not initialized -- call setSettingsStore() first',
      )
    }
    for (const [key, value] of Object.entries(data)) {
      this.settingsStore.setSystem(`${section}.${key}`, value)
    }
  }

  // ---------------------------------------------------------------------------
  // Addon / Provider / Device scoped config
  // ---------------------------------------------------------------------------

  /**
   * Read all config for an addon — SYNC store only. THROWS without one: its
   * old bootstrap fallback answered `{}` for every addon on every
   * isolated-engine hub (D675). Async three-way: {@link readAddonGlobalStrict}.
   */
  getAddonConfig(addonId: string): Record<string, unknown> {
    if (this.settingsStore !== null) {
      return this.settingsStore.getAllAddon(addonId)
    }
    throw this.refuseSyncRead('getAddonConfig', `addon "${addonId}"`)
  }

  /**
   * One addon's global store, three-way (D675): the record, `{}` when the
   * store ANSWERED with nothing, or a THROW when it could not be asked.
   * Behind `addonSettingsRaw.getGlobal` and `$hub.getAddonConfig`.
   */
  async readAddonGlobalStrict(addonId: string): Promise<Record<string, unknown>> {
    const read = await this.createSettingsView(addonId).readAddonStoreResult()
    switch (read.kind) {
      case 'value':
        return read.value
      case 'missing':
        return {}
      case 'failed':
        throw new SettingsReadUnavailableError(
          'ConfigManager.readAddonGlobalStrict',
          this.backendMode() === 'unwired' ? 'not-wired' : 'read-failed',
          `addon "${addonId}": ${read.error}`,
        )
    }
  }

  /** One addon's per-device overrides, three-way like {@link readAddonGlobalStrict}. */
  async readAddonDeviceStrict(addonId: string, deviceId: number): Promise<Record<string, unknown>> {
    const door = this.settingsDoor
    switch (this.backendMode()) {
      case 'store':
        break
      case 'door':
        if (door === null) break
        try {
          return await this.createDoorBackedSettingsView(addonId, door).readDeviceStore(deviceId)
        } catch (err: unknown) {
          throw new SettingsReadUnavailableError(
            'ConfigManager.readAddonDeviceStrict',
            'read-failed',
            `addon "${addonId}" device ${deviceId}: ${errorText(err)}`,
          )
        }
      case 'unwired':
        break
    }
    throw this.refuseSyncRead('readAddonDeviceStrict', `addon "${addonId}" device ${deviceId}`)
  }

  /** Write (bulk-replace) config for an addon to addon_settings. */
  setAddonConfig(addonId: string, config: Record<string, unknown>): void {
    if (this.settingsStore === null) {
      throw new Error(
        '[ConfigManager] SettingsStore not initialized -- call setSettingsStore() first',
      )
    }
    this.settingsStore.setAllAddon(addonId, config)
  }

  /**
   * The device's persisted runtime-state blob. THROWS before the store is
   * wired: a store not asked is not an empty row (D677, D675).
   */
  getDeviceRuntimeState(deviceId: string): Record<string, unknown> {
    if (this.settingsStore === null) {
      throw this.refuseSyncRead('getDeviceRuntimeState', `runtime state of device ${deviceId}`)
    }
    return this.settingsStore.getDeviceRuntimeState(deviceId)
  }

  /**
   * Replace the device's persisted runtime-state blob.
   *
   * THROWS when the store is not wired, and that is deliberate: the caller
   * (`DeviceStateMirror.scheduleRuntimeStateDiskWrite`) catches and logs, so a
   * persist that cannot happen leaves a line naming the device. A silent no-op
   * here is the shape that let a whole collection read zero for months.
   */
  setDeviceRuntimeState(deviceId: string, blob: Record<string, unknown>): void {
    if (this.settingsStore === null) {
      throw new Error(
        '[ConfigManager] SettingsStore not initialized -- call setSettingsStore() first',
      )
    }
    this.settingsStore.setDeviceRuntimeState(deviceId, blob)
  }

  /** Forget the device's runtime state. No-op before the store is wired. */
  clearDeviceRuntimeState(deviceId: string): void {
    if (this.settingsStore === null) return
    this.settingsStore.clearDeviceRuntimeState(deviceId)
  }

  /**
   * The addon's `ctx.settings`.
   *
   * The backend is chosen on EVERY call, never frozen when the view is built.
   * That is not a nicety: `settings-store` is owned by `storage-orchestrator`,
   * so the door is wired by `registerProvider` STRICTLY AFTER that addon's
   * context — and therefore its settings view — already exists. A view bound at
   * construction handed the door's own owner the sync-store backend, whose
   * writes throw for the whole life of the process once `sqlite-settings` runs
   * isolated (D181: no sync `ISettingsStore` reaches hub-main, only the async
   * door). Reads were worse than the writes: they answered `{}` in silence.
   * That is what made `storageMigration.start` fail on its first durable write
   * while every other addon's persistence worked. See D294.
   */
  createSettingsView(addonId: string): KernelAddonSettingsView {
    const storeBacked = this.createStoreSettingsView(addonId)
    let doorBacked: SettingsViewBackend | null = null
    let doorBackedSource: ISettingsStoreProvider | null = null
    const active = (): SettingsViewBackend => {
      // A sync handle is always preferred — `createDoorSettingsView` documents
      // the same order — but it may arrive after this view was built, and so
      // may the door.
      if (this.settingsStore !== null) return storeBacked
      const door = this.settingsDoor
      if (door === null) return storeBacked
      if (doorBacked === null || doorBackedSource !== door) {
        doorBackedSource = door
        doorBacked = this.createDoorBackedSettingsView(addonId, door)
      }
      return doorBacked
    }
    return {
      readAddonStore: () => active().readAddonStore(),
      // D651: three-way. With NO backend wired yet (the D294 window, before
      // `setSettingsStore`/`setSettingsDoor`), `active()` is the sync-store view
      // and `getAddonConfig` falls back to the bootstrap file, which holds no
      // addon key — a `{}` that is not "never written" but "not asked". That
      // window answers `failed`. Once a backend is wired, the sync store and
      // the door's range query both THROW on a failed read, so a try is a true
      // three-way read, and an empty result is "never written".
      readAddonStoreResult: async (): Promise<AddonStoreRead> => {
        if (this.settingsStore === null && this.settingsDoor === null) {
          return { kind: 'failed', error: 'settings store not wired' }
        }
        try {
          const value = await active().readAddonStore()
          return Object.keys(value).length > 0 ? { kind: 'value', value } : { kind: 'missing' }
        } catch (err: unknown) {
          return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
        }
      },
      readAddonStoreKeyResult: (key) => active().readAddonStoreKeyResult(key),
      writeAddonStore: (patch) => active().writeAddonStore(patch),
      readDeviceStore: (deviceId) => active().readDeviceStore(deviceId),
      readDeviceStoreBatch: (deviceIds) => active().readDeviceStoreBatch(deviceIds),
      listDeviceStoreIds: () => active().listDeviceStoreIds(),
      writeDeviceStore: (deviceId, patch) => active().writeDeviceStore(deviceId, patch),
      clearDeviceStore: (deviceId) => active().clearDeviceStore(deviceId),
      getSection: (section) => active().getSection(section),
      setSection: (section, patch) => active().setSection(section, patch),
      readDeviceRuntimeState: (deviceId) => active().readDeviceRuntimeState(deviceId),
      writeDeviceRuntimeState: (deviceId, data) => active().writeDeviceRuntimeState(deviceId, data),
      clearDeviceRuntimeState: (deviceId) => active().clearDeviceRuntimeState(deviceId),
    }
  }

  /** The async-door backend of {@link createSettingsView}. */
  private createDoorBackedSettingsView(
    addonId: string,
    door: ISettingsStoreProvider,
  ): SettingsViewBackend {
    return createDoorSettingsView(addonId, door, {
      getSection: (section) => this.readSectionThroughDoor(door, section),
      setSection: async (section, patch) => {
        for (const [key, value] of Object.entries(patch)) {
          const fullKey = `${section}.${key}`
          await door.set({ collection: 'system-settings', key: fullKey, value })
          this.systemMirror.noteWrite(fullKey, value)
        }
      },
    })
  }

  /** The sync-`ISettingsStore` backend of {@link createSettingsView}. */
  private createStoreSettingsView(addonId: string): SettingsViewBackend {
    return createStoreSettingsView(addonId, this)
  }

  /** Is a SYNC `ISettingsStore` wired? (The store-backed view's D294-window test.) */
  hasSyncStore(): boolean {
    return this.settingsStore !== null
  }

  // ---------------------------------------------------------------------------
  // Bootstrap accessors
  // ---------------------------------------------------------------------------

  /** Get a value from the parsed bootstrap config.
   *  Generic overload is a documented type-level bridge — callers are responsible
   *  for passing a T that matches the config.yaml shape. */
  getBootstrap(configPath: string): unknown
  getBootstrap<T>(configPath: string): T | undefined
  getBootstrap<T>(configPath: string): T | undefined {
    return this.getFromBootstrap(configPath) as T | undefined
  }

  /**
   * Features — the sync store when wired, else RUNTIME_DEFAULTS DELIBERATELY
   * (not `get()`, which refuses in door mode, D675): nothing writes
   * `features.*` beyond sqlite-settings' first-boot seed of these defaults.
   */
  get features(): FeatureManifest {
    const g = (key: keyof FeatureManifest): boolean => {
      const storeValue = this.settingsStore !== null ? this.get(`features.${key}`) : undefined
      if (typeof storeValue === 'boolean') return storeValue
      return RUNTIME_DEFAULTS[`features.${key}`]
    }
    return {
      streaming: g('streaming'),
      notifications: g('notifications'),
      objectDetection: g('objectDetection'),
      remoteAccess: g('remoteAccess'),
      agentCluster: g('agentCluster'),
      smartHome: g('smartHome'),
      recordings: g('recordings'),
      backup: g('backup'),
      repl: g('repl'),
    }
  }

  /** Bootstrap config + runtime defaults, for backward compat. */
  get raw(): AppConfig {
    return buildRawAppConfig(this.bootstrapConfig)
  }

  /**
   * Atomically update one top-level bootstrap section (server, auth, mode) of
   * config.yaml and sync in-memory. Runtime settings use setSection().
   */
  update(section: string, data: Record<string, unknown>): void {
    this.bootstrapConfig = writeBootstrapSection(this.configPath, section, data)
  }

  private getFromBootstrap(configPath: string): unknown {
    const keys = configPath.split('.')
    let current: unknown = this.bootstrapConfig

    for (const key of keys) {
      if (!isRecord(current)) return undefined
      current = current[key]
    }

    return current
  }

  private getFromRuntimeDefaults(configPath: string): Record<string, unknown> | null {
    // Look for prefix matches (e.g. 'features' -> checks 'features.*' entries)
    const prefix = configPath + '.'
    const result: Record<string, unknown> = {}
    let found = false

    for (const [key, value] of Object.entries(RUNTIME_DEFAULTS)) {
      if (key.startsWith(prefix)) {
        const subKey = key.slice(prefix.length)
        result[subKey] = value
        found = true
      }
    }

    return found ? result : null
  }

  /**
   * Perform a prefix-based nested lookup against the settings-store.
   * e.g. path='features' matches keys 'features.streaming', 'features.notifications', etc.
   * Returns an object keyed by the sub-key, or undefined if nothing is found.
   */
  private getNestedFromSystemSettings(configPath: string): Record<string, unknown> | null {
    if (this.settingsStore === null) return null
    const all = this.settingsStore.getAllSystem()
    const prefix = configPath + '.'
    const result: Record<string, unknown> = {}
    let found = false
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = value
        found = true
      }
    }
    return found ? result : null
  }
}
