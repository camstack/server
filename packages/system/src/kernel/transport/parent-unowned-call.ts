/**
 * parent-unowned-call.ts — the parent-side `onUnownedCall` fallback for the
 * `LocalChildRegistry` (F0 — slice-5 outbound completion).
 *
 * When a forked child issues `ctx.api.<cap>.<method>` for a cap that NO local
 * sibling owns, the call arrives at the parent's `LocalChildRegistry` as a
 * `cap-call-out` with no local provider. Before F0 the parent threw
 * `UDS_NO_ROUTE`, and the child's tRPC chain fell through to its own
 * `brokerTransportLink` (its per-addon broker). F1+F2 removes that broker, so
 * the PARENT must route the call instead and return the result over UDS.
 *
 * Routing strategy (resolver-first, broker-fallback):
 *   1. Resolver-first — `resolver.resolveCapRoute(capName, { deviceId })` +
 *      `resolver.dispatch(...)`. This covers every REGISTERED capability:
 *      hub-in-process caps, hub-local-UDS sibling caps, remote-moleculer caps,
 *      and agent-child-forward caps. No nodeId is supplied so the resolver does
 *      singleton/wherever-it-lives resolution.
 *   2. Broker-fallback — for what the resolver returns `no-provider` on. The
 *      hub's CORE services (`$core-caps` for `system`/`addons`/`capabilities`/
 *      `nodes`/…, `$stream-probe`, `settings-store`, …) are Moleculer services
 *      NOT registered as CapabilityRegistry providers, so the resolver can't
 *      see them — but the parent keeps its broker, so `brokerCallForCap`
 *      reaches them through cluster service discovery using the SAME action
 *      naming the child's `brokerTransportLink` used.
 *
 * The agent has no `CapRouteResolver` (it routes everything to the hub over its
 * own broker), so it passes `getResolver: () => null` and relies entirely on
 * the broker fallback — the agent's broker call reaches the hub mesh.
 */

import type { CapCallInput } from './child-cap-protocol.js'
import { CapRouteError } from './cap-route.js'
import type { CapRouteResolver, HubLocalChildDispatcher } from './cap-route-resolver.js'
import { extractDeviceId, extractNodeId, stampCallerAddonId } from './cap-route-resolver.js'
import { brokerCallForCap } from '../moleculer/trpc-links.js'
import type { HubNodeRegistry } from '../moleculer/node-registry.js'
import type { ClaimedStatusResolver } from '../status-overlay.js'
import { answerClaimedGetStatus } from './claimed-get-status.js'
import type { ServiceBroker } from 'moleculer'

/**
 * Minimal logger surface accepted by the unowned-call handler. Matches the
 * `LocalChildRegistryLogger` shape so a single logger object can be shared.
 */
export interface ParentUnownedCallLogger {
  debug?(msg: string, meta?: unknown): void
  warn?(msg: string, meta?: unknown): void
}

export interface ParentUnownedCallDeps {
  /**
   * Returns the parent's `CapRouteResolver` at call time, or `null` when the
   * parent has none (the agent) or it has not been constructed yet (the hub,
   * before `onModuleInit` finishes — the resolver is built late, so this is a
   * live getter, not a captured value).
   */
  readonly getResolver: () => CapRouteResolver | null
  /** The parent's Moleculer broker — reaches the cluster + the hub's `$`-infra services. */
  readonly broker: ServiceBroker
  /**
   * The hub's single capability authority. Used to find the node that OWNS a
   * device-scoped native cap so the broker-fallback can be pinned to it instead
   * of load-balancing the call (which can hit the wrong provider).
   */
  readonly nodeRegistry: HubNodeRegistry
  /**
   * Hub-local UDS child dispatcher (`LocalChildRegistry`). Resolves
   * device-scoped native caps OWNED by hub-local children (reolink/hikvision
   * cameras run as forked hub-local UDS children — they register via the hub's
   * `LocalChildRegistry`, NOT via `registerNode`, so the `nodeRegistry` lookup
   * is empty for them) and dispatches the call to the owning child over UDS.
   *
   * A live GETTER (init-order safety): on the agent the local registry is built
   * AFTER this handler, so the instance is captured lazily. Returns null when
   * no local registry exists (failed to start) or when not yet constructed.
   */
  readonly getLocalDispatcher?: () => HubLocalChildDispatcher | null
  /**
   * Optional predicate — returns `true` when `capName` is a DEVICE-NATIVE cap
   * (`deviceNative: true` in its `CapabilityDefinition`): the provider IS the
   * device and routes ONLY over UDS / the per-node native path, never as a plain
   * Moleculer service. The kernel layer has no cap registry, so the wiring side
   * (which does) injects this.
   *
   * It gates the registration-race recovery in the broker-fallback branch: when
   * a device-scoped call's hub-local binding is not yet in the LocalChildRegistry
   * (`resolveChildId === null`) and no remote owner is known, the handler applies
   * a SHORT bounded retry, then — if still unresolved AND the cap is device-native
   * — throws a precise "binding not yet registered" error instead of attempting
   * the unpinned `brokerCallForCap`, which can NEVER reach a device-native cap and
   * would surface the misleading doubled `${cap}.${cap}.${method}` Moleculer error.
   *
   * Omitted (or returning `false`) ⇒ legacy behaviour is preserved exactly: no
   * retry, no precise error, straight to the existing broker fallback. This keeps
   * deviceId-carrying SYSTEM-cap calls (e.g. `system.info({deviceId})`) fast.
   */
  readonly isDeviceNativeCap?: (capName: string) => boolean
  /**
   * Optional predicate — returns `true` when `capName` declares
   * `nodeIdMode: 'data'` in its `CapabilityDefinition` (`addon-settings`,
   * `addons`, `nodes`, `pipeline-orchestrator`): an inline `nodeId` in the
   * call args is DATA for the (hub-singleton) provider, which dispatches
   * internally — NOT a routing hint. For such caps the handler must NOT lift
   * `args.nodeId` into a routing pin: pinning routes the call to a node with
   * no provider for the cap (e.g. a forked addon on an agent calling
   * `addon-settings.getGlobalSettings({addonId, nodeId})` gets pinned to
   * `nodeId` → dead broker fallback → ServiceNotFoundError). Suppressing the
   * pin forwards the call unpinned → singleton resolution on the hub — exactly
   * how `settings-store` (no `nodeId` arg) already behaves. `args` pass
   * through UNTOUCHED: the provider still reads `nodeId` as data.
   *
   * The kernel layer has no cap registry, so the wiring side (which does)
   * injects this. Omitted (or returning `false`) ⇒ legacy behaviour exactly:
   * an inline `args.nodeId` keeps pinning (benchmark, platform-probe,
   * pipeline-runner node-pinned execution is unaffected).
   */
  readonly isDataNodeIdCap?: (capName: string) => boolean
  /**
   * Optional forward-to-hub dispatcher (the AGENT path). When present, a cap
   * that no agent-LOCAL child owns is forwarded to the hub's `$hub-cap-fwd`
   * service instead of attempted via raw Moleculer service discovery
   * (`brokerCallForCap`). This is what makes an agent's forked addon reach a
   * HUB-hosted cap (`stream-broker`, `settings-store`, …): hub-local addon
   * runners register NO Moleculer service, so raw discovery for `${cap}.*`
   * 30s-deadlines. The hub side answers `$hub-cap-fwd.forward` by running the
   * call through ITS OWN `onUnownedCall` (resolver + broker-fallback), so the
   * agent inherits the hub's full routing. The hub itself passes this undefined
   * (it IS the hub) and keeps the `brokerCallForCap` path for its `$`-core
   * services. See `hub-cap-forward.ts`.
   */
  readonly forwardToHub?: (input: CapCallInput) => Promise<unknown>
  /**
   * Optional empty-collection fast-path. Returns `[]` (an empty aggregate) when
   * `capName` is a `mode:'collection'` cap whose `method` is array-output AND
   * ZERO providers are registered cluster-wide; `null`/`undefined` otherwise.
   *
   * Why: a collection cap with no providers IS the empty collection — but with
   * nothing registered, the resolver returns `no-provider` and the call falls
   * to the broker fallback, which polls Moleculer service discovery for a
   * `${cap}.${method}` service that will NEVER appear until the discovery
   * deadline (~30s) elapses. That 30s stall hit EVERY WebRTC cold start via the
   * provider-less `turn-provider` (`getTurnServers`). Returning `[]` up front
   * treats a provider-less collection as the empty collection it is — instant,
   * no discovery. A collection WITH ≥1 provider returns `null` here and routes
   * normally (the aggregate fans out across its providers as before). The
   * kernel layer has no cap registry, so the wiring side (which has both the
   * `CapabilityDefinition`s and the registry) injects this.
   */
  readonly resolveEmptyCollection?: (capName: string, method: string) => readonly unknown[] | null
  /**
   * Optional collection FAN-OUT. Returns the union of `method` across every
   * registered provider of a `mode:'collection'` cap, or `null` when the
   * (cap, method) pair is not an aggregated collection array-method.
   *
   * Why: routing resolves ONE provider (`resolveChildId` picks the
   * first-registered child, or the singleton preference — meaningless for a
   * collection). The hub's tRPC cap-router instead fans array methods across
   * every provider (`concatArrayMethod`). A forked addon calling the same cap
   * through `ctx.api` therefore saw a DIFFERENT, smaller answer than the hub's
   * own router — and for `notification-output`, whose three providers include
   * two that hold no targets, it saw `[]`. The Notification Center read that
   * empty catalog as "the target was deleted" and permanently dead-lettered
   * every notification it ever produced (2026-07-30).
   *
   * Skipped when the call carries an explicit `nodeId` pin — a pin must route
   * to its node, never be answered by a cluster-wide union. The kernel layer
   * has no cap registry, so the wiring side injects this (same shape as
   * {@link resolveEmptyCollection}, and it shares that path's aggregation code
   * so the two answers cannot drift).
   */
  readonly callCollectionAggregate?: (
    capName: string,
    method: string,
    args: unknown,
  ) => Promise<readonly unknown[] | null>
  /**
   * Optional `{ addonId }` PIN for a collection cap's SCALAR method — the twin
   * of {@link callCollectionAggregate}, for the same reason.
   *
   * On a system-scoped collection cap `addonId` is not provider data: the
   * codegen injects it as the `{nodeId?, addonId?}` selector on every method,
   * and the hub's tRPC cap-router routes by it. This handler lifted only
   * `nodeId` and `deviceId` out of a child's args, so a forked addon's pin was
   * DISCARDED IN SILENCE and the call was answered by whichever provider
   * registered first. `broker.getBrokerConfig({id:'ha_001', addonId:'provider-
   * homeassistant'})` therefore returned Homematic's `null` — indistinguishable
   * from "no such broker" — and the Home Assistant export could never open a
   * link. Every write-up that "proved the pin works" had measured the hub's
   * tRPC surface, never this path (2026-08-09).
   *
   * Returns a `{ value }` box so a legitimate `null` result is distinguishable
   * from "not a pinned collection call, route normally", and THROWS when the
   * pin names a non-provider — a pin that silently degrades to another
   * provider's answer is worse than no pin. Array methods are never pinned
   * here: their contract is the union above.
   *
   * The kernel layer has no cap registry, so the wiring side injects this and
   * it shares the tRPC path's provider resolution — the two must not drift.
   */
  readonly callPinnedCollection?: (
    capName: string,
    method: string,
    args: unknown,
  ) => Promise<{ readonly value: unknown } | null>
  /**
   * Optional predicate — returns `true` when `capName` is a HUB-CORE `$`-service
   * cap (`system`, `addons`, `nodes`, `capabilities`, `stream-probe`, …): served
   * by the hub's `$core-caps` / `$stream-probe` Moleculer services, NOT by any
   * addon provider. These are the ONLY legitimate consumers of the unpinned
   * `brokerCallForCap` fallback.
   *
   * It generalises the per-cap patches (`isDeviceNativeCap`,
   * `resolveEmptyCollection`) into ONE rule: for any cap the resolver misses
   * (`no-provider`) that is NOT a core `$`-service, the unpinned broker fallback
   * is a STRUCTURALLY DEAD path — the cap's providers are broker-less forked
   * children that expose no Moleculer service, so discovery 30s-deadlines into
   * the misleading `${cap}.${cap}.${method}` error. Instead the handler retries
   * the resolver briefly (the provider registers late in the post-restart boot
   * window) and then throws a PRECISE "not yet registered" error. A NEW
   * multi-node addon cap is covered automatically — no allowlist entry needed —
   * because the discriminant is the already-maintained hub-core cap set, not a
   * per-cap flag.
   *
   * The kernel layer has no cap registry, so the wiring side injects it.
   * Omitted (or returning `false` for a core cap by mistake) ⇒ legacy behaviour
   * exactly: the miss falls straight to the broker fallback with no retry.
   */
  readonly isCoreServiceCap?: (capName: string) => boolean
  /**
   * Resolve the per-device NATIVE provider for `(capName, deviceId)` — the
   * `native: true` route (see {@link CapCallInput.native}).
   *
   * Wired to this node's `CapabilityRegistry.getNativeProvider`, which is the
   * SINGLE authority on the question: it already covers in-process natives,
   * hub-local UDS vendor children (through the hub's `setNativeFallback`
   * resolver) and remote agents. Nothing here re-derives that — a rule
   * implemented twice is a rule that drifts, and this one previously drifted
   * into a wrapper answering on behalf of the native it was supposed to call.
   *
   * Returns null when no addon publishes the cap for that device. The handler
   * then FAILS the call rather than falling back to capName routing: falling
   * back is how a wrapper ends up calling itself.
   *
   * Omitted ⇒ a `native: true` call is forwarded to the hub (agents) or
   * rejected (no forwarder) — never silently downgraded to wrapper routing.
   */
  readonly resolveNative?: (
    capName: string,
    deviceId: number,
  ) => Record<string, (input: unknown) => Promise<unknown>> | null
  /**
   * The hub's claim authority for a device-scoped `getStatus` (D663, ruling
   * S3). Wired to `CapabilityRegistry.resolveClaimedStatus` — the SAME question
   * the registry's own wrappers and the other two transport entries ask, through
   * the one shared `answerClaimedGetStatus` (`claimed-get-status.ts`).
   *
   * Why here: every capName-based route below dispatches STRAIGHT to the owning
   * runner (`hub-local-uds`, `remote-moleculer`), whose `getStatus` answers the
   * NATIVE slice. This handler is the entry for a call no co-resident sibling
   * owns (a remote agent's device, a hub-in-process cap, the agent's forward);
   * the sibling short-circuit in `LocalChildRegistry` and the hub's
   * `callCapabilityOnNode` are the other two, and each asks first. When the
   * answer is `claimed` the merged slice IS the answer (`null` for a held claim,
   * and for a device whose claims cannot be known) and the resolver is never
   * consulted; a node pin does not bypass it — the hub is the one claim
   * authority wherever the device runs. `unclaimed` routes exactly as before.
   *
   * Omitted (the agent has no claim authority; its handler forwards to the hub
   * for hub-hosted caps, which answer through THIS hook on the hub) ⇒ legacy
   * routing exactly. Known gap: an agent-resident child calling `getStatus` of
   * an agent-resident device is answered by the agent's local dispatcher with
   * no hub round-trip, so a claim is not honoured there (D663 open item).
   */
  readonly claimedStatus?: ClaimedStatusResolver
  /** Optional logger for the broker-fallback diagnostic line. */
  readonly logger?: ParentUnownedCallLogger
}

/**
 * Bounded-retry budget for the hub-local registration race: a forked child's
 * `updateCaps` UDS descriptor can land a beat after a boot / respawn, so the
 * `(cap, deviceId)` binding is briefly absent from the LocalChildRegistry.
 * ~1s total (5 attempts × 200ms) covers that window cheaply without pinning a
 * hot path — and only ever engages for the device-native + no-owner case.
 */
const DEVICE_NATIVE_RETRY_ATTEMPTS = 5
const DEVICE_NATIVE_RETRY_DELAY_MS = 200

/**
 * Bounded-retry budget for the general provider-not-yet-registered recovery:
 * a forked hub-local child that PROVIDES a system/singleton cap (e.g.
 * `pipeline-orchestrator`) registers only once its (possibly heavy) boot
 * finishes, so a sibling calling it right after a hub restart briefly resolver-
 * misses. ~3s (12 × 250ms) covers a normal boot; past it the handler throws a
 * precise error (the caller — e.g. the ingest-owner gate — fail-opens) instead
 * of a 30s doubled-name broker deadline. Only engages for a NON-core cap miss.
 */
const ADDON_CAP_RETRY_ATTEMPTS = 12
const ADDON_CAP_RETRY_DELAY_MS = 250

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build the `onUnownedCall` handler the hub / agent passes into
 * `new LocalChildRegistry({ ..., onUnownedCall })`.
 *
 * The returned handler:
 *   - tries the resolver first (when present),
 *   - falls back to the broker for `no-provider` resolver misses (the
 *     `$`-infra / core services), and
 *   - surfaces a clear error when the call is genuinely unroutable (so the
 *     child's call rejects rather than hanging).
 */
export function createParentUnownedCallHandler(
  deps: ParentUnownedCallDeps,
): (input: CapCallInput) => Promise<unknown> {
  return async (input: CapCallInput): Promise<unknown> => {
    // Derive the deviceId ONCE — top-level when the child supplied it, else
    // pulled out of `input.args` (where device-scoped caps carry it). Used for
    // BOTH the resolver attempt (device-scoped routing to the owning provider)
    // and the pinned broker fallback below.
    const deviceId = input.deviceId ?? extractDeviceId(input.args)

    // ── `native: true` — the per-device NATIVE provider, or nothing ──────
    // Answered BEFORE every capName-based path below, because every one of
    // them resolves a wrapper cap to its wrapper. For a wrapper asking for its
    // own native that is a call back into the caller.
    if (input.native === true) {
      if (deviceId === undefined) {
        throw new Error(
          `no native provider for capability "${input.capName}" — the call carried no deviceId`,
        )
      }
      const provider = deps.resolveNative?.(input.capName, deviceId) ?? null
      if (provider !== null) {
        const fn = provider[input.method]
        if (typeof fn !== 'function') {
          throw new Error(
            `no native provider for capability "${input.capName}" implementing "${input.method}" on device ${String(deviceId)}`,
          )
        }
        const args =
          typeof input.args === 'object' && input.args !== null && !Array.isArray(input.args)
            ? { ...(input.args as Record<string, unknown>), deviceId }
            : { deviceId }
        return await fn(args)
      }
      // An AGENT has no native authority of its own — the hub owns the cluster
      // view — so forward and let the hub answer the same question. The flag
      // travels with the call; without a forwarder there is nothing left to
      // try, and the message is the one a wrapper reads as "absent".
      if (deps.forwardToHub !== undefined) {
        return await deps.forwardToHub({
          capName: input.capName,
          method: input.method,
          args: input.args,
          deviceId,
          native: true,
          ...(input.callerAddonId !== undefined ? { callerAddonId: input.callerAddonId } : {}),
        })
      }
      throw new Error(
        `no native provider for capability "${input.capName}" on device ${String(deviceId)}`,
      )
    }

    // ── `getStatus` of a CLAIMED cap — the hub mirror answers (D663, S3) ──
    // After the `native: true` block (which already reaches the overlay through
    // `resolveNative` → `getNativeProvider`) and BEFORE every path that would
    // route the call to the owning runner: the empty-collection fast-path, the
    // aggregate, the pinned collection, the resolver, the broker fallback. A
    // pin does not bypass it — see `ParentUnownedCallDeps.claimedStatus`.
    const claimed = await answerClaimedGetStatus(deps.claimedStatus, {
      capName: input.capName,
      method: input.method,
      ...(deviceId !== undefined ? { deviceId } : {}),
      args: input.args,
    })
    if (claimed !== null) return claimed.slice

    // Explicit per-call node pin. Two sources, in priority order:
    //   1. `input.nodeId` — the out-of-band `nodePin(op.context)` lifted onto
    //      the wire by `ipcParentLink` (works when op.context survives).
    //   2. an inline `nodeId` in the call args — the SAME mechanism the
    //      generated hub cap-router already honours, and the way device-scoped
    //      caps carry `deviceId`. This is the source that actually survives the
    //      forked addon → hub UDS link chain, so hub→remote-node EXECUTION
    //      pinning (e.g. the benchmark running a workload on a chosen agent)
    //      routes correctly instead of silently falling back to the hub.
    // Inline `nodeId` in the args is an explicit pin too — the SAME mechanism
    // the generated hub cap-router honours, and the source that survives the
    // forked addon → hub UDS link chain (the out-of-band op.context pin does
    // not). The args pass through to the provider unchanged; a provider that
    // doesn't declare `nodeId` simply ignores the extra field (it destructures
    // the fields it needs), exactly as this path has always done for caps that
    // DO declare a routing `nodeId` (e.g. `pipeline-executor.getSchema`).
    //
    // EXCEPTION — `nodeIdMode: 'data'` caps: their `nodeId` is provider DATA
    // (the hub singleton dispatches internally), never a pin. Deriving a pin
    // from it mis-routes the call to a provider-less node. Suppress the pin
    // (unpinned → singleton resolution) and leave `input.args` untouched so
    // the provider still receives `nodeId` as data.
    const nodeId =
      deps.isDataNodeIdCap?.(input.capName) === true
        ? undefined
        : (input.nodeId ?? extractNodeId(input.args))
    // An explicit pin naming ANOTHER node makes every node-LOCAL resolution
    // below wrong: the deviceId branch's local-child dispatch and device-owner
    // lookup are "this node / cluster owner" heuristics, and a same-named
    // LOCAL provider would silently swallow the pinned call (an agent's own
    // non-owner `stream-broker` answering a runner's call pinned to the ingest
    // owner → "source not dialed" → cross-node detection black-holes). Third
    // instance of "an explicit pin must win over a co-located provider":
    // `localProviderLink`, the sibling short-circuit, now the parent's
    // device-scoped fallback. A pin to THIS node keeps the local paths.
    const pinnedToOtherNode = nodeId !== undefined && nodeId !== deps.broker.nodeID

    // Empty-collection fast-path: a provider-less collection cap is the empty
    // collection — return [] up front rather than routing (resolver miss →
    // broker fallback → ~30s Moleculer discovery deadline for a service that
    // never appears; this hit every WebRTC cold start via `turn-provider`).
    // Skipped when the call is explicitly pinned (`nodeId`) — an explicit pin
    // must route to its node, not be short-circuited.
    if (nodeId === undefined) {
      const empty = deps.resolveEmptyCollection?.(input.capName, input.method)
      if (empty != null) return empty

      // Collection fan-out: a collection array-method answers with the UNION
      // across its providers, exactly as the hub's tRPC cap-router does.
      // Routing below would pick ONE provider and silently under-report.
      const aggregate = await deps.callCollectionAggregate?.(
        input.capName,
        input.method,
        input.args,
      )
      if (aggregate != null) return aggregate

      // `{ addonId }` pin on a collection cap's SCALAR method. Runs after the
      // union (which claims the array methods) and before routing, because
      // routing is exactly what discards the selector: `resolveCapRoute` takes
      // only `nodeId` / `deviceId`, so the pin would be dropped and the first
      // registered provider would answer for a resource it does not own.
      const pinned = await deps.callPinnedCollection?.(input.capName, input.method, input.args)
      if (pinned !== null && pinned !== undefined) return pinned.value
    }

    const resolver = deps.getResolver()

    if (resolver !== null) {
      try {
        // A pinned agent node classifies as `agent-child-forward`
        // (`$agent-cap-fwd.forward` → the agent's in-process provider); a pinned
        // hub node stays hub-in-process / hub-local-uds; no pin → singleton.
        const route = resolver.resolveCapRoute(input.capName, {
          ...(nodeId !== undefined ? { nodeId } : {}),
          ...(deviceId !== undefined ? { deviceId } : {}),
        })
        // `input.callerAddonId` is the ORIGINATING addon `LocalChildRegistry`
        // stamped off the registered `childId` — distinct from the 4th
        // `addonId` PROVIDER-selection hint (unused on this inbound path).
        // Only the `hub-in-process` branch of `dispatch` consumes it. Omitted
        // entirely (not passed as an explicit `undefined`) when absent, so a
        // caller that never carried one keeps the exact 3-arg call this path
        // has always made.
        return input.callerAddonId !== undefined
          ? await resolver.dispatch(route, input.method, input.args, undefined, input.callerAddonId)
          : await resolver.dispatch(route, input.method, input.args)
      } catch (err) {
        // Only a no-provider miss is eligible for the broker fallback: the cap
        // is not a registered capability the resolver can see (e.g. a `$`-infra
        // / core Moleculer service). Any other CapRouteError (node-offline,
        // transport-failed) is a real failure for a cap the resolver DID route,
        // so it must propagate — retrying via the broker would be wrong.
        if (!(err instanceof CapRouteError) || err.reason !== 'no-provider') {
          throw err
        }
        // fall through to the broker fallback
      }
    } else {
      // Resolver not yet built (pre-init window) or not present (agent path).
      // Emit a debug line so a startup-window unowned call is visible in logs.
      deps.logger?.debug?.(
        `onUnownedCall: resolver not ready, routing ${input.capName}.${input.method} via broker fallback`,
      )
    }

    // Broker fallback — reach the cluster + the parent's core `$`-infra services
    // using the same discovery + action-name convention the child's
    // `brokerTransportLink` used before F0.
    try {
      // Device-scoped pin: when the call carries a deviceId AND a node owns a
      // matching device-native cap for it, pin the broker call to that node.
      // Without this the broker load-balances a device-scoped call across all
      // same-named providers (cap names are shared across vendors) and can hit
      // the wrong provider — which returns empty results. Resolving the owner
      // here keeps the call correct and quiet (no fallback WARN).
      if (deviceId !== undefined && !pinnedToOtherNode) {
        // Hub-local UDS child owns this device-native cap? Route to it over UDS.
        // Hub-local children (reolink/hikvision cameras) register via the hub's
        // LocalChildRegistry, NOT via registerNode — so the HubNodeRegistry
        // lookup below is EMPTY for them. Without this check a device-scoped
        // call (e.g. `stream-catalog.getCatalog({deviceId})`) reaches the
        // load-balanced broker fallback and can mis-route.
        const localDispatcher = deps.getLocalDispatcher?.() ?? null
        if (localDispatcher !== null) {
          let childId = localDispatcher.resolveChildId(input.capName, deviceId)

          // Registration-race recovery: a device-native binding can be briefly
          // absent from the LocalChildRegistry just after a child boot / respawn
          // (its `updateCaps` UDS descriptor lands a beat late). For a
          // device-native cap with NO remote owner, retry resolveChildId a few
          // times before giving up — otherwise the call falls to the unpinned
          // broker, which can never reach a device-native cap. Gated on the
          // injected predicate so deviceId-carrying SYSTEM caps keep the fast
          // path (no retry, straight to the broker fallback below).
          if (childId === null && deps.isDeviceNativeCap?.(input.capName) === true) {
            const hasRemoteOwner = deps.nodeRegistry
              .listNativeCapEntriesForDevice(deviceId)
              .some((entry) => entry.capName === input.capName)
            if (!hasRemoteOwner) {
              for (
                let attempt = 1;
                attempt <= DEVICE_NATIVE_RETRY_ATTEMPTS && childId === null;
                attempt++
              ) {
                await delay(DEVICE_NATIVE_RETRY_DELAY_MS)
                childId = localDispatcher.resolveChildId(input.capName, deviceId)
              }
              if (childId === null) {
                // Still unregistered after the bounded window: the call is
                // genuinely unroutable RIGHT NOW. Surface a precise error rather
                // than the misleading `${cap}.${cap}.${method}` broker failure.
                throw new Error(
                  `no provider registered for device-native cap "${input.capName}" on device ${deviceId} (binding not yet in LocalChildRegistry)`,
                )
              }
            }
          }

          if (childId !== null) {
            return await localDispatcher.callCapOnChild(childId, {
              capName: input.capName,
              method: input.method,
              args: input.args,
              deviceId,
            })
          }
        }
        // Remote node owns it? Pin the call to that node. On the AGENT
        // (forwardToHub set) let the hub resolve+pin — its resolver is the
        // single cluster authority; a raw agent broker call can't reach a
        // hub-local or third-node provider. On the HUB keep the direct pinned
        // broker call.
        const owner = deps.nodeRegistry
          .listNativeCapEntriesForDevice(deviceId)
          .find((entry) => entry.capName === input.capName)
        if (owner !== undefined) {
          if (deps.forwardToHub !== undefined) {
            return await deps.forwardToHub({
              capName: input.capName,
              method: input.method,
              args: input.args,
              deviceId,
              nodeId: owner.nodeId,
              ...(input.callerAddonId !== undefined ? { callerAddonId: input.callerAddonId } : {}),
            })
          }
          return await brokerCallForCap(
            deps.broker,
            input.capName,
            input.method,
            stampCallerAddonId(input.args, input.callerAddonId),
            { nodeId: owner.nodeId },
          )
        }
      }

      // AGENT path: forward to the hub's `$hub-cap-fwd`, which runs the call
      // through the hub's own routing (resolver + broker-fallback). This is the
      // ONLY way an agent reaches a hub-hosted cap — hub-local addon runners
      // expose no Moleculer service, so a raw `brokerCallForCap` for `${cap}.*`
      // 30s-deadlines. deviceId/nodeId travel as routing hints the hub honours.
      if (deps.forwardToHub !== undefined) {
        return await deps.forwardToHub({
          capName: input.capName,
          method: input.method,
          args: input.args,
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(nodeId !== undefined ? { nodeId } : {}),
          // WHO is calling travels with the call (D787): the agent stamped it
          // off its child's connection, and the hub's keychain owner-checks it.
          ...(input.callerAddonId !== undefined ? { callerAddonId: input.callerAddonId } : {}),
        })
      }

      // General provider-not-yet-registered recovery. We reach here unpinned,
      // with no resolvable device-owner and no agent forward — i.e. the last
      // stop before the unpinned broker fallback. That fallback is legitimate
      // ONLY for hub-core `$`-service caps; for ANY OTHER cap (a system/singleton
      // addon cap like `pipeline-orchestrator`, provided by a broker-less forked
      // child) it is a structurally dead path that 30s-deadlines into the
      // misleading `${cap}.${cap}.${method}` error. When the injected predicate
      // says this is NOT a core `$`-service, treat a resolver miss as "provider
      // not registered YET" (post-restart boot window): retry the resolver
      // briefly, then throw a precise error — never the dead broker call.
      // Gated on the predicate being injected so omitting it preserves legacy
      // behaviour exactly (the wiring always injects it in production).
      if (deps.isCoreServiceCap !== undefined && !deps.isCoreServiceCap(input.capName)) {
        for (let attempt = 1; attempt <= ADDON_CAP_RETRY_ATTEMPTS; attempt++) {
          await delay(ADDON_CAP_RETRY_DELAY_MS)
          const retryResolver = deps.getResolver()
          if (retryResolver !== null) {
            try {
              const route = retryResolver.resolveCapRoute(input.capName, {
                ...(nodeId !== undefined ? { nodeId } : {}),
                ...(deviceId !== undefined ? { deviceId } : {}),
              })
              // The caller stamp survives the retry: a provider that
              // owner-checks (the keychain) must not see a stamped call
              // turn anonymous because the first attempt raced its boot.
              return input.callerAddonId !== undefined
                ? await retryResolver.dispatch(
                    route,
                    input.method,
                    input.args,
                    undefined,
                    input.callerAddonId,
                  )
                : await retryResolver.dispatch(route, input.method, input.args)
            } catch (err) {
              // Keep retrying only on a no-provider miss (provider still booting);
              // any real routing failure propagates.
              if (!(err instanceof CapRouteError) || err.reason !== 'no-provider') throw err
            }
          }
        }
        throw new Error(
          `no provider registered for cap "${input.capName}" (resolver miss after boot-window retry; forked-addon provider not yet registered — ${input.method})`,
        )
      }

      // This is the DESIGNED route for a hub-core cap, not a fallback worth a
      // warning: on the live hub it fired 3,647 times in a day, every one of
      // them an addon polling `addons` / `nodes` / `integrations` exactly as
      // built, and buried the lines that mattered. Debug level, and it names
      // the caller — "which addon is polling this?" is the only question the
      // line has ever been asked.
      deps.logger?.debug?.('routing child unowned cap call via the hub-core `$core-caps` bridge', {
        capName: input.capName,
        method: input.method,
        callerAddonId: input.callerAddonId,
        route: '$core-caps',
      })
      // HUB path — no node pinning: singleton / wherever-it-lives call (no
      // resolvable device-owner). Any deviceId the child needs is already
      // carried inside `input.args` (where the child placed it). The UDS
      // stamp lives on CapCallInput, not in args — merge it here so
      // server-provided doors that owner-check (`integrations.getSettings`,
      // D787) see the same caller the hub-in-process branch would have stamped.
      return await brokerCallForCap(
        deps.broker,
        input.capName,
        input.method,
        stampCallerAddonId(input.args, input.callerAddonId),
      )
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new Error(
        `parent could not route child unowned cap call "${input.capName}.${input.method}": ${reason}`,
        { cause },
      )
    }
  }
}
