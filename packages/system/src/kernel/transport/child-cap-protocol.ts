import type {
  ChildCustomActionCatalogs,
  CustomActionCaller,
  IReadinessRegistryRecord,
  LogLevel,
  LogTags,
  SystemEvent,
} from '@camstack/types'
import type { CapRoutingHints } from './cap-routing-hints.js'

/**
 * Routing descriptor a child sends so the parent can route cap calls to it.
 * The provider implementation never crosses the wire — only these keys do.
 */
export interface ChildCapDescriptor {
  readonly capName: string
  /** Cap mode. Carried for the future cluster-exposure layer (agent-as-proxy); the local registry routes only on capName + deviceId. */
  readonly mode: 'singleton' | 'collection'
  /** Present for device-scoped caps; absent for singleton/system caps. */
  readonly deviceId?: number
  /**
   * The addon that registered this cap. A GROUPED runner (`execution.group`)
   * hosts multiple addons in one child, so the parent can no longer assume
   * `addonId === childId` — this field lets the parent's manifest builder
   * split the descriptor set into one `RegisteredAddonManifest` entry per
   * hosted addon (real provider registryKeys, per-addon settings/logs/UI).
   * OPTIONAL for wire compat: a legacy child omits it and the parent falls
   * back to the childId (identical to the historical single-addon behaviour).
   */
  readonly addonId?: string
}

/** First message a child sends after connecting — its complete cap manifest. */
export interface RegisterMessage {
  readonly kind: 'register'
  readonly childId: string
  readonly caps: readonly ChildCapDescriptor[]
  /**
   * Snapshot of the child's live category-pattern subscriptions (the keys of
   * its local `SharedBusState.handlers` map). Carried IN the register frame so
   * the parent learns the child's subscriptions race-free at boot — no separate
   * post-connect sync can be missed. OPTIONAL: a legacy child bundling an older
   * `@camstack/system` omits it; the parent treats an absent field as
   * "undeclared" and fails OPEN (broadcast every event to that child). See
   * `EventSubUpdateMessage` for post-boot updates.
   */
  readonly eventPatterns?: readonly string[]
  /**
   * Custom-action catalogs of the addons this child hosts, keyed by addon id,
   * with the Zod schemas stripped — see `CustomActionDescriptor`. Carried IN
   * the register frame for the same reason as `eventPatterns`: the parent
   * learns it race-free, at the post-init re-register, FROM THE PROCESS THAT
   * OWNS THE ADDON. It is never learned by evaluating the addon's bundle in the
   * parent (D444: ten 9 MB evaluations in hub-main, none of which produced a
   * catalog, and every one pinned the evicted graph's module-scope state).
   * OPTIONAL: absent from the pre-init register (the catalogs do not exist yet)
   * and from a legacy child; absent means "not described yet", never "none".
   */
  readonly customActions?: ChildCustomActionCatalogs
  /**
   * The child can RECEIVE a `cap-call` whose args ride as an opaque payload
   * beside the envelope (raw-forward), and answer with one. Declared, never
   * assumed: a parent forwards a payload only to a child that said so, and
   * decodes it for one that did not. Absent = legacy child = inline args.
   */
  readonly rawForward?: true
}

/**
 * Parent → child answer to `register`. `rawForward` says the parent accepts
 * a `cap-call-out` whose args ride as a payload — a child packs its args
 * only after seeing it. Absent = legacy parent = inline args.
 */
export interface RegisterAck {
  readonly ok: true
  readonly rawForward?: true
}

/**
 * Child → parent, fire-and-forget: the child's category-pattern subscription
 * set changed after registration. FULL-SET REPLACE semantics — `patterns` is
 * the complete current set, not a delta. Idempotent and order-safe on the
 * in-order UDS socket (last write wins is correct). Sent via `channel.emit`
 * like {@link ChildEventMessage}; carries no response.
 */
export interface EventSubUpdateMessage {
  readonly kind: 'event-sub'
  readonly patterns: readonly string[]
}

/**
 * Child → parent outbound cap invocation — the child asks the parent to route
 * a cap call it does not own.
 *
 * Under raw-forward `args` is ABSENT from the envelope: the packed args ride
 * as the frame's opaque payload and `hints` carries the two fields the parent
 * routes on. A legacy child sends `args` inline and no `hints`; the parent
 * lifts the hints itself. See `cap-routing-hints.ts`.
 */
export interface CapCallOutMessage {
  readonly kind: 'cap-call-out'
  readonly capName: string
  readonly method: string
  readonly args?: unknown
  readonly hints?: CapRoutingHints
  readonly deviceId?: number
  /**
   * Optional per-call node pin (out-of-band; NOT part of the validated method
   * args). When set, the parent routes this singleton/in-process cap call to
   * the named node's provider instead of the default (hub) resolution — used to
   * query a remote agent's in-process singleton (e.g. the agent's own
   * `platform-probe` hardware). Set via `ctx.api`'s `onNode(nodeId)` modifier.
   */
  readonly nodeId?: string
  /**
   * "Resolve the per-device NATIVE provider for this cap, never a wrapper."
   * Set by `ctx.getNativeProvider(...)` in a forked runner.
   *
   * ## Why a flag and not just the cap name
   *
   * A wrapper and its natives share ONE cap name. As long as the wrapper lived
   * in hub-main that was harmless — the wrapper resolved its native through the
   * hub's `CapabilityRegistry`, which knows the difference. A wrapper in a
   * runner has no such registry, and every generic route back out of the
   * process resolves `capName` the way every OTHER caller does: to the wrapper.
   * `localProviderLink` answers it from the runner's own provider before the
   * call ever reaches the socket, and `resolveChildId` would hand it back to
   * the wrapper's own child if it did. Either way the wrapper calls itself:
   * the second entry joins the first's single flight and waits on a promise
   * only it can settle.
   *
   * So the intent has to travel. `native: true` makes the parent skip
   * capName-based resolution entirely and ask the ONE native authority
   * (`CapabilityRegistry.getNativeProvider`, which covers in-process natives,
   * hub-local UDS vendor children and remote agents alike) for `(cap, device)`.
   * With no native for the pair the call FAILS — it never degrades into the
   * wrapper — with a message a wrapper can read as "absent" and fall through to
   * its own strategy.
   */
  readonly native?: boolean
}

/** Child → parent: a system event produced by the child to be forwarded to the hub event bus. */
export interface ChildEventMessage {
  readonly kind: 'event'
  readonly event: SystemEvent
}

/** Child → parent: a structured log entry emitted by the child process. */
export interface ChildLogMessage {
  readonly kind: 'log'
  readonly level: LogLevel
  readonly message: string
  readonly addonId: string
  readonly nodeId?: string
  readonly scope?: string
  readonly tags?: LogTags
  readonly meta?: Record<string, unknown>
}

/** Child → parent: request for the current readiness snapshot (all known records). */
export interface ReadinessSnapshotRequest {
  readonly kind: 'readiness-request'
}

/**
 * Child → parent message bodies.
 * `RegisterMessage`, `CapCallOutMessage`, and `ReadinessSnapshotRequest` travel
 * as correlated request frames (`channel.request`) and carry a response.
 * `ChildEventMessage`, `ChildLogMessage`, and `EventSubUpdateMessage` are sent
 * fire-and-forget via `channel.emit()` and do NOT carry a response.
 */
export type ChildToParentRequest =
  | RegisterMessage
  | CapCallOutMessage
  | ChildEventMessage
  | ChildLogMessage
  | EventSubUpdateMessage
  | ReadinessSnapshotRequest

/** Parent → child cap invocation. */
export interface CapCallMessage {
  readonly kind: 'cap-call'
  readonly capName: string
  readonly method: string
  readonly args: unknown
  readonly deviceId?: number
  /** Optional per-call node pin (out-of-band routing hint; see {@link CapCallOutMessage.nodeId}). */
  readonly nodeId?: string
  /**
   * Out-of-band PROVIDER-selection hint: the addonId of the provider the hub
   * resolved for this call. Needed for GROUPED runners where two co-located
   * addons register the SAME collection cap (e.g. `network-access` from both
   * cloudflare-tunnel and tailscale-ingress) — the hub's collection mount
   * strips `addonId` from the method args after resolving the provider, so
   * without this hint the child could only pick one-per-capName. Absent →
   * the child dispatch falls back to its sole provider for the cap.
   */
  readonly addonId?: string
  /**
   * Out-of-band CALLER-identity hint — the addon that ORIGINATED this call,
   * as distinct from {@link addonId} (which names the resolved PROVIDER).
   * Set ONLY by `LocalChildRegistry` when it turns a registered child's
   * `cap-call-out` into a `CapCallInput` for `onUnownedCall`: the parent
   * already knows which `childId` sent the message (it owns the UDS
   * connection the frame arrived on), and stamps it here rather than
   * trusting anything the child claims in its `args`. Absent for a call that
   * did not arrive over the cap channel (hub-in-process, HTTP/tRPC) — those
   * callers are attributed by other means (see
   * `fleet-read-census.ts#siteOf`). A provider that does not care about its
   * caller simply never reads it.
   */
  readonly callerAddonId?: string
  /**
   * Native-only routing hint — see {@link CapCallOutMessage.native}. Carried
   * here because `CapCallInput` (the type every parent-side router takes) is
   * this message minus its discriminant; a child DISPATCH ignores it.
   */
  readonly native?: boolean
}

/** Parent → child: a system event delivered by the hub for the child to handle locally. */
export interface ParentEventMessage {
  readonly kind: 'event'
  readonly event: SystemEvent
  /** Moleculer node ID of the hub or agent that forwarded this event. */
  readonly sourceNodeId: string
}

/** Parent → child: authoritative readiness snapshot in response to a `readiness-request`. */
export interface ReadinessSnapshotResponse {
  readonly kind: 'readiness-snapshot'
  readonly records: readonly IReadinessRegistryRecord[]
}

/**
 * The exhaustive set of ADDON-LEVEL surfaces carried over the UDS addon-call
 * plane — i.e. everything the removed per-addon Moleculer broker used to carry
 * besides cap methods. THIS UNION IS THE SINGLE SOURCE OF TRUTH: every such
 * surface MUST appear here AND be handled by `createChildAddonCallDispatch`'s
 * exhaustive switch (a `never` check fails the build if one is added here but
 * not dispatched, or hub-side routing is added without a target). Routes +
 * custom-actions were ported in the UDS migration; `settings` was MISSED for
 * months because it lived on a separate Moleculer path — adding it here makes
 * that class of "missed link" a compile error from now on.
 *
 * `AddonCallTarget` values:
 *   - `routes`   → the addon's `addon-routes` provider `getRoutes()` (handlers
 *     STRIPPED — MsgPack can't encode functions; the hub re-binds via `invoke`).
 *   - `custom`   → the addon's custom-action handler (`action` + `args`).
 *   - `settings` → the addon's global/device settings methods (`method` names
 *     the entry; `args` carries the params). Mirrors the removed
 *     `<addonId>.settings.<method>` Moleculer action.
 *   - `data-planes` → the addon's live HTTP data-plane endpoints
 *     (`{prefix, access, baseUrl, secret}[]`), pulled when the hub mounts the
 *     addon so it can set up its reverse-proxy. Mirrors `routes`.
 */
export type AddonCallTarget = 'routes' | 'custom' | 'settings' | 'data-planes'

/** The addon-settings methods reachable over the addon-call plane. */
export type AddonSettingsMethod =
  | 'getGlobalSettings'
  | 'updateGlobalSettings'
  | 'getIntegrationSettings'
  | 'getDeviceSettings'
  | 'updateDeviceSettings'

/**
 * Parent → child: invoke an ADDON-LEVEL method on a loaded addon (not a cap).
 * Carried as a correlated request frame (`channel.request`) — it returns a
 * value (route descriptors, the custom-action result, or the settings schema /
 * update ack). See {@link AddonCallTarget} for the exhaustive surface list.
 */
export interface AddonCallMessage {
  readonly kind: 'addon-call'
  readonly addonId: string
  readonly target: AddonCallTarget
  /** Required when `target === 'custom'` — the custom-action name. */
  readonly action?: string
  /** Required when `target === 'settings'` — which settings method to invoke. */
  readonly method?: AddonSettingsMethod
  /** Custom-action / settings input (already validated by the hub). */
  readonly args?: unknown
  /**
   * Authenticated caller, forwarded ONLY for a `target: 'custom'` action that
   * declares `caller: 'required'`. Derived server-side from the request
   * principal by the hub (never from client input); ABSENT for every other
   * call. Additive on the wire: a legacy child that predates this field simply
   * never reads it (its custom-action dispatch invokes the handler with input
   * only), and a child that receives no `caller` sees `undefined` — identical
   * to the pre-forwarding behaviour. See {@link CustomActionCaller}.
   */
  readonly caller?: CustomActionCaller
}

/**
 * Parent → child: request to change the child's Moleculer log level.
 * Fire-and-forget (sent via `channel.emit` — no response expected).
 * Mirrors the `$node-mgmt.setLogLevel` Moleculer action for UDS children.
 */
export interface SetLogLevelMessage {
  readonly kind: 'set-log-level'
  readonly level: string
}

/** Parent → child request bodies. */
export type ParentToChildRequest =
  | CapCallMessage
  | ParentEventMessage
  | ReadinessSnapshotResponse
  | SetLogLevelMessage
  | AddonCallMessage

/** Public view of a registered child (no channel handle). */
export interface RegisteredChild {
  readonly childId: string
  readonly caps: readonly ChildCapDescriptor[]
  /**
   * Monotonic id of the CONNECTION this registration arrived on, unique within
   * the parent process.
   *
   * `childId` is deterministic (`resolveRunnerId`), so a runner replaced by an
   * update reconnects under the exact same id — the two generations are
   * indistinguishable without this. Consumers stamp it onto whatever they
   * derive from the child (capability registrations, subtree manifests) so a
   * teardown arriving from the DEAD generation can be told apart from the live
   * one. See docs/decisions/adr-0188-an-unregister-carries-proof-of-ownership.md.
   */
  readonly incarnation: number
  /** See {@link RegisterMessage.customActions}. Absent = not described yet. */
  readonly customActions?: ChildCustomActionCatalogs
}

/** Arguments to route a cap method call (the `cap-call` message minus its discriminant). */
export type CapCallInput = Omit<CapCallMessage, 'kind'>

/** Arguments to route an addon-level call (the `addon-call` message minus its discriminant). */
export type AddonCallInput = Omit<AddonCallMessage, 'kind'>
