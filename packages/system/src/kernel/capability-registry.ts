/**
 * CapabilityRegistry — auto-mounts tRPC routers from CapabilityDefinitions.
 *
 * Responsibilities:
 *   - Register/unregister providers for capabilities
 *   - Auto-create tRPC routers for each registered capability (via factory function)
 *   - Emit lifecycle events on the EventBus
 *   - Provide typed getProvider() for consumers
 *
 * Does NOT contain tRPC code directly — receives a router factory function
 * from the server layer (which owns @trpc/server).
 */

import type {
  CapabilityDeclaration,
  CapabilityDefinition,
  CapabilityInfo,
  CapabilityMode,
  CapabilityProviderMap,
  CollectionCapabilityMap,
  DeviceCall,
  DeviceCallAnswer,
  DeviceCallRedirect,
  IEventBus,
  IScopedLogger,
  SingletonCapabilityMap,
} from '@camstack/types'
import { redirectDeviceCalls } from './device-call-redirect.js'
import {
  overlayGetStatus,
  type StatusOverlay,
  type StatusOverlayAnswer,
  UNCLAIMED,
} from './status-overlay.js'

/** Result of creating a capability router (opaque to the kernel). */
export type CapabilityRouter = unknown

/** Factory that creates a tRPC router from a capability definition + provider getter. */
export type CapabilityRouterFactory = (
  definition: CapabilityDefinition,
  getProvider: () => unknown | null,
) => CapabilityRouter

/** Reader function that resolves user's singleton preference for a capability. */
export type ConfigReader = (capability: string) => string | undefined

/**
 * Reader function that resolves the persisted set of disabled addonIds for a
 * collection capability. Parallel to {@link ConfigReader} but for the
 * collection mode — returns the addonIds an operator has disabled so the
 * registry can restore them as disabled on a fresh boot. An empty array (or
 * `undefined`) means "nothing persisted, all providers enabled".
 *
 * Wired by the server layer in `addon-registry.service.ts` to read the same
 * `capabilities.collection.<cap>` ConfigService key the `capabilities` router
 * writes. Keeps the registry decoupled from `ConfigService` — exactly like
 * {@link ConfigReader} does for singletons.
 */
export type CollectionConfigReader = (capability: string) => readonly string[] | undefined

/**
 * Proof that an unregister owns the registration it is about to delete.
 *
 * A `(capability, addonId)` key is NOT unique over time: a runner replaced by
 * an update re-registers under the exact same key (`resolveRunnerId` is
 * deterministic), so the dead generation's teardown and the live generation's
 * registration are indistinguishable by key alone. The owner token names the
 * INCARNATION that made a registration — e.g. `hub/recorder#7` — and
 * {@link CapabilityRegistry.unregisterProvider} refuses any unregister that
 * cannot present it. See docs/decisions/adr-0188-an-unregister-carries-proof-of-ownership.md.
 */
export type ProviderOwnerToken = string

/** Per-capability registration state. */
interface CapabilityState {
  readonly definition: CapabilityDefinition
  /** addonId → provider instance */
  readonly providers: Map<string, unknown>
  /**
   * addonId → the owner token the registration declared, for the registrations
   * that declared one. Absent ⇒ an ownerless registration (in-process addons,
   * builtins): unregister behaves exactly as it always did.
   */
  readonly providerOwners: Map<string, ProviderOwnerToken>
  /** For singleton: the active addon ID */
  activeAddonId: string | null
  /** Auto-mounted tRPC router (created once, provider resolved lazily) */
  router: CapabilityRouter | null
  /** For collection: addon IDs that are registered but disabled */
  readonly disabledProviders: Set<string>
}

/**
 * Type-level bridge: the `providers` map stores heterogeneous capability
 * implementations as `unknown`. Callers resolve providers via a generic `T`
 * that reflects the capability interface they depend on. The runtime has
 * no way to validate this shape — it is the contract between the capability
 * declaration (`cap.spec.ts`) and its consumers. Documented irreducible
 * bridge, see `project_cast_elimination_checkpoint.md` pattern #7.
 */
function asProvider<T>(value: unknown): T {
  return value as T
}

/**
 * A parsed `status.schema` output is a record — every status schema is a
 * `z.object` (the `status` block's contract) — but `CapabilityStatusSchema`
 * types it as `ZodType<unknown>`, so the parsed value comes back `unknown`.
 * Narrowed structurally, never cast: a non-record output is answered `null`
 * ("not reported", D315), which is also what the aggregate does with it.
 */
function asStatusSlice(parsed: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const slice: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) slice[key] = value
  return slice
}

/** What {@link CapabilityRegistry.applyPersistedPreferences} changed. */
export interface PersistedPreferenceReplay {
  readonly singletons: ReadonlyArray<{ readonly capability: string; readonly addonId: string }>
  readonly disabled: ReadonlyArray<{ readonly capability: string; readonly addonId: string }>
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityState>()
  private readonly logger: IScopedLogger
  private readonly eventBus: IEventBus | null
  private routerFactory: CapabilityRouterFactory | null = null
  private configReader: ConfigReader | null = null
  private collectionConfigReader: CollectionConfigReader | null = null
  private _ready = false

  /** Boot-time dependency graph: capability → dependsOn names (from CapabilityDeclaration) */
  private readonly capabilityDeps = new Map<string, readonly string[]>()

  /**
   * capability → addon ids whose MANIFEST declares it.
   *
   * Populated by {@link declareFromManifest}, which runs at addon-LOAD time —
   * before a forked addon's runner has spawned, let alone registered anything.
   * So this map answers a question `providers` cannot: **which addons still owe
   * this capability a provider**, i.e. is an absence final or merely early.
   *
   * It is not a second registry and nothing waits on it: it stores an argument
   * `declareFromManifest` was already being handed and dropping, and it is read
   * synchronously at the moment a caller needs the answer ([D3](../../../../docs/decisions/adr-0003.md)).
   */
  private readonly manifestDeclarers = new Map<string, Set<string>>()

  /** Per-device singleton overrides: deviceId → (capability → addonId) */
  private readonly deviceOverrides = new Map<string, Map<string, string>>()

  /** capName → (nodeId → bare addonId) per-node singleton overrides. */
  private readonly singletonNodeOverrides = new Map<string, Map<string, string>>()
  /** Optional reader for persisted per-node overrides: (cap, nodeId) → addonId. */
  private nodeConfigReader: ((capability: string, nodeId: string) => string | undefined) | null =
    null

  /**
   * Per-device SOURCE deactivations: deviceId → (capability → disabled addon ids).
   *
   * The in-memory PROJECTION of the persisted wrapper activation
   * (`deviceBindings[deviceId][capName].disabledSourceAddonIds`, written by
   * `setWrapperActive`), and never an authority of its own —
   * [D556](../../../../docs/decisions/adr-0556-a-per-device-source-switch-is-the-wrapper-activation-and-the-registry-holds-only-its-projection.md).
   * Nothing but `device-source-activation.ts` writes it: the operator's verb
   * is `deviceManager.setWrapperActive`, and a second writable surface here is
   * exactly the two-authorities defect D62 exists for.
   *
   * A DENY list, not an allow list, and that is the deliberate answer to what
   * "unset" means: a source nobody has ruled out is a source. An untouched
   * camera keeps every provider it has today, and a provider that registers
   * after the operator's last toggle needs no second write to be seen.
   */

  /** autoActivate flags per (capability, addonId) — from addon manifests */
  private readonly autoActivateFlags = new Map<string, boolean>()

  /**
   * Per-device native providers: capName → deviceId (numeric) → { addonId, provider }.
   *
   * Backs `DeviceContext.registerNativeCap`. Lets device-driver addons
   * (OnvifCamera, RtspCamera, etc.) publish capability implementations
   * scoped to a single device; the device-proxy router resolves these by
   * `(capName, deviceId)` to dispatch incoming calls.
   *
   * Distinct from the `capabilities[].providers` map (system-wide providers
   * keyed by addonId) — native providers are device-instance-scoped and
   * never participate in singleton/collection resolution.
   */
  private readonly nativeProviders = new Map<
    string,
    Map<number, { addonId: string; provider: unknown }>
  >()

  /**
   * Wrapper provider registrations: capName → Set<addonId>. Tracked separately
   * from `capabilities[].providers` because wrappers aren't system-wide
   * providers — they're user-toggleable decorators addons declare via
   * `ProviderRegistration.kind === 'wrapper'`. Consumers query this map (via
   * `getWrappersForCap`) to render the "pick a wrapper for this device"
   * dropdown in the device-bindings UI.
   */
  private readonly wrapperProviders = new Map<string, Set<string>>()

  /**
   * Wrapper registrations that declared `ProviderRegistration.defaultActive:
   * true`. Keyed by `capName` and valued by `addonId` — the first wrapper
   * flagged default-active wins per cap. Consumed by `device-manager.getBindings`
   * to synthesise a wrapper binding when no explicit activation has been
   * persisted for a (device, cap) pair and no native provider exists either —
   * otherwise the default wrapper would sit dormant waiting for a manual
   * `setWrapperActive({active: true})` that never comes.
   */
  private readonly wrapperDefaults = new Map<string, string>()

  /**
   * Pending {@link waitForProvider} waiters, keyed by
   * `"${capabilityName}::${addonId}"`. Resolved by {@link registerProvider}
   * as soon as the matching pair is registered — the mechanism that replaces
   * the 100ms polling loop the device-management router used to run while
   * waiting for forked providers to finish announcing their Moleculer service.
   */
  private readonly pendingWaiters = new Map<
    string,
    Array<{
      resolve: (provider: unknown) => void
      timer: ReturnType<typeof setTimeout> | null
      heartbeat: ReturnType<typeof setInterval> | null
    }>
  >()

  /** Period for the "still waiting" log emitted by `waitForProvider`. */
  private static readonly WAIT_HEARTBEAT_INTERVAL_MS = 60_000

  constructor(logger: IScopedLogger, eventBus?: IEventBus) {
    this.logger = logger
    this.eventBus = eventBus ?? null
  }

  /** Set the config reader for singleton preference resolution. */
  setConfigReader(reader: ConfigReader): void {
    this.configReader = reader
  }

  /**
   * Set the config reader for collection-provider enable/disable persistence.
   * Consulted by {@link registerProvider} so a provider an operator disabled
   * in a previous session comes back disabled after a hub reboot.
   */
  setCollectionConfigReader(reader: CollectionConfigReader): void {
    this.collectionConfigReader = reader
  }

  /** Register boot-time dependency edges (from CapabilityDeclaration.dependsOn). */
  setDependencies(capabilityName: string, dependsOn: readonly string[]): void {
    this.capabilityDeps.set(capabilityName, dependsOn)
  }

  /** Set the router factory — called by the server layer once at boot. */
  setRouterFactory(factory: CapabilityRouterFactory): void {
    this.routerFactory = factory
  }

  /** Mark boot complete. Before this, getProvider() returns null. */
  ready(): void {
    this._ready = true
    this.logger.info('CapabilityRegistry ready', { meta: { count: this.capabilities.size } })
  }

  isReady(): boolean {
    return this._ready
  }

  // ── Registration ───────────────────────────────────────────────────

  /**
   * Declare a capability from its definition.
   * Creates the auto-mounted router (if factory is set).
   * Called during addon manifest loading, before providers are registered.
   */
  declareCapability(definition: CapabilityDefinition): void {
    if (this.capabilities.has(definition.name)) {
      this.logger.debug('Capability already declared — skipping', {
        meta: { capability: definition.name },
      })
      return
    }

    const state: CapabilityState = {
      definition,
      providers: new Map(),
      providerOwners: new Map(),
      activeAddonId: null,
      router: null,
      disabledProviders: new Set(),
    }

    // Auto-create the tRPC router if factory is available
    if (this.routerFactory) {
      state.router = this.routerFactory(definition, () => this.getProvider(definition.name))
      this.logger.debug('Auto-mounted router for capability', {
        meta: { capability: definition.name },
      })
    }

    this.capabilities.set(definition.name, state)
  }

  /**
   * Register manifest metadata (dependsOn + autoActivate) for a capability,
   * and — when the capability's definition declares `kind: 'wrapper'` —
   * register the addon as a wrapper provider.
   *
   * The capability MUST already be declared via `declareCapability` from
   * its full `CapabilityDefinition`. Behavioural metadata (`mode`, `kind`,
   * `defaultActive`) is owned exclusively by the cap definition — never
   * the manifest (D4, base-layer rework; mirrors the Session 5 A5 `mode`
   * consolidation). The manifest declaration carries only the cap name,
   * `dependsOn`, `autoActivate`, and `optional`.
   */
  declareFromManifest(declaration: CapabilityDeclaration, addonId?: string): void {
    if (declaration.dependsOn?.length) {
      this.capabilityDeps.set(declaration.name, declaration.dependsOn)
    }

    // Recorded BEFORE the early return below: a manifest that names a
    // capability the hub has no definition for still tells us the addon owes
    // one, and that is exactly the case a caller distinguishing "not yet" from
    // "never" must not lose.
    if (addonId !== undefined) {
      const declarers = this.manifestDeclarers.get(declaration.name)
      if (declarers) declarers.add(addonId)
      else this.manifestDeclarers.set(declaration.name, new Set([addonId]))
    }

    // Store autoActivate flag per (capability, addonId)
    if (addonId !== undefined && declaration.autoActivate !== undefined) {
      this.autoActivateFlags.set(`${declaration.name}/${addonId}`, declaration.autoActivate)
    }

    const state = this.capabilities.get(declaration.name)
    if (!state) {
      this.logger.warn(
        'Manifest references capability but no full CapabilityDefinition has been declared. Skipping manifest metadata.',
        { meta: { capability: declaration.name } },
      )
      return
    }

    // Wrapper registration is driven by the cap DEFINITION (`kind:'wrapper'`),
    // never the manifest. Critical for forked/isolated addons: the cap
    // definition ships with `@camstack/types` and is declared on the hub
    // at boot, so the hub knows the wrapper intent without trusting the
    // addon's manifest. This is what removes the bundle-merge bug class
    // that froze analytics for 9.7 days.
    if (addonId !== undefined && state.definition.kind === 'wrapper') {
      this.registerWrapper(declaration.name, addonId, {
        defaultActive: state.definition.defaultActive === true,
      })
    }

    this.logger.debug('Manifest metadata attached to capability', {
      tags: addonId !== undefined ? { addonId } : undefined,
      meta: { capability: declaration.name },
    })
  }

  /**
   * Register a provider for a capability.
   * For singleton: auto-activates if user-preferred or first registered.
   * For collection: adds to the collection.
   *
   * Phase 12 (settings redesign follow-up): throws if the same
   * `(capabilityName, addonId)` pair is registered more than once.
   * Previously the second call would silently replace the first via
   * `state.providers.set(addonId, provider)` — that was the root cause
   * of the "analysis-pipeline registered three times" bug observed in
   * the kernel cleanup log (`analytics` addon called `registerProvider`
   * twice plus the `analysis-pipeline` addon called it a third time).
   *
   * Double-register of the same pair is always a programmer error —
   * two legitimately different addons implementing the same cap keep
   * using different `addonId`s and the user picks one via `configReader`.
   *
   * `owner` (optional) stamps the registration with the incarnation that made
   * it — see {@link ProviderOwnerToken}. Once stamped, only an unregister
   * presenting the SAME token can delete it. Registration paths whose key is
   * reused across process generations (the UDS child manifest, the D3
   * `registerNode` handshake) MUST pass one; ownerless registrations keep the
   * historical unconditional behaviour.
   */
  registerProvider(
    capabilityName: string,
    addonId: string,
    provider: unknown,
    owner?: ProviderOwnerToken,
  ): void {
    let state = this.capabilities.get(capabilityName)
    if (!state) {
      // Auto-declare namespaced sub-capabilities (e.g. "pipeline-step:object-detection")
      // when the parent capability (e.g. "pipeline-step") is declared.
      const colonIdx = capabilityName.indexOf(':')
      if (colonIdx > 0) {
        const parentName = capabilityName.slice(0, colonIdx)
        const parentState = this.capabilities.get(parentName)
        if (parentState) {
          this.declareCapability({ ...parentState.definition, name: capabilityName })
          state = this.capabilities.get(capabilityName)
        }
      }
    }
    if (!state) {
      this.logger.warn('Cannot register provider for undeclared capability — declare it first', {
        meta: { capability: capabilityName },
      })
      return
    }

    if (state.providers.has(addonId)) {
      // Phase 12: surface the double-register instead of silently
      // swallowing it. Throws unconditionally — the caller must fix
      // the duplicate registerProvider call in its init path.
      throw new Error(
        `CapabilityRegistry: provider already registered for capability "${capabilityName}" by addon "${addonId}". ` +
          `Double-registering the same (capability, addonId) pair is a programmer error — check your addon's initialize() ` +
          `path for a duplicate registerProvider call.`,
      )
    }

    // Contract enforcement: capabilities declared with
    // `exposesDeviceSettings: true` automatically gain the three
    // `DeviceSettingsContribution` methods in their method surface
    // (via `expandCapMethods`). Every provider registered for such a
    // cap MUST implement all three — otherwise aggregator call sites
    // would need defensive `typeof` gates that silently skip the
    // broken provider, hiding the section from the aggregate. Fail
    // fast here instead so the bug surfaces the moment the addon
    // registers rather than the moment a user opens device-details.
    if (state.definition.exposesDeviceSettings) {
      const required = [
        'getDeviceSettingsContribution',
        'getDeviceLiveContribution',
        'applyDeviceSettingsPatch',
      ] as const
      const shape = provider as Record<string, unknown>
      const missing = required.filter((m) => typeof shape[m] !== 'function')
      if (missing.length > 0) {
        throw new Error(
          `CapabilityRegistry: provider "${addonId}" for capability "${capabilityName}" declares ` +
            `exposesDeviceSettings: true but is missing DeviceSettingsContribution method(s): ` +
            `${missing.join(', ')}. Implement them on the provider (or drop the flag from the cap def).`,
        )
      }
    }

    state.providers.set(addonId, provider)
    if (owner !== undefined) state.providerOwners.set(addonId, owner)

    if (state.definition.mode === 'singleton') {
      const userChoice = this.configReader?.(capabilityName)
      const preferred = state.definition.preferredProvider
      if (userChoice === addonId) {
        // 1. Operator preference always wins.
        state.activeAddonId = addonId
      } else if (userChoice === undefined) {
        // 2. No operator preference: honour the cap-declared default.
        if (preferred !== undefined) {
          if (addonId === preferred) {
            // The preferred provider deterministically wins — even if a
            // non-preferred provider already holds the active slot because
            // it registered earlier. Override it and notify observers via
            // the same path `setActiveSingleton` uses.
            if (state.activeAddonId !== null && state.activeAddonId !== addonId) {
              this.logger.info('Singleton active addon overridden by preferred provider', {
                tags: { addonId },
                meta: { capability: capabilityName, previous: state.activeAddonId },
              })
            }
            const changed = state.activeAddonId !== addonId
            state.activeAddonId = addonId
            if (changed) {
              // Intentional event asymmetry: `capability:singleton-changed` is
              // emitted ONLY when the preferred provider overrides an incumbent
              // (the semantically significant change observers care about). A
              // non-preferred provider taking the initially-empty slot below
              // does NOT emit — matching pre-existing register-time behaviour
              // where claiming an empty singleton slot is silent.
              this.emitEvent('capability:singleton-changed', {
                capability: capabilityName,
                addonId,
              })
            }
          } else if (state.activeAddonId === null) {
            // Non-preferred provider: serve until the preferred one registers,
            // then yield to it (the branch above overrides on its arrival).
            state.activeAddonId = addonId
          }
        } else if (state.activeAddonId === null) {
          // No declared default — legacy first-registered-wins.
          state.activeAddonId = addonId
        }
      }
      // 3. userChoice set but !== addonId → leave active untouched (operator
      //    chose a different provider).
    } else if (state.definition.mode === 'collection') {
      // Restore the operator's persisted enable/disable choice. Symmetric to
      // the singleton branch above: an addon disabled in a previous session
      // (e.g. a TURN/auth/export provider) must come back disabled rather
      // than silently re-enabling on the next reboot. Read through the
      // injected reader so the registry stays decoupled from ConfigService.
      const persistedDisabled = this.collectionConfigReader?.(capabilityName)
      if (persistedDisabled?.includes(addonId)) {
        state.disabledProviders.add(addonId)
      }
    }

    this.logger.info('Provider registered for capability', {
      tags: { addonId },
      meta: {
        capability: capabilityName,
        mode: state.definition.mode,
        ...(owner === undefined ? {} : { owner }),
      },
    })

    this.emitEvent('capability:provider-registered', {
      capability: capabilityName,
      addonId,
      mode: state.definition.mode,
    })

    // Fulfil any waitForProvider() calls targeting this exact pair. The
    // waiters captured the factory-proxy moment they were created; here we
    // hand them the live provider and cancel their timers. This is the
    // event-driven replacement for the 100ms polling loop that used to
    // live in `device-management.router.ts` (`[WAIT-EVENT]`).
    const waiterKey = `${capabilityName}::${addonId}`
    const waiters = this.pendingWaiters.get(waiterKey)
    if (waiters && waiters.length > 0) {
      this.pendingWaiters.delete(waiterKey)
      for (const waiter of waiters) {
        if (waiter.timer !== null) clearTimeout(waiter.timer)
        if (waiter.heartbeat !== null) clearInterval(waiter.heartbeat)
        waiter.resolve(provider)
      }
    }
  }

  /**
   * Whether a provider for the exact `(capabilityName, addonId)` pair is
   * currently registered. Lets a re-registration path (e.g. the agent's
   * in-place group-runner reload) make {@link registerProvider} idempotent by
   * dropping a stale prior registration first — `registerProvider` itself
   * throws on a duplicate pair (a deliberate guard against a duplicate
   * `registerProvider` call inside one init path), so callers that legitimately
   * re-register the same pair must unregister first.
   */
  hasProvider(capabilityName: string, addonId: string): boolean {
    return this.capabilities.get(capabilityName)?.providers.has(addonId) ?? false
  }

  /**
   * Addon ids whose manifest declares `capabilityName`, whether or not they
   * have registered a provider yet.
   *
   * Pair it with {@link hasProvider} to separate "this capability's collection
   * is still filling up" from "this is everything there will ever be" — the
   * difference between a 503 a client should retry and a 400 it should not.
   * Every entry is an addon INSTALLED on this node; an addon that is installed
   * but disabled therefore stays listed, which is the honest answer (the
   * capability is owed by something that is not going to supply it, and naming
   * it is the diagnosis).
   */
  getManifestDeclarers(capabilityName: string): readonly string[] {
    const declarers = this.manifestDeclarers.get(capabilityName)
    return declarers ? [...declarers] : []
  }

  /**
   * The owner token a registration declared, or `null` when the pair is not
   * registered or was registered without one.
   */
  getProviderOwner(capabilityName: string, addonId: string): ProviderOwnerToken | null {
    return this.capabilities.get(capabilityName)?.providerOwners.get(addonId) ?? null
  }

  /**
   * Hand an EXISTING registration to a new owner, without touching the provider
   * instance, the active-singleton selection or any event.
   *
   * The takeover case: a replacement runner handshakes with an UNCHANGED cap
   * set, so the manifest diff correctly leaves the registration alone — but the
   * registration is still stamped with the dead generation's token, and nothing
   * the LIVE generation can present would ever match it. Re-stamping keeps the
   * capability cleanable when the successor eventually dies.
   *
   * Returns `false` when the pair is not registered (nothing to hand over) —
   * the caller decides whether that is a register-instead or a diagnosis.
   */
  reassignProviderOwner(
    capabilityName: string,
    addonId: string,
    owner: ProviderOwnerToken,
  ): boolean {
    const state = this.capabilities.get(capabilityName)
    if (!state || !state.providers.has(addonId)) return false
    const previous = state.providerOwners.get(addonId)
    if (previous === owner) return true
    state.providerOwners.set(addonId, owner)
    this.logger.info('Capability registration ownership reassigned', {
      tags: { addonId },
      meta: { capability: capabilityName, owner, previousOwner: previous ?? null },
    })
    return true
  }

  /**
   * Unregister a provider. For singleton: clears active. For collection:
   * removes from list.
   *
   * `owner` is the caller's PROOF that it owns the registration it is deleting.
   * When the registration declared an owner (see {@link ProviderOwnerToken})
   * and the caller presents a different one — or none at all — this is a
   * logged no-op: the caller belongs to a generation that no longer holds the
   * key. This is what stops a dead runner's teardown from erasing its
   * successor's live registration ([D188](../../../../docs/decisions/adr-0188-an-unregister-carries-proof-of-ownership.md)).
   */
  unregisterProvider(capabilityName: string, addonId: string, owner?: ProviderOwnerToken): void {
    const state = this.capabilities.get(capabilityName)
    if (!state) return

    const registeredOwner = state.providerOwners.get(addonId)
    if (registeredOwner !== undefined && registeredOwner !== owner) {
      // A branch that DROPS work silently reads as "never happened" — and this
      // one used to drop a whole capability. It is loud on purpose.
      this.logger.info('Unregister ignored — registration is owned by another incarnation', {
        tags: { addonId },
        meta: { capability: capabilityName, registeredOwner, presentedOwner: owner ?? null },
      })
      return
    }

    state.providers.delete(addonId)
    state.providerOwners.delete(addonId)

    if (state.definition.mode === 'singleton' && state.activeAddonId === addonId) {
      // Promote a still-registered provider instead of leaving the
      // singleton cap dead. Removing the active provider while a viable
      // alternative is registered (e.g. uninstalling one `decoder`
      // addon while another remains) must NOT take the capability
      // offline. Mirror `registerProvider`'s selection: honour the
      // operator's `configReader` choice when that addon is still
      // present, otherwise fall back to the first remaining provider;
      // only `null` when none remain.
      const userChoice = this.configReader?.(capabilityName)
      const preferred = state.definition.preferredProvider
      if (userChoice !== undefined && state.providers.has(userChoice)) {
        // Operator choice wins when its provider is still registered.
        state.activeAddonId = userChoice
      } else if (preferred !== undefined && state.providers.has(preferred)) {
        // Re-apply the cap-declared default if it's still around. NOTE: this is
        // NOT gated on `userChoice === undefined` — when the operator's chosen
        // provider was the one just unregistered (`userChoice` is set but no
        // longer registered), preferred must still beat insertion-order
        // first-remaining. Precedence: operator-choice-if-registered →
        // preferred-if-registered → first-remaining → null.
        state.activeAddonId = preferred
      } else {
        const next = state.providers.keys().next()
        state.activeAddonId = next.done ? null : next.value
      }
      if (state.activeAddonId !== null) {
        this.logger.info('Singleton active provider promoted after removal', {
          tags: { addonId: state.activeAddonId },
          meta: { capability: capabilityName, removed: addonId },
        })
      }
    }

    // Drop per-node overrides that pointed at the unregistered addon.
    const bare = this.bareAddonId(addonId)
    const nodeMap = this.singletonNodeOverrides.get(capabilityName)
    if (nodeMap) {
      for (const [nodeId, ov] of Array.from(nodeMap)) {
        if (ov === bare) nodeMap.delete(nodeId)
      }
      if (nodeMap.size === 0) this.singletonNodeOverrides.delete(capabilityName)
    }

    this.logger.info('Provider unregistered from capability', {
      tags: { addonId },
      meta: { capability: capabilityName },
    })

    this.emitEvent('capability:provider-unregistered', {
      capability: capabilityName,
      addonId,
    })
  }

  // ── Collection Enable/Disable ─────────────────────────────────────

  /**
   * Re-apply the operator's PERSISTED preferences to providers that
   * registered before those preferences could be read — once, when the boot
   * read of them settles (D675).
   *
   * `registerProvider` consults the preference readers at the moment a
   * provider registers. With the settings engine isolated (D231) the
   * preferences arrive over an async door, so a provider can register before
   * they are known; the readers then answer "no preference" and the default
   * wins. This replays the answer the readers give NOW over every registered
   * provider: a singleton whose persisted choice is registered and not active
   * is switched to it, and a collection provider the operator disabled is
   * disabled again. It is one pass, triggered by the read settling — not a
   * wait, a poll or a retry (D3).
   *
   * `skip` names the capabilities that must not be switched live (infra caps
   * need a restart — the same rule `capabilities.setPreference` applies).
   */
  applyPersistedPreferences(skip: (capability: string) => boolean): PersistedPreferenceReplay {
    const singletons: Array<{ readonly capability: string; readonly addonId: string }> = []
    const disabled: Array<{ readonly capability: string; readonly addonId: string }> = []
    for (const [capability, state] of this.capabilities) {
      if (skip(capability)) continue
      if (state.definition.mode === 'singleton') {
        const choice = this.configReader?.(capability)
        if (choice === undefined || !state.providers.has(choice)) continue
        if (state.activeAddonId === choice) continue
        state.activeAddonId = choice
        singletons.push({ capability, addonId: choice })
        this.emitEvent('capability:singleton-changed', { capability, addonId: choice })
      } else if (state.definition.mode === 'collection') {
        for (const addonId of this.collectionConfigReader?.(capability) ?? []) {
          if (!state.providers.has(addonId) || state.disabledProviders.has(addonId)) continue
          state.disabledProviders.add(addonId)
          disabled.push({ capability, addonId })
          this.emitEvent('capability:collection-provider-disabled', { capability, addonId })
        }
      }
    }
    return { singletons, disabled }
  }

  /** Enable a previously disabled collection provider. */
  enableCollectionProvider(capability: string, addonId: string): void {
    const state = this.capabilities.get(capability)
    if (!state) {
      this.logger.warn('Cannot enable provider for undeclared capability', { meta: { capability } })
      return
    }
    if (state.definition.mode !== 'collection') {
      this.logger.warn('Cannot enable provider: capability is not a collection capability', {
        meta: { capability },
      })
      return
    }

    state.disabledProviders.delete(addonId)
    this.logger.info('Collection provider enabled', { tags: { addonId }, meta: { capability } })

    this.emitEvent('capability:collection-provider-enabled', {
      capability,
      addonId,
    })
  }

  /** Disable a collection provider (keeps it registered but excluded from active list). */
  disableCollectionProvider(capability: string, addonId: string): void {
    const state = this.capabilities.get(capability)
    if (!state) {
      this.logger.warn('Cannot disable provider for undeclared capability', {
        meta: { capability },
      })
      return
    }
    if (state.definition.mode !== 'collection') {
      this.logger.warn('Cannot disable provider: capability is not a collection capability', {
        meta: { capability },
      })
      return
    }

    state.disabledProviders.add(addonId)
    this.logger.info('Collection provider disabled', { tags: { addonId }, meta: { capability } })

    this.emitEvent('capability:collection-provider-disabled', {
      capability,
      addonId,
    })
  }

  // ── Per-Device Native Providers ───────────────────────────────────

  /**
   * Register a native capability provider scoped to a single device.
   * Throws if the same `(capName, deviceId)` is registered twice — that is
   * always a programmer error: device-driver addons must call
   * `DeviceContext.registerNativeCap` exactly once per cap per device.
   */
  registerNativeProvider(
    capName: string,
    deviceId: number,
    addonId: string,
    provider: unknown,
  ): void {
    let perCap = this.nativeProviders.get(capName)
    if (!perCap) {
      perCap = new Map()
      this.nativeProviders.set(capName, perCap)
    }
    if (perCap.has(deviceId)) {
      throw new Error(
        `native provider for capability '${capName}' on device '${deviceId}' already registered`,
      )
    }
    perCap.set(deviceId, { addonId, provider })
  }

  /** Remove a single native provider entry. No-op if absent. */
  unregisterNativeProvider(capName: string, deviceId: number): void {
    this.nativeProviders.get(capName)?.delete(deviceId)
  }

  /** Remove every native provider entry for a device — called on device removal. */
  unregisterAllNativeForDevice(deviceId: number): void {
    for (const perCap of this.nativeProviders.values()) {
      perCap.delete(deviceId)
    }
  }

  /** Fallback resolver for native providers that aren't registered in-process. */
  private nativeFallback: ((capName: string, deviceId: number) => unknown | null) | null = null

  /**
   * Install a fallback resolver for cross-process native caps. When a device's
   * live `IDevice` lives in a forked worker (e.g. `provider-rtsp`), the native
   * cap it published via `DeviceContext.registerNativeCap` is reachable over
   * the broker — but the hub's `nativeProviders` map never saw it. The fallback
   * is called by {@link getNativeProvider} on local-miss and is expected to
   * return a proxy object whose methods issue `broker.call` into the owning
   * worker. Set once at hub boot time.
   */
  setNativeFallback(resolver: (capName: string, deviceId: number) => unknown | null): void {
    this.nativeFallback = resolver
  }

  /**
   * Resolve the native provider for `(capName, deviceId)` or null. A CLAIMED
   * cap's provider is handed back with its `getStatus` overlaid (D663, S3) —
   * on the in-process branch AND the `nativeFallback` branch, which is the
   * path the HA feeder's devices take.
   */
  getNativeProvider<T = unknown>(capName: string, deviceId: number): T | null {
    const entry = this.nativeProviders.get(capName)?.get(deviceId)
    if (entry) return this.withOverlay(capName, deviceId, entry.provider as T)
    if (this.nativeFallback) {
      const fallback = this.nativeFallback(capName, deviceId)
      return this.withOverlay(capName, deviceId, (fallback ?? null) as T | null)
    }
    return null
  }

  // ── Claimed-status overlay (D663, S3) ──────────────────────────────────

  /** The device-manager's view over its mirror; `null` until installed. */
  private statusOverlay: StatusOverlay | null = null
  /** `(cap, device)` pairs whose merged slice currently fails its status schema — one warn per transition. */
  private readonly overlayParseFailing = new Set<string>()

  /**
   * Install (or remove, with `null`) the claimed-status overlay. Installed once
   * by the device-manager at init over its `DeviceStateMirror`; removed on its
   * shutdown. Wrappers already resolved re-read it at call time, so an
   * uninstall hands `getStatus` back to the native immediately.
   */
  setStatusOverlay(overlay: StatusOverlay | null): void {
    this.statusOverlay = overlay
    this.overlayParseFailing.clear()
  }

  /**
   * THE question every `getStatus` awaits before it is answered (the registry's
   * own wrappers at call time, and the three transport entries through
   * `answerClaimedGetStatus`). The overlay resolves the device's claims first;
   * `unknown` survives only when its row cannot be read, and the caller then
   * answers "not reported", never the native (D315, D49).
   *
   * A claimed slice is parsed with the cap's `status.schema` — S4 makes
   * `status ⊆ runtimeState`, so the merged runtime slice parses and a
   * runtime-only key such as `lastFetchedAt` is stripped. A slice that does not
   * parse is `null`, logged once per `(cap, device)` transition with the device
   * tag; a held claim is `null` without a parse. A cap with no `status` block
   * passes its merged slice through as is.
   */
  async resolveClaimedStatus(capName: string, deviceId: number): Promise<StatusOverlayAnswer> {
    if (this.statusOverlay === null) return UNCLAIMED
    return this.parseClaimed(capName, deviceId, await this.statusOverlay.resolve(capName, deviceId))
  }

  private parseClaimed(
    capName: string,
    deviceId: number,
    answer: StatusOverlayAnswer,
  ): StatusOverlayAnswer {
    if (answer.kind !== 'claimed' || answer.slice === null) return answer
    const schema = this.getDefinition(capName)?.status?.schema
    if (schema === undefined) return answer
    const key = `${capName}:${deviceId}`
    const parsed = schema.safeParse(answer.slice)
    if (parsed.success) {
      this.overlayParseFailing.delete(key)
      // The status schemas are `z.object`s over records: the parsed value is
      // the same record shape with unknown keys stripped.
      return { kind: 'claimed', slice: asStatusSlice(parsed.data) }
    }
    if (!this.overlayParseFailing.has(key)) {
      this.overlayParseFailing.add(key)
      this.logger.warn('claimed cap: merged slice fails its status schema — answering null', {
        tags: { deviceId },
        meta: { capName, issues: parsed.error.issues.slice(0, 3) },
      })
    }
    return { kind: 'claimed', slice: null }
  }

  /**
   * Hand `provider` back untouched when `(capName, deviceId)` is KNOWN to be
   * unclaimed; otherwise wrap it so `getStatus` awaits `resolveClaimedStatus`
   * (re-read at call time — the parse, and for an unknown device the row read,
   * happen only when `getStatus` is actually called) and everything else stays
   * the provider's own. An unclaimed device pays one in-memory lookup; with no
   * overlay installed it pays nothing.
   */
  private withOverlay<T>(capName: string, deviceId: number, provider: T): T {
    return this.withRedirect(capName, deviceId, this.withClaims(capName, deviceId, provider))
  }

  private withClaims<T>(capName: string, deviceId: number, provider: T): T {
    if (this.statusOverlay === null) return provider
    if (typeof provider !== 'object' || provider === null) return provider
    if (this.statusOverlay.peek(capName, deviceId).kind === 'unclaimed') return provider
    return overlayGetStatus(provider, () => this.resolveClaimedStatus(capName, deviceId))
  }

  // ── Device-call redirect (D963) ────────────────────────────────────────

  private deviceCallRedirect: DeviceCallRedirect | null = null

  /**
   * Install (or remove, with `null`) the device-call redirect. Installed by
   * core-blocks over the remote; wrappers already resolved re-read it at call
   * time, so a removal hands every covered method back to the provider.
   */
  setDeviceCallRedirect(redirect: DeviceCallRedirect | null): void {
    this.deviceCallRedirect = redirect
  }

  /** Cheap and synchronous, so an entry asks it BEFORE it decodes any args. */
  coversDeviceCall(capName: string, method: string): boolean {
    return this.deviceCallRedirect?.covers(capName, method) === true
  }

  /**
   * THE question every name-resolving entry asks before routing a device-scoped
   * call (the registry's own wrappers at call time, the three transport
   * entries through `answerDeviceCallRedirect`). `not-redirected` when no
   * redirect is installed or it does not cover the method.
   */
  async redirectDeviceCall(call: DeviceCall): Promise<DeviceCallAnswer> {
    const redirect = this.deviceCallRedirect
    if (redirect === null || !redirect.covers(call.capName, call.method)) {
      return { kind: 'not-redirected' }
    }
    return redirect.attempt(call)
  }

  private withRedirect<T>(capName: string, deviceId: number, provider: T): T {
    if (this.deviceCallRedirect === null) return provider
    if (typeof provider !== 'object' || provider === null) return provider
    return redirectDeviceCalls(provider, capName, deviceId, {
      covers: (method) => this.deviceCallRedirect?.covers(capName, method) === true,
      attempt: (call) => this.redirectDeviceCall(call),
    })
  }

  /** Resolve the addonId that registered the native provider for `(capName, deviceId)`. */
  getNativeAddonId(capName: string, deviceId: number): string | null {
    return this.nativeProviders.get(capName)?.get(deviceId)?.addonId ?? null
  }

  /** List the capability names for which this device has a native provider registered. */
  getNativeCapsForDevice(deviceId: number): readonly string[] {
    const caps: string[] = []
    for (const [capName, perCap] of this.nativeProviders) {
      if (perCap.has(deviceId)) caps.push(capName)
    }
    return caps
  }

  // ── Wrapper Providers ─────────────────────────────────────────────

  /**
   * Mark `addonId` as providing a wrapper implementation for `capName`. Called
   * by `declareFromManifest` when the capability's `CapabilityDefinition` declares
   * `kind: 'wrapper'` (D4 — the cap definition is the single source of truth for wrapper behaviour).
   * Idempotent — re-registration keeps a single entry.
   */
  registerWrapper(capName: string, addonId: string, opts?: { defaultActive?: boolean }): void {
    let set = this.wrapperProviders.get(capName)
    if (!set) {
      set = new Set()
      this.wrapperProviders.set(capName, set)
    }
    set.add(addonId)
    if (opts?.defaultActive && !this.wrapperDefaults.has(capName)) {
      this.wrapperDefaults.set(capName, addonId)
    }
  }

  /** Remove a wrapper registration. No-op if absent. */
  unregisterWrapper(capName: string, addonId: string): void {
    const set = this.wrapperProviders.get(capName)
    if (!set) return
    set.delete(addonId)
    if (set.size === 0) this.wrapperProviders.delete(capName)
    if (this.wrapperDefaults.get(capName) === addonId) {
      this.wrapperDefaults.delete(capName)
    }
  }

  /** Remove every wrapper registration owned by `addonId`. Called on addon stop. */
  unregisterAllWrappersForAddon(addonId: string): void {
    for (const [capName, set] of this.wrapperProviders) {
      set.delete(addonId)
      if (set.size === 0) this.wrapperProviders.delete(capName)
    }
    for (const [capName, defaultAddonId] of this.wrapperDefaults) {
      if (defaultAddonId === addonId) this.wrapperDefaults.delete(capName)
    }
  }

  /** Return the addon ids that declared a wrapper for `capName`. */
  getWrappersForCap(capName: string): readonly string[] {
    return [...(this.wrapperProviders.get(capName) ?? [])]
  }

  /**
   * Return the wrapper addon flagged `defaultActive: true` for `capName`, or
   * null when no wrapper declared itself the default. Used by
   * `device-manager.getBindings` to auto-bind default wrappers on devices
   * without an explicit user activation.
   */
  getDefaultWrapperForCap(capName: string): string | null {
    return this.wrapperDefaults.get(capName) ?? null
  }

  /** List capability names that have at least one wrapper flagged `defaultActive: true`. */
  getCapsWithDefaultWrapper(): readonly string[] {
    return [...this.wrapperDefaults.keys()]
  }

  // ── Consumer Access ────────────────────────────────────────────────

  /**
   * Get the active provider for a singleton capability.
   *
   * When called with a declared capability name (a key of
   * `CapabilityProviderMap`), the return type is inferred automatically —
   * no caller-side casts needed. Arbitrary string names fall back to
   * `unknown`.
   */
  getProvider<K extends keyof CapabilityProviderMap>(
    capabilityName: K,
  ): CapabilityProviderMap[K] | null
  getProvider(capabilityName: string): unknown | null
  getProvider(capabilityName: string): unknown | null {
    if (!this._ready) return null

    const state = this.capabilities.get(capabilityName)
    if (!state) return null

    if (state.definition.mode === 'singleton') {
      return state.activeAddonId ? (state.providers.get(state.activeAddonId) ?? null) : null
    }

    // For collection, return the first provider (or null)
    const first = state.providers.values().next()
    return first.done ? null : first.value
  }

  /**
   * Unified per-device resolver (D13). Resolves a `(cap, device)` pair to
   * its provider transparently — native (per-device) first, then a
   * device-bound system provider. Callers no longer branch on
   * `kind: 'native' | 'wrapped'`; `kind` is metadata on the binding only.
   *
   * Resolution order:
   * 1. Native provider registered for the exact `(capName, deviceId)` pair.
   * 2. System provider: for singleton caps, honours per-device overrides and
   *    activation via `resolveForDevice`; for collection caps, returns the
   *    first registered provider.
   * 3. `null` when neither exists.
   */
  getProviderForDevice<T = unknown>(capName: string, deviceId: number): T | null {
    const native = this.getNativeProvider<T>(capName, deviceId)
    if (native !== null) return native

    const state = this.capabilities.get(capName)
    if (!state) return null

    // A claimed cap is claimed whoever serves it: the device-bound system
    // provider (a wrapper) is overlaid exactly like a native (D663, S3).
    if (state.definition.mode === 'singleton') {
      return this.withOverlay(
        capName,
        deviceId,
        this.resolveForDevice<T>(capName, String(deviceId)),
      )
    }

    // Collection: return the first enabled provider
    const first = state.providers.values().next()
    return first.done ? null : this.withOverlay(capName, deviceId, asProvider<T>(first.value))
  }

  /** Get all providers for a collection capability. */
  getAllProviders<K extends keyof CapabilityProviderMap>(
    capabilityName: K,
  ): readonly CapabilityProviderMap[K][]
  getAllProviders(capabilityName: string): readonly unknown[]
  getAllProviders(capabilityName: string): readonly unknown[] {
    if (!this._ready) return []

    const state = this.capabilities.get(capabilityName)
    if (!state) return []

    return [...state.providers.values()]
  }

  /** Get provider by addon ID (for per-device resolution). */
  getProviderByAddon<K extends keyof CapabilityProviderMap>(
    capabilityName: K,
    addonId: string,
  ): CapabilityProviderMap[K] | null
  getProviderByAddon<T = unknown>(capabilityName: string, addonId: string): T | null
  getProviderByAddon(capabilityName: string, addonId: string): unknown | null {
    const state = this.capabilities.get(capabilityName)
    return state?.providers.get(addonId) ?? null
  }

  /**
   * Wait for a specific `(capabilityName, addonId)` provider to become
   * available, up to `timeoutMs`. Resolves synchronously with the live
   * provider if it is already registered; otherwise queues a waiter that
   * {@link registerProvider} fulfils as soon as the matching pair shows up.
   * Resolves to `null` on timeout instead of rejecting — the caller
   * ({@link device-management.router}) already branches on `null` to return
   * a user-facing "provider not available" error.
   *
   * Replaces the 100ms polling loop from the post-settings-redesign
   * `waitForDeviceProvider` helper. On the happy path there is zero
   * overhead and zero behavioural change; on the race path the wait
   * unblocks on the next `registerProvider` call without any intermediate
   * sleeps. See `[WAIT-EVENT]` in the 2026-04-12 handover.
   */
  waitForProvider<K extends keyof CapabilityProviderMap>(
    capabilityName: K,
    addonId: string,
    timeoutMs: number,
  ): Promise<CapabilityProviderMap[K] | null>
  waitForProvider(
    capabilityName: string,
    addonId: string,
    timeoutMs: number,
  ): Promise<unknown | null>
  waitForProvider(
    capabilityName: string,
    addonId: string,
    timeoutMs: number,
  ): Promise<unknown | null> {
    const immediate = this.getProviderByAddon(capabilityName, addonId)
    if (immediate) return Promise.resolve(immediate)

    return new Promise((resolve) => {
      const waiterKey = `${capabilityName}::${addonId}`
      const queue = this.pendingWaiters.get(waiterKey) ?? []

      // `timeoutMs === Infinity` (or non-finite) ⇒ wait forever. Callers like
      // `restartAddon` need this because a slow group-runner respawn (CLI
      // probe, native module load, etc.) can legitimately take more than any
      // arbitrary upper bound, and surfacing a timeout error when the
      // restart will succeed in another few seconds is worse than waiting.
      // The waiter is still removed when `registerProvider` fulfils it.
      const useTimer = Number.isFinite(timeoutMs)
      const timer = useTimer
        ? setTimeout(() => {
            // Remove this waiter from the pending queue so we don't leak it
            // into the next registerProvider() call.
            const current = this.pendingWaiters.get(waiterKey)
            if (current) {
              const idx = current.findIndex((w) => w.timer === timer)
              if (idx >= 0) {
                const removed = current[idx]
                if (removed && removed.heartbeat !== null) clearInterval(removed.heartbeat)
                current.splice(idx, 1)
              }
              if (current.length === 0) this.pendingWaiters.delete(waiterKey)
            }
            resolve(null)
          }, timeoutMs)
        : null

      // Heartbeat: every 60s log that we're still waiting, so an operator
      // looking at server output during a slow respawn (e.g. a forked addon
      // whose CLI probe takes minutes) sees clear progress rather than
      // silence. Counts elapsed seconds in the message so the log line is
      // immediately diagnosable. The timer is cleared in `registerProvider`
      // (success path) and in the timeout branch above.
      const startedAt = Date.now()
      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        this.logger.warn(
          `Still waiting for capability "${capabilityName}" from addon "${addonId}" (${elapsed}s)`,
          { tags: { addonId } },
        )
      }, CapabilityRegistry.WAIT_HEARTBEAT_INTERVAL_MS)

      queue.push({ resolve, timer, heartbeat })
      this.pendingWaiters.set(waiterKey, queue)
    })
  }

  // ── Typed Accessors (CapabilityService compat) ─────────────────────

  /**
   * Get the active singleton provider for a capability.
   *
   * Declared capability names resolve to their typed provider via
   * `SingletonCapabilityMap` — a cap declared as `collection` in its
   * `.cap.ts` definition is rejected at the type level. Arbitrary strings
   * (non-declared capabilities) fall back to the caller-provided `T`
   * (default `unknown`) through the second overload for compatibility
   * with downstream packages that extend `CapabilityProviderMap` via
   * declaration merging.
   *
   * Hard-typed narrowing via `SingletonCapabilityMap` was introduced in
   * session 5 Sprint A5 — see audit addendum finding R6.
   */
  getSingleton<K extends keyof SingletonCapabilityMap>(
    capability: K,
  ): SingletonCapabilityMap[K] | null
  getSingleton<T = unknown>(capability: string): T | null
  getSingleton(capability: string): unknown | null {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'singleton') return null
    if (!state.activeAddonId) return null
    return state.providers.get(state.activeAddonId) ?? null
  }

  /** Get the addon ID of the active singleton provider. */
  getSingletonAddonId(capability: string): string | null {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'singleton') return null
    return state.activeAddonId
  }

  /**
   * Override the active addon for a singleton capability. Called by the
   * pipeline-orchestrator binding system so future `getSingleton(cap)`
   * lookups return the addon the operator explicitly selected. If
   * `addonId` is `null` or no provider is registered under that id,
   * falls back to the cap-declared `preferredProvider` (when registered),
   * otherwise the first-registered provider (legacy behaviour).
   *
   * This helper is an internal hook for the UDS-preference race (it does
   * NOT read `configReader` — the operator's persisted choice is applied
   * by `registerProvider`/`unregisterProvider`). For consistency with those
   * paths the fallback still honours `preferredProvider` ahead of
   * insertion-order first-remaining.
   *
   * No-op when the capability isn't declared, isn't a singleton, or the
   * requested addon hasn't registered a provider for it yet.
   */
  setSingletonActiveAddon(capability: string, addonId: string | null): void {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'singleton') return
    if (addonId && state.providers.has(addonId)) {
      state.activeAddonId = addonId
      this.logger.info('Capability active addon overridden', {
        tags: { addonId },
        meta: { capability },
      })
      return
    }
    // Fallback: cap-declared preferred (if still registered) → first-registered.
    const preferred = state.definition.preferredProvider
    if (preferred !== undefined && state.providers.has(preferred)) {
      state.activeAddonId = preferred
    } else {
      const first = state.providers.keys().next()
      state.activeAddonId = first.done ? null : first.value
    }
    if (addonId && !state.providers.has(addonId)) {
      this.logger.warn(
        'setSingletonActiveAddon: addon has not registered a provider, falling back',
        { tags: { addonId }, meta: { capability, fallbackAddonId: state.activeAddonId ?? null } },
      )
    }
  }

  /**
   * Get all active collection providers for a capability.
   *
   * Declared capability names resolve to their typed provider via
   * `CollectionCapabilityMap` — a cap declared as `singleton` in its
   * `.cap.ts` definition is rejected at the type level. Arbitrary strings
   * fall back to the caller-provided `T` (default `unknown`) for
   * compatibility with declaration-merged extensions.
   */
  getCollection<K extends keyof CollectionCapabilityMap>(
    capability: K,
  ): readonly CollectionCapabilityMap[K][]
  getCollection<T = unknown>(capability: string): readonly T[]
  getCollection(capability: string): readonly unknown[] {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'collection') return []
    return [...state.providers.entries()]
      .filter(([addonId]) => !state.disabledProviders.has(addonId))
      .map(([, provider]) => provider)
  }

  /**
   * Like {@link getCollection} but returns `[addonId, provider]` tuples so
   * callers can attribute work back to the contributing addon.
   *
   * Needed by the device-settings aggregator (`device-manager.addon.ts`) —
   * each contributed field must carry the writer's `addonId` so the
   * `deviceManager.updateDeviceField` mutation can route the write to the
   * correct addon-settings store without hardcoding any addon identity.
   */
  getCollectionEntries<K extends keyof CollectionCapabilityMap>(
    capability: K,
  ): readonly (readonly [string, CollectionCapabilityMap[K]])[]
  getCollectionEntries<T = unknown>(capability: string): readonly (readonly [string, T])[]
  getCollectionEntries(capability: string): readonly (readonly [string, unknown])[] {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'collection') return []
    return [...state.providers.entries()].filter(
      ([addonId]) => !state.disabledProviders.has(addonId),
    )
  }

  /**
   * Is `addonId` currently DISABLED as a provider of `capability`?
   *
   * Exposed because the disabled set was write-only for `log-destination`:
   * the orchestrator toggle added the addon here and nothing ever read it, so
   * console and winston could not be turned off at all while the UI badge said
   * they were (audit 2026-07-30).
   */
  isProviderDisabled(capability: string, addonId: string): boolean {
    return this.capabilities.get(capability)?.disabledProviders.has(addonId) === true
  }

  /** Get the full CapabilityDefinition for a declared capability. */
  getDefinition(capability: string): CapabilityDefinition | undefined {
    return this.capabilities.get(capability)?.definition
  }

  /** Get the mode declared for a capability. */
  getMode(capability: string): CapabilityMode | undefined {
    return this.capabilities.get(capability)?.definition.mode
  }

  /** Get a specific addon's provider by addon ID. */
  getProviderByAddonId<K extends keyof CapabilityProviderMap>(
    capability: K,
    addonId: string,
  ): CapabilityProviderMap[K] | null
  getProviderByAddonId<T = unknown>(capability: string, addonId: string): T | null
  getProviderByAddonId(capability: string, addonId: string): unknown | null {
    const state = this.capabilities.get(capability)
    if (!state) return null
    return state.providers.get(addonId) ?? null
  }

  /**
   * Every registry KEY currently registered for `capability`, disabled ones
   * included — i.e. exactly the ids {@link getProviderByAddonId} can resolve.
   * Keys are bare (`homeassistant-export`) for hub-local providers and
   * `<addonId>@<nodeId>` for providers that registered from another node.
   *
   * Exists so an unresolvable `{ addonId }` pin can REFUSE with the valid ids
   * spelled out (the `addons.custom` unknown-id posture) instead of silently
   * degrading to another provider's answer — a fabricated `addonId` used to
   * return the first-registered provider's status, indistinguishable from
   * success (2026-08-09).
   */
  getProviderAddonIds(capability: string): readonly string[] {
    const state = this.capabilities.get(capability)
    if (!state) return []
    return [...state.providers.keys()]
  }

  // ── Per-node singleton helpers ─────────────────────────────────────

  /** Bare addonId from a registry key (`webrtc-native@dev-agent-0` → `webrtc-native`). */
  private bareAddonId(key: string): string {
    const at = key.indexOf('@')
    return at === -1 ? key : key.slice(0, at)
  }

  /** nodeId a provider key belongs to (bare → 'hub', `@node` → node). */
  private nodeOfKey(key: string): string {
    const at = key.indexOf('@')
    return at === -1 ? 'hub' : key.slice(at + 1)
  }

  /** capName → (nodeId → bare addonId[]) availability derived from provider keys. */
  getProvidersByNode(capability: string): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const state = this.capabilities.get(capability)
    if (!state) return out
    for (const key of state.providers.keys()) {
      const node = this.nodeOfKey(key)
      const addon = this.bareAddonId(key)
      const list = out.get(node) ?? []
      if (!list.includes(addon)) list.push(addon)
      out.set(node, list)
    }
    return out
  }

  /**
   * Resolve the BARE addon id a node should use for a singleton cap.
   * Chain: per-node override → cluster-global default → first available.
   * Returns null when the node hosts no provider for the cap.
   */
  resolveSingletonAddonIdForNode(capability: string, nodeId: string): string | null {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'singleton') return null
    const avail = this.getProvidersByNode(capability).get(nodeId) ?? []
    if (avail.length === 0) return null
    const override =
      this.singletonNodeOverrides.get(capability)?.get(nodeId) ??
      this.nodeConfigReader?.(capability, nodeId)
    if (override && avail.includes(override)) return override
    if (state.activeAddonId) {
      const g = this.bareAddonId(state.activeAddonId)
      if (avail.includes(g)) return g
    }
    return avail[0] ?? null
  }

  /** Resolve the in-process provider object for a node (hub-local only). */
  getSingletonForNode<T = unknown>(capability: string, nodeId: string): T | null {
    const addonId = this.resolveSingletonAddonIdForNode(capability, nodeId)
    if (!addonId) return null
    const state = this.capabilities.get(capability)
    // Hub-local providers are keyed bare; remote providers have no in-process object.
    const provider = state?.providers.get(addonId)
    return provider !== undefined ? asProvider<T>(provider) : null
  }

  /** Per-node override accessor (for listCapabilities + tests). */
  getSingletonNodeOverrides(capability: string): Map<string, string> {
    return new Map(this.singletonNodeOverrides.get(capability) ?? [])
  }

  /** Set the reader for persisted per-node overrides (boot restore). */
  setNodeConfigReader(reader: (capability: string, nodeId: string) => string | undefined): void {
    this.nodeConfigReader = reader
  }

  /** Clear a per-node override (UI "inherit global"). */
  clearSingletonNodeOverride(capability: string, nodeId: string): void {
    const m = this.singletonNodeOverrides.get(capability)
    if (!m) return
    m.delete(nodeId)
    if (m.size === 0) this.singletonNodeOverrides.delete(capability)
    this.logger.info('Singleton node override cleared', { tags: { nodeId }, meta: { capability } })
  }

  /**
   * Set which addon should be the active singleton for a capability.
   * Pass an optional `nodeId` to set a per-node override instead of the cluster-global default.
   */
  async setActiveSingleton(capability: string, addonId: string, nodeId?: string): Promise<void> {
    const state = this.capabilities.get(capability)
    if (!state) {
      throw new Error(`Unknown capability: ${capability}`)
    }
    if (state.definition.mode !== 'singleton') {
      throw new Error(`Capability "${capability}" is not a singleton`)
    }

    if (nodeId !== undefined) {
      const avail = this.getProvidersByNode(capability).get(nodeId) ?? []
      if (!avail.includes(addonId)) {
        throw new Error(
          `Provider "${addonId}" is not available on node "${nodeId}" for "${capability}"`,
        )
      }
      let m = this.singletonNodeOverrides.get(capability)
      if (!m) {
        m = new Map()
        this.singletonNodeOverrides.set(capability, m)
      }
      m.set(nodeId, addonId)
      this.logger.info('Singleton node override set', {
        tags: { addonId, nodeId },
        meta: { capability },
      })
      this.emitEvent('capability:singleton-changed', { capability, addonId, nodeId })
      return
    }

    if (!state.providers.has(addonId)) {
      throw new Error(`No provider "${addonId}" registered for capability "${capability}"`)
    }
    state.activeAddonId = addonId
    this.logger.info('Singleton preference set', { tags: { addonId }, meta: { capability } })

    this.emitEvent('capability:singleton-changed', {
      capability,
      addonId,
    })
  }

  // ── Activation ────────────────────────────────────────────────────

  /**
   * Check if a specific addon's capability is active.
   *
   * Resolution: the manifest's `autoActivate` flag, else active. There is no
   * persisted override layer — see D334: an activation map keyed by
   * `{capability}/{addonId}` is a second authority over a function some addon
   * already owns, which is what D62 forbids.
   */
  isActiveForSystem(capability: string, addonId: string): boolean {
    const autoActivate = this.autoActivateFlags.get(`${capability}/${addonId}`)
    if (autoActivate !== undefined) {
      return autoActivate
    }
    return true
  }

  /**
   * Get all addon/capability activations at system level.
   * Returns every registered provider with its resolved active status.
   */
  getSystemActivations(): ReadonlyArray<{ capability: string; addonId: string; active: boolean }> {
    const result: Array<{ capability: string; addonId: string; active: boolean }> = []
    for (const [capName, state] of this.capabilities) {
      for (const addonId of state.providers.keys()) {
        result.push({
          capability: capName,
          addonId,
          active: this.isActiveForSystem(capName, addonId),
        })
      }
    }
    return result
  }

  // ── Per-Device Overrides ──────────────────────────────────────────

  /** Set a per-device singleton override. */
  setDeviceOverride(deviceId: string, capability: string, addonId: string): void {
    const state = this.capabilities.get(capability)
    if (!state) {
      this.logger.warn('Cannot set device override for undeclared capability', {
        meta: { capability },
      })
      return
    }
    if (!state.providers.has(addonId)) {
      this.logger.warn('Cannot set device override: addon not registered for capability', {
        tags: { addonId },
        meta: { capability },
      })
      return
    }

    let deviceMap = this.deviceOverrides.get(deviceId)
    if (!deviceMap) {
      deviceMap = new Map()
      this.deviceOverrides.set(deviceId, deviceMap)
    }
    deviceMap.set(capability, addonId)
    this.logger.info('Device override set', {
      tags: { deviceId: Number(deviceId), addonId },
      meta: { capability },
    })
  }

  /** Clear a per-device singleton override. */
  clearDeviceOverride(deviceId: string, capability: string): void {
    const deviceMap = this.deviceOverrides.get(deviceId)
    if (!deviceMap) return
    deviceMap.delete(capability)
    if (deviceMap.size === 0) {
      this.deviceOverrides.delete(deviceId)
    }
    this.logger.info('Device override cleared', {
      tags: { deviceId: Number(deviceId) },
      meta: { capability },
    })
  }

  /** Get all per-device singleton overrides for a device. */
  getDeviceOverrides(deviceId: string): Map<string, string> {
    return new Map(this.deviceOverrides.get(deviceId) ?? [])
  }

  /**
   * Resolve a singleton provider for a specific device.
   * Checks activation (the manifest's autoActivate) then the per-device
   * singleton override — the in-memory provider pin, not a persisted flag.
   */
  resolveForDevice<T = unknown>(capability: string, deviceId: string): T | null {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'singleton') return null

    // Check per-device singleton override first
    const deviceMap = this.deviceOverrides.get(deviceId)
    if (deviceMap) {
      const overrideAddonId = deviceMap.get(capability)
      if (overrideAddonId) {
        if (this.isActiveForSystem(capability, overrideAddonId)) {
          const provider = state.providers.get(overrideAddonId)
          if (provider) return asProvider<T>(provider)
        }
        this.logger.warn('Device override inactive or unregistered, falling back to global', {
          tags: { deviceId: Number(deviceId), addonId: overrideAddonId },
          meta: { capability },
        })
      }
    }

    // Fall back to global singleton, if active for this device
    if (state.activeAddonId && this.isActiveForSystem(capability, state.activeAddonId)) {
      const active = state.providers.get(state.activeAddonId)
      return active !== undefined ? asProvider<T>(active) : null
    }

    // Try any registered provider that is active for this device
    for (const [addonId, provider] of state.providers) {
      if (this.isActiveForSystem(capability, addonId)) {
        return asProvider<T>(provider)
      }
    }

    return null
  }

  /**
   * Resolve collection providers for a specific device.
   *
   * Filters by activation (the manifest's autoActivate) and by nothing else.
   * The per-device DENY set that used to filter here is gone with the switch
   * it projected (2026-09-20): *"tutti i providers funzionano sempre"* [all the providers always work]. WHICH
   * providers a device has is now answered by its BINDINGS
   * (`device-bindings-store.ts` step 0), which is a different question from
   * which of them are registered and running — this one.
   *
   * `deviceId` is kept in the signature and deliberately unused: the resolution
   * is per-device by CONTRACT, and a caller that stops passing one is a caller
   * that has stopped asking about a device.
   */
  resolveCollectionForDevice<T = unknown>(capability: string, _deviceId: string): readonly T[] {
    const state = this.capabilities.get(capability)
    if (!state || state.definition.mode !== 'collection') return []
    const entries = [...state.providers.entries()]
      .filter(([addonId]) => !state.disabledProviders.has(addonId))
      .filter(([addonId]) => this.isActiveForSystem(capability, addonId))
    return entries.map(([, provider]) => asProvider<T>(provider))
  }

  // ── Boot Ordering ─────────────────────────────────────────────────

  /** Check if all dependencies for a capability are satisfied. */
  areDependenciesMet(capabilityName: string): boolean {
    const deps = this.capabilityDeps.get(capabilityName)
    if (!deps?.length) return true
    return deps.every((dep) => this.isAvailable(dep))
  }

  /** Get topologically sorted boot order based on dependsOn. */
  getBootOrder(): string[] {
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const order: string[] = []

    const visit = (name: string): void => {
      if (visited.has(name)) return
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving capability "${name}"`)
      }

      visiting.add(name)
      const deps = this.capabilityDeps.get(name)
      if (deps) {
        for (const dep of deps) {
          visit(dep)
        }
      }
      visiting.delete(name)
      visited.add(name)
      order.push(name)
    }

    for (const name of this.capabilities.keys()) {
      visit(name)
    }

    return order
  }

  // ── Router Access ──────────────────────────────────────────────────

  /** Get all auto-mounted routers. Key = capability name. */
  getMountedRouters(): ReadonlyMap<string, CapabilityRouter> {
    const routers = new Map<string, CapabilityRouter>()
    for (const [name, state] of this.capabilities) {
      if (state.router) {
        routers.set(name, state.router)
      }
    }
    return routers
  }

  /** Get a single mounted router by capability name. */
  getRouter(capabilityName: string): CapabilityRouter | null {
    return this.capabilities.get(capabilityName)?.router ?? null
  }

  // ── Introspection ──────────────────────────────────────────────────

  /** List all declared capabilities (v1-compatible shape). */
  listCapabilities(): CapabilityInfo[] {
    return [...this.capabilities.values()].map((state) => {
      const name = state.definition.name
      const base = {
        name,
        mode: state.definition.mode,
        providers: [...state.providers.keys()],
        activeProvider: state.activeAddonId,
        disabledProviders: [...state.disabledProviders],
      }
      if (state.definition.mode !== 'singleton') return base
      const overrides = this.singletonNodeOverrides.get(name)
      const perNode = [...this.getProvidersByNode(name).entries()].map(([nodeId, providers]) => ({
        nodeId,
        providers,
        resolvedActive: this.resolveSingletonAddonIdForNode(name, nodeId),
        hasOverride: overrides?.has(nodeId) ?? false,
      }))
      return { ...base, perNode }
    })
  }

  /** Check if a capability is declared. */
  has(capabilityName: string): boolean {
    return this.capabilities.has(capabilityName)
  }

  /** Check if a capability has at least one provider. */
  isAvailable(capabilityName: string): boolean {
    const state = this.capabilities.get(capabilityName)
    if (!state) return false
    return state.providers.size > 0
  }

  /**
   * Return every declared device-scoped capability (`scope: 'device'`)
   * whose `deviceTypes` list includes the given type — or caps that declare
   * no explicit `deviceTypes` (treat as applies-to-all). Used by the
   * bindings UI to enumerate which caps the user can wire for a device.
   */
  listDeviceScopedCapsForType(deviceType: string): readonly string[] {
    const out: string[] = []
    for (const state of this.capabilities.values()) {
      const def = state.definition as { scope?: string; deviceTypes?: readonly string[] }
      if (def.scope !== 'device') continue
      const applies =
        !def.deviceTypes || def.deviceTypes.length === 0 || def.deviceTypes.includes(deviceType)
      if (!applies) continue
      out.push(state.definition.name)
    }
    return out
  }

  // ── Private ────────────────────────────────────────────────────────

  private emitEvent(category: string, data: Record<string, unknown>): void {
    if (!this.eventBus) return
    this.eventBus.emit({
      id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      source: { type: 'core', id: 'capability-registry' },
      category,
      data,
    })
  }
}
