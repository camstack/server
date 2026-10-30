import type { ZodType } from 'zod'
import { EventCategory } from '../enums/event-category.js'
import type {
  AddonContext,
  AddonInitResult,
  AddonStoreRead,
  CapabilitiesAccess,
  ProviderRegistration,
  StoredKeyRead,
} from '../interfaces/addon.js'
import type {
  ConfigField,
  ConfigSection,
  ConfigUISchema,
  ConfigUISchemaWithValues,
} from '../interfaces/config-ui.js'
import { hydrateSchema } from '../interfaces/config-ui.js'
import { emitReadiness } from '../interfaces/event-bus.js'
import { SECRET_CLEAR } from '../keychain/secret-marker.js'
import { createDurableState, type DurableState } from './durable-state.js'
import { normalizeNodeId, projectStore, readNodeValue, scopePatch } from './per-node-store.js'
import { createSecretAwareContext, type SecretAwareSettingsHandle } from './secret-aware-context.js'
import { mergeSecretStatePaths, type SecretTree, secretTreeFromSchema } from './secret-paths.js'
import {
  collectSecretMarkerRefs,
  resolveSecretMarkers,
  type UnresolvedSecret,
} from './secret-settings-view.js'
import { isJsonEqual } from './secret-write-back.js'

export interface DeclaredSettingsKeys {
  readonly keys: readonly string[]
}

export interface UnsetSettingsKeysOutcome {
  readonly removed: readonly string[]
  readonly refused: ReadonlyArray<{ readonly key: string; readonly reason: string }>
  readonly secretsCleared: number
}

/** First retry of a secret the keychain could not serve; doubles to {@link SECRET_RETRY_MAX_MS}. */
const SECRET_RETRY_FIRST_MS = 5_000
const SECRET_RETRY_MAX_MS = 5 * 60_000
/** Coalesces a burst of `keychain.changed` events into one re-resolve. */
const SECRET_CHANGE_DEBOUNCE_MS = 250

export type { CapabilitiesAccess }

// ── Typed field helper ──────────────────────────────────────────────────
/**
 * Utility type that constrains a ConfigField's `key` to only accept
 * keys of TConfig. Usage inside schema builders:
 *
 * ```ts
 * protected globalSettingsSchema() {
 *   return this.schema({
 *     sections: [{
 *       id: 'main',
 *       title: 'Settings',
 *       fields: [
 *         this.field({ type: 'number', key: 'maxRetries', label: 'Max Retries' }),
 *         //                                ^^^^^^^^^^^ — autocomplete + compile error if wrong
 *       ],
 *     }],
 *   })
 * }
 * ```
 */
type TypedConfigField<TConfig extends object> = ConfigField extends infer F
  ? F extends { readonly key: string }
    ? Omit<F, 'key'> & { readonly key: keyof TConfig & string }
    : F // valueless fields (separator, info) pass through
  : never

/**
 * A ConfigSection whose fields are key-constrained to TConfig.
 */
interface TypedConfigSection<TConfig extends object> extends Omit<ConfigSection, 'fields'> {
  readonly fields: ReadonlyArray<TypedConfigField<TConfig> | ConfigField>
}

/**
 * A ConfigUISchema whose sections use typed fields.
 */
interface TypedConfigUISchema<TConfig extends object> extends Omit<ConfigUISchema, 'sections'> {
  readonly sections: ReadonlyArray<TypedConfigSection<TConfig>>
}

// ── BaseAddon ───────────────────────────────────────────────────────────

/**
 * Base class for CamStack addons. Eliminates settings boilerplate:
 *
 * - Typed `config` property with automatic resolution from store + defaults
 * - `getGlobalSettings()` / `updateGlobalSettings()` auto-implemented
 * - `getAddonSettings()` / `updateAddonSettings()` auto-implemented
 * - `getDeviceSettings()` / `updateDeviceSettings()` auto-implemented
 * - `ctx` accessor for the AddonContext (no manual `this.ctxRef` storage)
 * - `field()` helper that constrains field keys to TConfig keys
 * - `schema()` helper that validates the full schema structure
 *
 * Subclasses override:
 * - `onInitialize()` — addon-specific init logic, return ProviderRegistration[]
 * - `onShutdown()` — cleanup
 * - `globalSettingsSchema()` / `deviceSettingsSchema()` — UI schemas
 *
 * @example
 * ```ts
 * interface MyConfig {
 *   maxRetries: number
 *   endpoint: string
 * }
 *
 * export default class MyAddon extends BaseAddon<MyConfig> {
 *   constructor() {
 *     super({ maxRetries: 3, endpoint: 'http://localhost' })
 *   }
 *
 *   protected globalSettingsSchema() {
 *     return this.schema({
 *       sections: [{
 *         id: 'main', title: 'Settings',
 *         fields: [
 *           this.field({ type: 'number', key: 'maxRetries', label: 'Max Retries', default: 3 }),
 *           this.field({ type: 'text', key: 'endpoint', label: 'Endpoint' }),
 *         ],
 *       }],
 *     })
 *   }
 *
 *   protected async onInitialize(): Promise<ProviderRegistration[]> {
 *     const client = new Client(this.config.endpoint, this.config.maxRetries)
 *     return [{ capability: 'my-feature', provider: client }]
 *   }
 * }
 * ```
 */
export abstract class BaseAddon<TConfig extends object = Record<string, unknown>> {
  private _ctx: AddonContext | null = null
  private _config: TConfig
  /**
   * Per-process random id used as the `generation` stamp on every
   * `system.ready-state` event this addon emits. Constant for the
   * lifetime of this addon instance (== one process boot); consumer-
   * side registries derive a monotonic `epoch` by watching for
   * generation transitions.
   */
  private readonly _readinessGeneration: string =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 14)
  /** Capability names this addon registered at init — used to emit matching `down` events on shutdown. */
  private _registeredCapNames: readonly string[] = []

  /**
   * True only after `readAddonStore` actually answered. Constructor
   * defaults look like stored config when the store is down — a forked
   * addon that auto-starts from those defaults (cloudflare-tunnel quick
   * mode, 2026-08-25) is not "the operator chose this".
   */
  protected settingsStoreReady = false

  /** Default config values. Provided via constructor. */
  protected readonly defaults: TConfig

  /**
   * Hidden-state paths that hold secrets (D787) — values the addon writes
   * itself (`updateGlobalSettings`, `state()`) that no form field declares.
   * Stored in the keychain exactly like a `password` field. Syntax:
   * `'snapshotSigningKey'`, `'identity.pincode'`, `'tokens[userId].accessToken'`
   * (`key[<id field>]` addresses array items by id, never by index).
   */
  protected readonly secretStatePaths: readonly string[] = []

  private _addonSecretTree: SecretTree | null = null
  private _deviceSecretTree: SecretTree | null = null
  /** Refs the last resolved config pointed at — a change to one re-resolves. */
  private _configSecretRefs: ReadonlySet<string> = new Set()
  private _unresolvedSecrets: readonly UnresolvedSecret[] = []
  private _secretRetryTimer: ReturnType<typeof setTimeout> | null = null
  private _secretRetryDelayMs = SECRET_RETRY_FIRST_MS
  private _secretChangeTimer: ReturnType<typeof setTimeout> | null = null
  private _secretChangeUnsub: (() => void) | null = null
  /** >0 while an OPERATOR's settings write is being applied. */
  private _operatorWriteDepth = 0
  /**
   * The keychain-aware settings handle (D798). Its `raw` view is the ONLY way
   * to the marker-bearing blobs and stays private to this class: the form
   * hydrate and config resolution need markers, addon code never does.
   */
  private _secretSettings: SecretAwareSettingsHandle | null = null
  /** Refs an addon-facing read could not resolve — each is logged once per process. */
  private _loggedUnresolvedReads = new Set<string>()

  constructor(defaults: TConfig) {
    this.defaults = defaults
    this._config = { ...defaults }
  }

  /**
   * Override to opt out of the automatic `system.ready-state` emission.
   * Returns `true` by default — addons that don't map cleanly to the
   * readiness protocol (e.g. pure collection providers whose readiness
   * is already reported per-device by upstream) can override to `false`
   * and emit manually.
   */
  protected get autoEmitReadiness(): boolean {
    return true
  }

  // ── Public accessors ──────────────────────────────────────────────────

  /** The AddonContext, available after initialize(). */
  get ctx(): AddonContext {
    if (!this._ctx) throw new Error(`${this.constructor.name}: ctx accessed before initialize()`)
    return this._ctx
  }

  /**
   * Non-throwing ctx accessor for code paths that can legitimately run
   * before `initialize()` has resolved — most commonly cap handlers the
   * hub invokes eagerly at page load (device-details aggregator pings
   * every addon's `getDeviceSettingsContribution` as soon as the page
   * mounts). Prefer `ctx` for the normal case; reach for this only in
   * capability methods that may be queried before the addon is wired up.
   */
  protected get ctxIfReady(): AddonContext | null {
    return this._ctx
  }

  /** Current resolved config (defaults merged with persisted store values). */
  get config(): Readonly<TConfig> {
    return this._config
  }

  // ── ICamstackAddon lifecycle ──────────────────────────────────────────

  async initialize(context: AddonContext): Promise<AddonInitResult | void> {
    const secrets = context.secrets
    // Once the kernel provides a keychain, every settings READ of this addon
    // answers values (D798) and every WRITE goes through the keychain save
    // path (D787); without one the store behaves as it always did.
    if (secrets !== undefined) {
      const { context: wrapped, handle } = createSecretAwareContext(context, {
        secrets,
        addonTree: () => this.addonSecretTree(),
        deviceTree: () => this.deviceSecretTree(),
        onOrphaned: (refs) =>
          context.logger.warn('keychain refs dropped by a settings write could not be deleted', {
            meta: { refs: [...refs] },
          }),
        isOperatorWrite: () => this._operatorWriteDepth > 0,
        onUnresolved: (unresolved) => this.logUnresolvedRead(unresolved),
      })
      this._ctx = wrapped
      this._secretSettings = handle
    } else {
      this._ctx = context
      this._secretSettings = null
    }
    await this.resolveConfig()
    if (secrets !== undefined) {
      this._secretChangeUnsub = secrets.onChange((ref) => {
        if (this._configSecretRefs.has(ref)) this.scheduleSecretReresolve(SECRET_CHANGE_DEBOUNCE_MS)
      })
    }
    const result = await this.onInitialize()
    this.emitLifecycle(EventCategory.AddonStarted)
    const normalized = normalizeAddonInitResult(result)
    const providers: readonly ProviderRegistration[] =
      normalized && 'providers' in normalized && normalized.providers ? normalized.providers : []
    this._registeredCapNames = providers.map((p) => p.capability.name)
    return normalized
  }

  /**
   * Called by the isolated-process runner AFTER `broker.start()`.
   * In-process addons never need this because the hub broker is already
   * running when `initialize()` fires. For forked children the broker
   * starts AFTER `initialize()`, so the readiness emit inside initialize()
   * fires before the broker can broadcast it. This method re-emits the
   * ready state once the transport is live.
   */
  postBrokerStart(): void {
    if (this.autoEmitReadiness && this._registeredCapNames.length > 0) {
      this.emitReadinessForProviders('ready')
    }
  }

  /**
   * Called by the isolated-process runner / agent bootstrap once the broker
   * has started AND the hub node is connected — the moment `ctx.api.*` calls
   * to hub-provided capabilities become safe. Wrap any bootstrap work that
   * must query the hub (device restore, settings fetch, initial sync) in
   * `onHubConnected()` rather than `onInitialize()` — during `initialize()`
   * on a worker the broker is not yet connected and remote cap calls either
   * time out or throw "Service not found".
   *
   * Default implementation is a no-op. Override in subclasses that need it.
   * Never fires on hub-local in-process addons (the hub is its own node).
   */
  async onHubReachable(): Promise<void> {
    // no-op — override in subclasses
  }

  async shutdown(): Promise<void> {
    this._secretChangeUnsub?.()
    this._secretChangeUnsub = null
    if (this._secretRetryTimer !== null) clearTimeout(this._secretRetryTimer)
    if (this._secretChangeTimer !== null) clearTimeout(this._secretChangeTimer)
    this._secretRetryTimer = null
    this._secretChangeTimer = null
    this.emitLifecycle(EventCategory.AddonStopped)
    if (this.autoEmitReadiness) this.emitReadinessForProviders('down')
    await this.onShutdown()
    for (const unsub of this._subscriptions) unsub()
    this._subscriptions = []
    this._ctx = null
  }

  // ── Subclass hooks ────────────────────────────────────────────────────

  /**
   * Addon-specific initialization. Called after config is resolved.
   *
   * Subclasses may return:
   * - an array of `ProviderRegistration` (back-compat, most common),
   * - an `AddonInitResult` envelope to also declare `customActions`,
   * - `void` for pure consumers.
   */
  protected abstract onInitialize(): Promise<ProviderRegistration[] | AddonInitResult | void>

  /** Addon-specific cleanup. Override if needed. */
  protected async onShutdown(): Promise<void> {
    /* no-op by default */
  }

  /**
   * Called after config is resolved during updateGlobalSettings/updateAddonSettings.
   * Override to react to config changes (e.g. restart a sampler, reconnect a service).
   * Not called during initialize() — use onInitialize() for initial setup.
   */
  protected async onConfigChanged(): Promise<void> {
    /* no-op by default */
  }

  // ── Schema helpers (typed) ────────────────────────────────────────────

  /**
   * Create a ConfigField with `key` constrained to keys of TConfig.
   * Provides autocomplete and compile-time validation.
   */
  protected field<F extends ConfigField>(
    field: F extends { readonly key: string }
      ? Omit<F, 'key'> & { readonly key: keyof TConfig & string }
      : F,
  ): ConfigField {
    return field as ConfigField
  }

  /**
   * Create a full ConfigUISchema with typed sections.
   * Fields created via `this.field()` get key validation automatically.
   */
  protected schema(schema: TypedConfigUISchema<TConfig>): ConfigUISchema {
    return schema as ConfigUISchema
  }

  // ── Settings schemas (override to provide UI) ─────────────────────────

  /** Override to provide global-level settings UI schema. */
  protected globalSettingsSchema(_cap?: string): ConfigUISchema | null {
    return null
  }

  /** Override to provide device-level settings UI schema. */
  protected deviceSettingsSchema(): ConfigUISchema | null {
    return null
  }

  /**
   * INTEGRATION-LEVEL SETTINGS — declare which of this addon's global sections
   * ARE the configuration of its integration.
   *
   * Return the `ConfigSection.id`s, from {@link globalSettingsSchema}, that an
   * operator should find on the addon's integration page (System →
   * Integrations → <name>) rather than only in the cluster-wide list of every
   * addon. Empty (the default) means the addon has no integration-level
   * settings and no such surface is offered — this is opt-in, because whether
   * an addon's configuration IS its integration's configuration depends on the
   * nature of the integration.
   *
   * WHAT THIS IS NOT. It is not a scope. The selected sections keep living in
   * the ONE global schema, in the ONE addon store, written by the ONE
   * `updateGlobalSettings` path. There is deliberately no
   * `updateIntegrationSettings`: a second write path is how a surface acquires
   * a second store key, and this repo has shipped that twice (`btmPath@hub`,
   * D266). Selecting sections cannot introduce a key that selecting cannot.
   *
   * WHY IT IS A LIST OF SECTION IDS AND NOT A MARKER ON THE SECTION.
   * `ConfigFieldBase` used to carry `scope?: 'device' | 'global'` and it was
   * removed with the reason recorded at
   * `packages/types/src/interfaces/config-ui.ts:249` — *"a field's scope is
   * determined by WHICH schema it lives in, not by a field-level marker."* A
   * marker sprinkled across sections also has to borrow a field that already
   * means something else; borrowing `section.tab` put the literal word
   * "integration" into an operator-facing tab bar, because `tab` means "how to
   * GROUP this visually" and cannot also mean "where this lives" (D269
   * supersedes D268). One declaration, in one place, next to the schema whose
   * ids it names.
   */
  protected integrationSettingSections(): readonly string[] {
    return []
  }

  // ── Two-level settings API (auto-implemented) ────────────────────────
  //
  // Note: the former three-level split (addon / global / device) collapsed
  // to two. `addon` and `global` both wrote to the same `writeAddonStore`
  // blob and every addon used exactly one of them; the distinction was
  // never semantically load-bearing. `global` won because it was the
  // widely-used one and the name reads naturally (per-node addon config).

  // Returns `null` when the addon cannot serve authoritative settings right
  // now (e.g. mid-restart, ctx not yet wired). Callers MUST treat null as
  // "unavailable — keep the last-known view" and never as "empty store", so a
  // transient restart window can't reset a UI form to schema defaults.
  // `nodeId` is the node the UI is asking about — the hub addon answers for
  // every node, so it must not assume "self". When the schema declares
  // `perNode: true` fields, reads/writes are scoped per node through
  // `per-node-store.ts`; with no perNode field the projection is bypassed and
  // behavior is identical to the legacy node-agnostic path. The local node id
  // defaults from ctx (node-blind injection) — addons never pass their own.
  async getGlobalSettings(
    overlay?: Record<string, unknown>,
    cap?: string,
    nodeId?: string,
  ): Promise<ConfigUISchemaWithValues | null> {
    const schema = this.globalSettingsSchema(cap)
    if (!schema) return { sections: [] }
    // The form hydrates from the MARKER-bearing store (a marker becomes a
    // "set" view). An override's overlay usually comes from the resolved
    // `resolveGlobalStore()`: a member it carries unchanged keeps the marker.
    const projected = await this.readRawProjectedStore(nodeId, cap)
    const values = overlay ? await this.overlayKeepingMarkers(projected, overlay) : projected
    return hydrateSchema(schema, values, { inlineSecretsAsViews: true })
  }

  /**
   * The integration-level view of this addon's settings: exactly the sections
   * named by {@link integrationSettingSections}, hydrated from the SAME store
   * `getGlobalSettings` reads, and narrowed to cluster-scoped fields.
   *
   * Returns `null` when the addon declared nothing — an addon that opts out has
   * no integration settings surface at all, rather than an empty one that reads
   * as a failed load.
   *
   * Three properties hold BY CONSTRUCTION, which is why they are here in core
   * and not in whichever UI happens to render this:
   *
   *  1. **One key.** The payload is a SUBSET of the global schema, so a field
   *     shown here is the same field, with the same bare key, that the addon's
   *     own page shows. There is no integration-specific writer — callers save
   *     through `updateGlobalSettings` — so a second store key is unreachable,
   *     not merely discouraged.
   *  2. **No node scope.** `perNode: true` fields are DROPPED. Their store key
   *     is `<key>@<nodeId>` and an integration is not a node; whichever node
   *     such a field silently picked would be a wrong answer for the operator
   *     who opened the page (D266).
   *  3. **No silent typo.** A declared id that names no section throws. The
   *     alternative — skip it — turns a rename into a surface that quietly
   *     empties, which looks exactly like an addon with nothing to configure.
   */
  async getIntegrationSettings(nodeId?: string): Promise<ConfigUISchemaWithValues | null> {
    const declared = this.integrationSettingSections()
    if (declared.length === 0) return null
    const schema = this.globalSettingsSchema()
    if (!schema) {
      throw new Error(
        `${this.constructor.name}: integrationSettingSections() names ` +
          `[${declared.join(', ')}] but globalSettingsSchema() returns null.`,
      )
    }
    const byId = new Map(schema.sections.map((section) => [section.id, section]))
    const sections: ConfigSection[] = []
    for (const id of declared) {
      const section = byId.get(id)
      if (!section) {
        throw new Error(
          `${this.constructor.name}: integrationSettingSections() names unknown section ` +
            `"${id}". Known sections: [${[...byId.keys()].join(', ')}].`,
        )
      }
      const fields = dropPerNodeFields(section.fields)
      if (fields.length === 0) continue
      sections.push({ ...section, fields })
    }
    if (sections.length === 0) return null
    const projected = await this.readRawProjectedStore(nodeId)
    return hydrateSchema({ ...schema, sections }, projected, { inlineSecretsAsViews: true })
  }

  /**
   * The raw addon store PROJECTED onto the target node's bare per-node keys:
   * every `perNode: true` field carries THAT node's scoped value on its bare
   * key (absent scoped key ⇒ key absent, so the schema `default` wins — no
   * bare fallback), all `@`-scoped and stray bare per-node keys are dropped.
   * A no-op passthrough when the schema declares no `perNode` field.
   *
   * This is the sanctioned way for a `getGlobalSettings` OVERRIDE that needs
   * the store for custom option logic (option narrowing, value snapping) to
   * read it per-node — never `ctx.settings.readAddonStore()` directly.
   * `nodeId` omitted ⇒ the local node (node-blind injection from ctx).
   *
   * Keychain values come back RESOLVED (D798): a secret reads as its value,
   * never as a `{ $secret }` marker. One the keychain cannot serve right now
   * stays a marker — "stored, unavailable" (`isSecretMarker()` is true, and it
   * is listed in {@link unresolvedSecrets}) — never `''` and never absent, so
   * it cannot be mistaken for "nothing stored, mint a new one". Writing the
   * resolved blob back is a no-op for every unchanged secret.
   */
  protected async resolveGlobalStore(
    nodeId?: string,
    cap?: string,
  ): Promise<Record<string, unknown>> {
    const raw = (await this._ctx?.settings?.readAddonStore()) ?? {}
    return this.projectForNode(raw, nodeId, cap)
  }

  private projectForNode(
    store: Record<string, unknown>,
    nodeId?: string,
    cap?: string,
  ): Record<string, unknown> {
    const keys = this.perNodeKeys(cap)
    const node = normalizeNodeId(nodeId ?? this._ctx?.kernel?.localNodeId)
    return keys.size > 0 ? projectStore(store, keys, node) : store
  }

  /** The PROJECTED store with its markers — the form hydrate only (D798). */
  private async readRawProjectedStore(
    nodeId?: string,
    cap?: string,
  ): Promise<Record<string, unknown>> {
    const raw = (await this.rawSettings()?.readAddonStore()) ?? {}
    return this.projectForNode(raw, nodeId, cap)
  }

  /**
   * `{ ...stored, ...overlay }`, except that an overlay member equal to the
   * RESOLVED stored one keeps the stored (marker-bearing) member — so a form
   * hydrated from a resolved overlay still shows a secret as "set", never as
   * its value.
   */
  private async overlayKeepingMarkers(
    stored: Record<string, unknown>,
    overlay: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const secrets = this._ctx?.secrets
    const merged: Record<string, unknown> = { ...stored, ...overlay }
    if (secrets === undefined || collectSecretMarkerRefs(stored).length === 0) return merged
    const { value: resolved } = await resolveSecretMarkers(stored, secrets, {
      unresolved: 'keep-marker',
      ownedBy: secrets.owner,
    })
    for (const key of Object.keys(overlay)) {
      if (collectSecretMarkerRefs(stored[key]).length === 0) continue
      if (isJsonEqual(overlay[key], resolved[key])) merged[key] = stored[key]
    }
    return merged
  }

  /**
   * Whether ONE global key of this addon's store was written, read three-way
   * (D651). For a question a hydrated view cannot answer: `getGlobalSettings`
   * reports `value ?? default`, so "the operator chose the default" and "nobody
   * chose" look the same, and a failed read looks like both. A `perNode` key is
   * not supported here: its stored name is scoped.
   */
  protected async readStoredGlobalKey(key: string): Promise<StoredKeyRead> {
    const read = this._ctx?.settings?.readAddonStoreResult
    if (read === undefined) return { kind: 'unreadable', reason: 'three-way-read-unavailable' }
    let result: AddonStoreRead
    try {
      result = await read.call(this._ctx?.settings)
    } catch (err: unknown) {
      return {
        kind: 'unreadable',
        reason: 'store-read-failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (result.kind === 'failed') {
      return { kind: 'unreadable', reason: 'store-read-failed', error: result.error }
    }
    if (result.kind === 'missing' || !Object.prototype.hasOwnProperty.call(result.value, key)) {
      return { kind: 'absent' }
    }
    return { kind: 'present', value: result.value[key] }
  }

  /**
   * The OPERATOR's write — a settings form or an admin API call, dispatched by
   * the kernel. Identical to {@link updateGlobalSettings}, except that a secret
   * the operator sends is stored as sent even when it equals a pre-keychain
   * inline value: the operator re-entering a password is a change, an addon
   * writing back what it read is not (D787).
   */
  async updateGlobalSettingsAsOperator(
    patch: Record<string, unknown>,
    nodeId?: string,
  ): Promise<void> {
    this._operatorWriteDepth++
    try {
      await this.applyGlobalPatch(patch, nodeId)
    } finally {
      this._operatorWriteDepth--
    }
  }

  async updateGlobalSettings(patch: Partial<TConfig>, nodeId?: string): Promise<void> {
    // The `as Record<string, unknown>` below is the pre-existing documented
    // type boundary (a generic Partial<TConfig> has no index signature).
    await this.applyGlobalPatch(patch as Record<string, unknown>, nodeId)
  }

  /**
   * REMOVE stored secrets — their keychain values and their markers (D787).
   *
   * Writing `''` to a secret field KEEPS what is stored (an empty string is
   * what a defaults fallback writes back, and it must never destroy a
   * credential), so code that means "forget this token" says so here. Without
   * a keychain (an older kernel) it writes `''`, as such code always did.
   */
  protected async clearSecrets(
    keys: ReadonlyArray<keyof TConfig & string>,
    nodeId?: string,
  ): Promise<void> {
    const tree = this.addonSecretTree()
    const keychain = this._ctx?.secrets !== undefined
    // A key whose stored value is a marker is keychain-stored even when no
    // schema declares it (any more): it is cleared through the keychain too.
    const stored = keychain ? await this.readAddonStoreWithRetry() : {}
    const patch: Record<string, unknown> = {}
    // Only a keychain-stored key understands the clear instruction; any other
    // key is cleared the way it always was.
    for (const key of keys) {
      const keychainStored = tree.has(key) || collectSecretMarkerRefs(stored[key]).length > 0
      patch[key] = keychain && keychainStored ? SECRET_CLEAR : ''
    }
    await this.applyGlobalPatch(patch, nodeId)
  }

  private async applyGlobalPatch(
    barePatch: Record<string, unknown>,
    nodeId?: string,
  ): Promise<void> {
    const keys = this.perNodeKeys()
    const localNode = normalizeNodeId(this._ctx?.kernel?.localNodeId)
    const target = normalizeNodeId(nodeId ?? this._ctx?.kernel?.localNodeId)
    const scoped = keys.size > 0 ? scopePatch(barePatch, keys, target) : barePatch
    const handle = this._secretSettings
    if (handle !== null) {
      // A write that changed nothing — the write-back of a resolved read —
      // is not a config change: no re-resolve, no onConfigChanged, no
      // AddonUpdated, no restart. That loop is what rotated Reolink's SMTP
      // password (D798).
      const { changed } = await handle.writeAddonStore(scoped)
      if (!changed) return
    } else {
      await this._ctx?.settings?.writeAddonStore(scoped)
    }
    // Sibling-node write: persist only — the target node picks the value up
    // through its own projected reads; no local apply on THIS node.
    if (target !== localNode) return
    await this.resolveConfig()
    await this.onConfigChanged()
    this.emitLifecycle(EventCategory.AddonUpdated, { level: 'global' })
    this.maybeAutoRestart(Object.keys(barePatch), this.globalSettingsSchema())
  }

  /**
   * The set of field keys the global settings schema declares `perNode: true`
   * — derived once per `cap` argument and memoized (schemas are static
   * declarations). Empty set ⇒ every per-node code path is bypassed and the
   * settings API behaves exactly like the legacy node-agnostic one.
   */
  private readonly _perNodeKeysCache = new Map<string, ReadonlySet<string>>()

  private perNodeKeys(cap?: string): ReadonlySet<string> {
    const cacheKey = cap ?? ''
    const cached = this._perNodeKeysCache.get(cacheKey)
    if (cached) return cached
    const schema = this.globalSettingsSchema(cap)
    const keys: ReadonlySet<string> = new Set(
      schema ? schema.sections.flatMap((section) => collectPerNodeFieldKeys(section.fields)) : [],
    )
    this._perNodeKeysCache.set(cacheKey, keys)
    return keys
  }

  /**
   * If any field in `patch` is marked `requiresRestart` in `schema`,
   * schedule an addon restart for the next tick. Deferred via
   * `setImmediate` so the tRPC mutation that triggered the write has
   * time to return its response before the addon is torn down and
   * re-initialised by `AddonRegistryService.restartAddon`.
   */
  private maybeAutoRestart(patchKeys: readonly string[], schema: ConfigUISchema | null): void {
    if (!schema) return
    const restartKeys = new Set<string>()
    for (const section of schema.sections) {
      for (const field of section.fields) {
        if (field.type === 'separator' || field.type === 'info') continue
        if ((field as { readonly requiresRestart?: boolean }).requiresRestart) {
          restartKeys.add((field as { readonly key: string }).key)
        }
      }
    }
    if (restartKeys.size === 0) return
    const changed = patchKeys.some((k) => restartKeys.has(k))
    if (!changed) return
    const ctx = this._ctx
    if (!ctx) return
    const addonId = ctx.id
    setImmediate(() => {
      ctx.api.addons.restartAddon
        .mutate({ addonId })
        .then(() => {
          ctx.logger.info('addon auto-restart triggered by restart-required setting change', {
            meta: { changedFields: patchKeys.filter((k) => restartKeys.has(k)) },
          })
        })
        .catch((err: unknown) => {
          ctx.logger.error('addon auto-restart failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
    })
  }

  async getDeviceSettings(deviceId: number): Promise<ConfigUISchemaWithValues> {
    const schema = this.deviceSettingsSchema()
    if (!schema) return { sections: [] }
    const raw = (await this.rawSettings()?.readDeviceStore(deviceId)) ?? {}
    return hydrateSchema(schema, raw, { inlineSecretsAsViews: true })
  }

  async updateDeviceSettings(deviceId: number, patch: Record<string, unknown>): Promise<void> {
    await this._ctx?.settings?.writeDeviceStore(deviceId, patch)
  }

  // ── Event subscriptions (auto-cleanup on shutdown) ────────────────────

  private _subscriptions: Array<() => void> = []

  /**
   * Subscribe to an event bus category. The subscription is automatically
   * unsubscribed on shutdown — no manual cleanup needed.
   *
   * @example
   * ```ts
   * this.subscribe({ category: EventCategory.DeviceRegistered }, (event) => {
   *   void this.handleDevice(event)
   * })
   * ```
   */
  /**
   * Subscribe to `system.ready-state` events for one or more capabilities.
   * Abstracts the boilerplate type-narrowing + nodeId extraction that every
   * resilience subscription duplicates. Cleanup is automatic (registered on
   * `_subscriptions` like a normal `subscribe` call).
   */
  protected watchCapability(
    capNames: string | readonly string[],
    handlers: {
      readonly onDown?: (nodeId: string, capName: string) => void
      readonly onReady?: (nodeId: string, capName: string) => void
    },
  ): void {
    const names = Array.isArray(capNames) ? capNames : [capNames]
    const nameSet = new Set<string>(names as string[])
    this.subscribe({ category: 'system.ready-state' }, (event) => {
      const data = event.data as {
        readonly capName?: unknown
        readonly state?: unknown
        readonly scope?: { readonly type?: unknown; readonly nodeId?: unknown }
      }
      if (typeof data.capName !== 'string') return
      if (!nameSet.has(data.capName)) return
      if (data.scope?.type !== 'node') return
      const nodeId = data.scope.nodeId
      if (typeof nodeId !== 'string' || nodeId.length === 0) return
      const capName = data.capName
      if (data.state === 'down') {
        handlers.onDown?.(nodeId, capName)
      } else if (data.state === 'ready') {
        handlers.onReady?.(nodeId, capName)
      }
    })
  }

  protected subscribe<C extends import('../interfaces/event-bus.js').KnownEventCategory>(
    filter: import('../interfaces/event-bus.js').TypedEventFilter<C>,
    handler: (event: import('../interfaces/event-bus.js').TypedSystemEvent<C>) => void,
  ): void
  protected subscribe(
    filter: import('../interfaces/event-bus.js').EventFilter,
    handler: (event: import('../interfaces/event-bus.js').SystemEvent) => void,
  ): void
  protected subscribe(
    filter: import('../interfaces/event-bus.js').EventFilter,
    handler: (event: import('../interfaces/event-bus.js').SystemEvent) => void,
  ): void {
    const unsub = this.ctx.eventBus.subscribe(filter, handler)
    this._subscriptions.push(unsub)
  }

  // ── Lifecycle event emission ────────────────────────────────────────────

  private emitLifecycle(category: EventCategory, data?: Record<string, unknown>): void {
    try {
      const ctx = this._ctx
      if (!ctx) return
      ctx.eventBus.emit({
        id: `${ctx.id}-${Date.now()}`,
        timestamp: new Date(),
        source: { type: 'addon', id: ctx.id, nodeId: ctx.kernel.localNodeId ?? 'hub' },
        category,
        // Always carry `addonId` in the payload (the lifecycle event
        // contract declares it) so consumers — e.g. the alerts builder —
        // can name the addon without reaching into `source`. An explicit
        // `data.addonId` still wins if a caller provides one.
        data: { addonId: ctx.id, ...data },
      })
    } catch {
      /* best-effort — don't crash addon if event bus is unavailable */
    }
  }

  /**
   * Emit a `system.ready-state` event for every capability this addon
   * registered at init. Scope is `{type:'node', nodeId}` — readiness is
   * tied to the node that hosts the provider. Consumers that care about
   * per-device readiness can subscribe with `{type:'device', ...}` if
   * the provider emits at finer granularity (collection addons may
   * opt-out via `autoEmitReadiness` and emit manually).
   */
  private emitReadinessForProviders(state: 'ready' | 'down'): void {
    const ctx = this._ctx
    if (!ctx) return
    if (this._registeredCapNames.length === 0) return
    // Forked child processes have a hierarchical nodeId (e.g. 'hub/detection-pipeline').
    // Readiness must be scoped to the logical parent node so orchestrators that
    // subscribe to 'hub' or 'dev-agent-0' receive the event from their children too.
    const rawNodeId = ctx.kernel?.localNodeId ?? 'hub'
    const nodeId = rawNodeId.includes('/') ? rawNodeId.split('/')[0]! : rawNodeId
    for (const capName of this._registeredCapNames) {
      try {
        emitReadiness(ctx.eventBus, {
          capName,
          scope: { type: 'node', nodeId },
          state,
          generation: this._readinessGeneration,
          sourceNodeId: nodeId,
        })
      } catch {
        /* best-effort — a broken bus must not take the addon down */
      }
    }
  }

  // ── Common helpers ─────────────────────────────────────────────────────

  /**
   * Resolve the shared, node-local models directory: `<nodeDataDir>/models`.
   *
   * This is the SINGLE centralized models-dir resolver for every inference addon
   * (detection-pipeline, audio-analyzer, embedding-encoder, model-studio). It is
   * anchored at the node's own writable data root (`ctx.nodeDataDir`, i.e.
   * `CAMSTACK_DATA` ?? the kernel boot dir) — never the hub-singleton `storage`
   * cap, which returns the hub's `/data/models` to every node and breaks any node
   * whose real data dir differs (e.g. the macOS electron agent).
   *
   * `node:path`/`node:fs` are imported dynamically so the `@camstack/types` root
   * barrel (re-exported into browser bundles) stays free of node builtins.
   */
  protected async resolveModelsDir(): Promise<string> {
    const { join } = await import('node:path')
    const { promises: fsp } = await import('node:fs')
    const dir = join(this.ctx.nodeDataDir, 'models')
    await fsp.mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Access the runtime capability registry for in-process provider lookups.
   * Returns null if the registry is not available (e.g. on agents).
   * Used by addons that consume other capabilities directly (snapshot, stream-broker, enrichment).
   */
  protected get capabilities(): CapabilitiesAccess | null {
    const capCtx = this.ctx as { capabilities?: CapabilitiesAccess }
    return capCtx.capabilities ?? null
  }

  // ── Config resolution ─────────────────────────────────────────────────

  /**
   * Resolve config by merging defaults with persisted store values.
   * Called automatically during initialize() and after every updateSettings().
   *
   * The merge is shallow: each key in `defaults` is checked against the store.
   * Only keys present in defaults are read — the store can contain extra keys
   * (e.g. from older versions) without polluting the typed config.
   *
   * Keys the global settings schema declares `perNode: true` resolve from
   * THIS node's scoped key (`<key>@<localNode>`) via `readNodeValue` — never
   * from the bare key — so a per-node field resolves to this node's own
   * selection at boot (absent scoped key ⇒ the constructor default wins).
   */
  protected async resolveConfig(): Promise<void> {
    // Markers are substituted BEFORE the typeof check below: a marker is an
    // object, so left in place it would fail the check and the default ('')
    // would silently win — a credential turned into an empty one (D787).
    const stored = await this.resolveStoredSecrets(await this.readAddonStoreWithRetry())
    const perNode = this.perNodeKeys()
    const localNode = normalizeNodeId(this._ctx?.kernel?.localNodeId)
    const resolved = { ...this.defaults }

    for (const key of Object.keys(this.defaults) as Array<keyof TConfig & string>) {
      const storedValue = perNode.has(key) ? readNodeValue(stored, key, localNode) : stored[key]
      if (storedValue !== undefined && storedValue !== null) {
        const defaultType = typeof this.defaults[key]
        if (typeof storedValue === defaultType) {
          ;(resolved as Record<string, unknown>)[key] = storedValue
        }
      }
    }

    this._config = resolved
  }

  /**
   * Typed durable handle over ONE key of this addon's store. The whole
   * Zod-validated value round-trips on every read/write — no hand-listed
   * fields, so a field can never be silently dropped on persist. Reads use
   * the same retry budget as config resolution; a corrupt/legacy blob logs
   * a warning and falls back rather than crashing boot.
   */
  protected state<T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> {
    this._declaredStateKeys.add(key)
    return createDurableState<T>({
      key,
      schema,
      fallback,
      // Resolved: a hidden secret (`secretStatePaths`) reads as its value.
      read: async () => this.resolveStoredSecrets(await this.readAddonStoreWithRetry()),
      write: async (patch) => {
        await this._ctx?.settings?.writeAddonStore(patch)
      },
      onParseError: (k, e) =>
        this._ctx?.logger?.warn?.(
          `durable-state: stored "${k}" failed validation — using fallback`,
          { meta: { addonId: this._ctx?.id, key: k, error: String(e) } },
        ),
    })
  }

  /** Durable-state keys this process registered through {@link state}. */
  private readonly _declaredStateKeys = new Set<string>()

  /**
   * Stale-data audit: every global-settings key this addon still declares —
   * constructor defaults, settings-schema fields (layout containers included),
   * durable-state keys and the root of each `secretStatePaths` entry. Answered
   * here, in the addon's own process, so the hub keeps no copy of it.
   */
  async getDeclaredSettingsKeys(): Promise<DeclaredSettingsKeys> {
    return { keys: [...this.declaredKeySet()].toSorted() }
  }

  private declaredKeySet(): Set<string> {
    const keys = new Set<string>(Object.keys(this.defaults))
    const schema = this.globalSettingsSchema()
    if (schema) {
      for (const section of schema.sections) {
        for (const key of collectFieldKeys(section.fields)) keys.add(key)
      }
    }
    for (const key of this._declaredStateKeys) keys.add(key)
    for (const path of this.secretStatePaths) {
      const root = path.split(/[.[]/, 1)[0]
      if (root) keys.add(root)
    }
    return keys
  }

  /**
   * Stale-data audit: remove stored global-settings keys the addon no longer
   * declares, and clear the keychain values their markers held — except a value
   * a surviving key still points at. A declared or absent key is refused.
   */
  async unsetStoredSettingsKeys(keys: readonly string[]): Promise<UnsetSettingsKeysOutcome> {
    const settings = this._ctx?.settings
    const raw = this.rawSettings()
    if (!settings || !raw) {
      return {
        removed: [],
        refused: keys.map((key) => ({ key, reason: 'no settings store' })),
        secretsCleared: 0,
      }
    }
    let stored: Record<string, unknown>
    try {
      stored = await raw.readAddonStore()
    } catch (error) {
      const reason = `store unreadable: ${error instanceof Error ? error.message : 'unknown'}`
      return { removed: [], refused: keys.map((key) => ({ key, reason })), secretsCleared: 0 }
    }
    const declared = this.declaredKeySet()
    const removed: string[] = []
    const refused: Array<{ key: string; reason: string }> = []
    for (const key of keys) {
      const base = key.split('@', 1)[0] ?? key
      if (declared.has(base)) refused.push({ key, reason: 'still declared by the addon' })
      else if (!(key in stored)) refused.push({ key, reason: 'not stored' })
      else removed.push(key)
    }
    if (removed.length === 0) return { removed, refused, secretsCleared: 0 }

    const kept = new Set<string>()
    const held = new Set<string>()
    for (const [key, value] of Object.entries(stored)) {
      const target = removed.includes(key) ? held : kept
      for (const ref of collectSecretMarkerRefs(value)) target.add(ref)
    }
    const refsToClear = [...held].filter((ref) => !kept.has(ref))

    const patch: Record<string, unknown> = {}
    for (const key of removed) patch[key] = undefined
    await settings.writeAddonStore(patch)
    const secretsCleared =
      refsToClear.length > 0 && this._ctx?.secrets ? await this._ctx.secrets.delete(refsToClear) : 0
    await this.resolveConfig()
    return { removed, refused, secretsCleared }
  }

  /** Per-device variant of {@link state}, backed by the per-device store. */
  protected deviceState<T>(
    deviceId: number,
    key: string,
    schema: ZodType<T>,
    fallback: T,
  ): DurableState<T> {
    return createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () =>
        this.resolveStoredSecrets(
          (await this.rawSettings()?.readDeviceStore(deviceId)) ?? {},
          false,
        ),
      write: async (patch) => {
        await this._ctx?.settings?.writeDeviceStore(deviceId, patch)
      },
      onParseError: (k, e) =>
        this._ctx?.logger?.warn?.(
          `durable-state: stored device ${deviceId} "${k}" failed validation — using fallback`,
          { meta: { addonId: this._ctx?.id, deviceId, key: k, error: String(e) } },
        ),
    })
  }

  // ── Keychain (D787) ───────────────────────────────────────────────────

  /** The addon store's secret tree: schema fields by TYPE, plus `secretStatePaths`. */
  private addonSecretTree(): SecretTree {
    this._addonSecretTree ??= mergeSecretStatePaths(
      secretTreeFromSchema(this.globalSettingsSchema()),
      this.secretStatePaths,
    )
    return this._addonSecretTree
  }

  private deviceSecretTree(): SecretTree {
    // `secretStatePaths` name hidden credentials in the per-device store too
    // (D870): a device setting such as the broker's restream tokens is stored
    // as a keychain marker under the `device/<id>` scope.
    this._deviceSecretTree ??= mergeSecretStatePaths(
      secretTreeFromSchema(this.deviceSettingsSchema()),
      this.secretStatePaths,
    )
    return this._deviceSecretTree
  }

  /**
   * Secrets of this addon's stored config that could not be resolved on the
   * last read, with why. Non-empty means the addon is running WITHOUT them —
   * an addon whose function needs one should report itself degraded rather
   * than start on an empty credential.
   */
  protected get unresolvedSecrets(): readonly UnresolvedSecret[] {
    return this._unresolvedSecrets
  }

  /**
   * Substitute every keychain marker in a stored blob with its value. With no
   * keychain (no `ctx.secrets`) or no marker, the blob comes back unchanged.
   * An unresolvable value is LEFT OUT (never `''`), logged by ref — never by
   * value — and, when the cause can pass, retried with backoff. Nothing is
   * ever written back from here.
   */
  private async resolveStoredSecrets(
    blob: Record<string, unknown>,
    trackForConfig = true,
  ): Promise<Record<string, unknown>> {
    const secrets = this._ctx?.secrets
    if (secrets === undefined) return blob
    const refs = collectSecretMarkerRefs(blob)
    if (trackForConfig) this._configSecretRefs = new Set(refs)
    if (refs.length === 0) {
      if (trackForConfig) this._unresolvedSecrets = []
      return blob
    }
    const { value, unresolved } = await resolveSecretMarkers(blob, secrets)
    if (trackForConfig) {
      this._unresolvedSecrets = unresolved
      if (unresolved.length > 0) {
        this._ctx?.logger?.error?.('secret unavailable — running without it, will retry', {
          meta: { secrets: unresolved.map((u) => ({ ref: u.ref, reason: u.reason })) },
        })
        if (unresolved.some((u) => u.reason !== 'missing' && u.reason !== 'forbidden')) {
          this.scheduleSecretReresolve(this._secretRetryDelayMs)
          this._secretRetryDelayMs = Math.min(this._secretRetryDelayMs * 2, SECRET_RETRY_MAX_MS)
        }
      } else {
        this._secretRetryDelayMs = SECRET_RETRY_FIRST_MS
      }
    }
    return value
  }

  /**
   * The marker-bearing settings reads (D798) — private on purpose. Without a
   * keychain the context's own view is already raw.
   */
  private rawSettings():
    | Pick<NonNullable<AddonContext['settings']>, 'readAddonStore' | 'readDeviceStore'>
    | undefined {
    return this._secretSettings?.raw ?? this._ctx?.settings
  }

  /** An addon-facing read met markers it could not resolve: say so once per ref. */
  private logUnresolvedRead(unresolved: readonly UnresolvedSecret[]): void {
    const fresh = unresolved.filter((u) => !this._loggedUnresolvedReads.has(u.ref))
    if (fresh.length === 0) return
    for (const u of fresh) this._loggedUnresolvedReads.add(u.ref)
    this._ctx?.logger?.warn?.(
      'settings read: a stored secret is unavailable — it reads as its marker, not as a value',
      { meta: { secrets: fresh.map((u) => ({ ref: u.ref, reason: u.reason })) } },
    )
  }

  /** Re-resolve the config (a keychain-only change, or a retry) and apply it. */
  private scheduleSecretReresolve(delayMs: number): void {
    const timerOf =
      delayMs === SECRET_CHANGE_DEBOUNCE_MS ? '_secretChangeTimer' : '_secretRetryTimer'
    if (this[timerOf] !== null) return
    const timer = setTimeout(() => {
      this[timerOf] = null
      if (this._ctx === null) return
      void this.resolveConfig()
        .then(() => this.onConfigChanged())
        .catch((err: unknown) => {
          this._ctx?.logger?.error?.('re-resolving secrets failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
    }, delayMs)
    timer.unref?.()
    this[timerOf] = timer
  }

  /**
   * Wrap `ctx.settings.readAddonStore()` with a retry budget so a transient
   * settings-store outage doesn't propagate up into `initialize()` and leave the
   * addon permanently broken.
   *
   * Two kinds of outage, two budgets:
   *  - the store's own restart fingerprints (`SqliteSettingsBackend not
   *    initialized`, `provider not available`): a short budget, then the addon
   *    falls back to `{}` (defaults) - its first successful patch rehydrates;
   *  - a TRANSPORT failure (the hub is restarting while this runner boots:
   *    `discovery deadline exceeded`, `parent could not route`, a refused or
   *    timed-out connection). Since D870 a runner's settings read THROWS instead
   *    of answering `{}`, so without a budget a hub restart ends in a respawn
   *    loop. A long, bounded budget; only after it the error propagates - the
   *    addon never runs on defaults for a store it could not ask.
   * Anything else propagates immediately so real bugs surface.
   */
  private async readAddonStoreWithRetry(): Promise<Record<string, unknown>> {
    const settings = this.rawSettings()
    if (!settings) return {}
    let lastErr: unknown
    for (let attempt = 0; ; attempt++) {
      try {
        const stored = (await settings.readAddonStore()) ?? {}
        this.settingsStoreReady = true
        return stored
      } catch (err) {
        lastErr = err
        const kind = classifyStoreError(err)
        if (kind === 'permanent') throw err
        const delays = kind === 'transport' ? TRANSPORT_RETRY_DELAYS_MS : RESTART_RETRY_DELAYS_MS
        const delay = delays[attempt]
        if (delay === undefined) {
          if (kind === 'transport') throw err
          break
        }
        await new Promise<void>((r) => setTimeout(r, delay))
      }
    }
    this.settingsStoreReady = false
    this._ctx?.logger?.warn?.(
      'readAddonStore: settings-store unavailable after retries — using defaults',
      {
        meta: { error: lastErr instanceof Error ? lastErr.message : String(lastErr) },
      },
    )
    return {}
  }
}

/** The settings store's own restart fingerprints. */
const RESTART_RETRY_DELAYS_MS: readonly number[] = [150, 350, 600, 900]
/** A hub restarting under a booting runner: ~100 s in total. */
const TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [
  150, 350, 600, 900, 2_000, 5_000, 10_000, 20_000, 30_000, 30_000,
]
const RESTART_FINGERPRINTS: readonly string[] = [
  'SqliteSettingsBackend not initialized',
  'provider not available',
]
/** Node / socket error codes of a connection that did not happen or broke. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
])
/** tRPC error codes that mean "the other side is not answering now", not "your call is wrong". */
const UNAVAILABLE_TRPC_CODES: ReadonlySet<string> = new Set([
  'TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'BAD_GATEWAY',
  'GATEWAY_TIMEOUT',
])
/** The exact phrases OUR transport raises when it cannot reach the hub. */
const TRANSPORT_PHRASES: readonly string[] = [
  'discovery deadline exceeded',
  'parent could not route child unowned cap call',
  // `SocketChannel.request` (a plain Error, no code) and its closed-socket twin.
  'UDS request timed out after',
  'channel closed',
]
/** Moleculer error `type`s of a call that could not be served right now. */
const MOLECULER_TRANSIENT_TYPES: ReadonlySet<string> = new Set([
  'REQUEST_TIMEOUT',
  'SERVICE_NOT_FOUND',
  'SERVICE_NOT_AVAILABLE',
  'REQUEST_REJECTED',
  'BROKER_DISCONNECTED',
])

function stringProp(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === 'string' ? found : undefined
}

/** The code an error carries: its own, its cause's, or a tRPC `data.code`. */
function errorCode(err: unknown): { node?: string; trpc?: string } {
  const out: { node?: string; trpc?: string } = {}
  const cause: unknown =
    typeof err === 'object' && err !== null ? Reflect.get(err, 'cause') : undefined
  const data: unknown =
    typeof err === 'object' && err !== null ? Reflect.get(err, 'data') : undefined
  const node = stringProp(err, 'code') ?? stringProp(cause, 'code')
  if (node !== undefined) out.node = node
  const trpc = stringProp(data, 'code')
  if (trpc !== undefined) out.trpc = trpc
  return out
}

/**
 * Is a settings read failure worth retrying, and with which budget? Only
 * EXPLICIT signals count: a socket error code, a tRPC "unavailable" code, or
 * one of the exact phrases our own transport raises. A message that merely
 * contains "timed out" or "unreachable" is not evidence of anything, and
 * `settings store not wired` is a wiring bug that retrying cannot fix.
 */
export function classifyStoreError(err: unknown): 'restart' | 'transport' | 'permanent' {
  const message = err instanceof Error ? err.message : String(err)
  if (RESTART_FINGERPRINTS.some((f) => message.includes(f))) return 'restart'
  const code = errorCode(err)
  if (code.node !== undefined && TRANSPORT_CODES.has(code.node)) return 'transport'
  if (code.trpc !== undefined && UNAVAILABLE_TRPC_CODES.has(code.trpc)) return 'transport'
  // Moleculer marks every "could not reach it" error `retryable` and gives it a
  // `type`; its numeric `code` (504, 404, 503) is NOT a string, so it is read here.
  if (typeof err === 'object' && err !== null) {
    if (Reflect.get(err, 'retryable') === true) return 'transport'
    const type = stringProp(err, 'type')
    if (type !== undefined && MOLECULER_TRANSIENT_TYPES.has(type)) return 'transport'
  }
  if (TRANSPORT_PHRASES.some((f) => message.includes(f))) return 'transport'
  return 'permanent'
}

/**
 * Collect the keys of every field marked `perNode: true`, recursing into
 * layout containers (`group` fields and `sub-tabs` tabs) the same way
 * `hydrateSchema` does. Valueless structural fields (separator/info/…)
 * don't declare `perNode` and are excluded by the `in` narrowing.
 */
/**
 * The same fields with every `perNode: true` one removed, recursing into layout
 * containers exactly as {@link collectPerNodeFieldKeys} does. A container left
 * with no child is dropped rather than rendered empty.
 *
 * Used by `getIntegrationSettings`: an integration is not a node, so a field
 * whose store key is `<key>@<nodeId>` has no node to belong to there.
 */
function dropPerNodeFields(fields: readonly ConfigField[]): ConfigField[] {
  const kept: ConfigField[] = []
  for (const field of fields) {
    if (field.type === 'group') {
      const inner = dropPerNodeFields(field.fields)
      if (inner.length > 0) kept.push({ ...field, fields: inner })
      continue
    }
    if (field.type === 'sub-tabs') {
      const tabs = field.tabs
        .map((tab) => ({ ...tab, fields: dropPerNodeFields(tab.fields) }))
        .filter((tab) => tab.fields.length > 0)
      if (tabs.length > 0) kept.push({ ...field, tabs })
      continue
    }
    if ('perNode' in field && field.perNode === true) continue
    kept.push(field)
  }
  return kept
}

function collectFieldKeys(fields: readonly ConfigField[]): readonly string[] {
  const collected: string[] = []
  for (const field of fields) {
    if (field.type === 'group') {
      collected.push(...collectFieldKeys(field.fields))
      continue
    }
    if (field.type === 'sub-tabs') {
      for (const tab of field.tabs) collected.push(...collectFieldKeys(tab.fields))
      continue
    }
    if ('key' in field && typeof field.key === 'string') collected.push(field.key)
  }
  return collected
}

function collectPerNodeFieldKeys(fields: readonly ConfigField[]): readonly string[] {
  const collected: string[] = []
  for (const field of fields) {
    if (field.type === 'group') {
      collected.push(...collectPerNodeFieldKeys(field.fields))
      continue
    }
    if (field.type === 'sub-tabs') {
      for (const tab of field.tabs) collected.push(...collectPerNodeFieldKeys(tab.fields))
      continue
    }
    if ('perNode' in field && field.perNode === true) collected.push(field.key)
  }
  return collected
}

/**
 * Normalize an `ICamstackAddon.initialize()` return value into the
 * `AddonInitResult` envelope. Arrays are wrapped into `{ providers }`;
 * envelopes pass through; void stays void.
 *
 * Exported so the kernel boot path and the backend addon registry can
 * share the same normalizer instead of duplicating the shim. Addons that
 * extend `BaseAddon` already emit the envelope, so this helper is only a
 * safety net for direct `ICamstackAddon` implementations (mostly tests).
 */
export function normalizeAddonInitResult(
  result: ProviderRegistration[] | AddonInitResult | void,
): AddonInitResult | void {
  if (result == null) return
  if (Array.isArray(result)) return { providers: result }
  return result
}
