/**
 * tRPC custom links for capability routing.
 *
 * These links replace `broker-api-proxy.ts` with proper tRPC links that
 * integrate into the standard `createTRPCClient({ links: [...] })` chain.
 *
 * Link chain for each deployment context:
 *
 *   Hub in-process:
 *     localProviderLink → unstable_localLink(hubRouter)
 *
 *   Worker with WSS:
 *     localProviderLink → wsLink(hub)
 *
 *   Worker without WSS:
 *     localProviderLink → brokerTransportLink(moleculerBroker)
 *
 * `localProviderLink` is a non-terminating link that intercepts calls
 * when the target capability has a provider in the local process. If
 * not, it passes through to the next link (hub router, WSS, or broker).
 *
 * `brokerTransportLink` is a terminating link that routes any unresolved
 * call through Moleculer `broker.call()`.
 */

import {
  CALLER_STAMPED_CAPABILITIES,
  readNodePin,
  withCapInputDefaults,
} from '@camstack/types/addon'
import { stampCallerAddonId } from '../transport/cap-route-resolver.js'
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import type { AnyRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import type { ServiceBroker } from 'moleculer'
import type { CapCallInput } from '../transport/index.js'
import {
  capActionName,
  capActionSuffix,
  capBareAction,
  UDS_NO_ROUTE_PREFIX,
} from '../transport/index.js'
import { serializeTypedArrays } from './typed-array-serde.js'

// ── Local provider resolution ──────────────────────────────────────

/**
 * Resolver for in-process capability providers.
 *
 * The localProviderLink calls this on every operation to check whether
 * a provider exists in the local process. Implementations differ:
 *   - Worker: reads from `localProviderRegistry` + `preferredProviderRegistry`
 *   - Hub: reads from `CapabilityRegistry`
 */
/**
 * Shared interface — also re-exported by `broker-api-proxy.ts`.
 * Single method is sufficient: the link only needs to resolve the
 * first matching provider. Singleton vs collection distinction is
 * a registry concern, not a transport concern.
 */
export interface LocalProviderResolver {
  /** First matching provider (active singleton or first collection member). */
  getByName(capabilityName: string): unknown | null
  /**
   * The node this resolver's providers run on (e.g. `'hub'`, `'hub/model-studio'`,
   * `'agent-a/model-studio'`). When set, {@link localProviderLink} defers a
   * call carrying an explicit `nodePin` to a DIFFERENT node instead of
   * short-circuiting to a co-located provider — so the pin routes to the
   * intended node (parent → `onUnownedCall` → CapRouteResolver). Symmetric to
   * the LocalChildRegistry sibling-skip: an explicit pin must win over a
   * same-named co-located provider. Omit for legacy/in-process callers that
   * never pin a cap they themselves host.
   */
  localNodeId?: string
}

// ── Cap-usage observer ─────────────────────────────────────────────

/**
 * A single tRPC cap call observation. Recorded by `localProviderLink`
 * / `brokerTransportLink` on every op, regardless of in-process vs
 * cluster-bound routing, and fed to the hub's `CapUsageRegistry`.
 *
 * Observation is best-effort — observers MUST NOT throw. The link
 * wraps the recorder in a try/catch so a broken observer never fails
 * the caller's RPC.
 */
export interface CapUsageObservation {
  readonly callerAddonId: string
  readonly providerAddonId: string
  readonly capName: string
  readonly methodName: string
  readonly atMs: number
}

export type CapUsageObserver = (obs: CapUsageObservation) => void

export interface CapUsageObserverOptions {
  /** The addon whose `ctx.api` produced this link chain. */
  readonly callerAddonId: string
  /**
   * Resolve which addon hosts the provider for `capName`. `null` means "not in
   * the LOCAL registry" — which is every cross-process provider, and no longer
   * means "do not record": see {@link UNRESOLVED_PROVIDER_ADDON_ID}.
   */
  readonly providerAddonIdForCap: (capName: string) => string | null
  /** Sink for observations. MUST NOT throw — wrapper catches anyway. */
  readonly observer: CapUsageObserver
}

/**
 * Stands in for a provider the LOCAL registry cannot name.
 *
 * `providerAddonIdForCap` only searches the local registry, so it returns
 * `null` for every cross-process provider — which is every forked runner,
 * `sqlite-settings` included. That `null` used to drop the whole observation,
 * caller and all. The result: `nodes.getCapUsageGraph`, an admin API whose
 * entire job is to show caller → provider → cap traffic, returned an EMPTY
 * ARRAY on the live hub while the engine logged 39 717 calls a minute to a
 * single collection. An empty graph reads as "nothing is calling anything".
 *
 * The caller is always known — it is whoever made the call — and "who is
 * hammering this cap" is the question the graph exists to answer. So the
 * observation is recorded and the unknown half stays VISIBLY unknown, which is
 * a fact an operator can act on, rather than absent, which is a fact nobody can
 * see. Naming the provider properly needs the cluster-wide cap list; until then
 * this placeholder is the honest value.
 */
export const UNRESOLVED_PROVIDER_ADDON_ID = '(unresolved: cross-process)'

/**
 * Record one cap call, if an observer is configured. Extracted so the rule —
 * an unresolved provider never erases the caller — has ONE place and a test.
 */
export function recordCapUsage(
  observerOpts: CapUsageObserverOptions,
  capName: string,
  methodName: string,
): void {
  try {
    observerOpts.observer({
      callerAddonId: observerOpts.callerAddonId,
      providerAddonId: observerOpts.providerAddonIdForCap(capName) ?? UNRESOLVED_PROVIDER_ADDON_ID,
      capName,
      methodName,
      atMs: Date.now(),
    })
  } catch {
    // Never affect the caller — observation is best-effort.
  }
}

/** Convert camelCase → kebab-case. */
function toKebab(name: string): string {
  return name.replace(/[A-Z]/g, (m, i: number) => (i > 0 ? '-' : '') + m.toLowerCase())
}

/**
 * Parse an `op.path` (e.g. `"pipelineExecutor.getAvailableEngines"`) into
 * the capability name (kebab-case) and the method name.
 */
function parsePath(path: string): { capName: string; method: string } | null {
  const dot = path.indexOf('.')
  if (dot < 0) return null
  const namespace = path.slice(0, dot)
  const method = path.slice(dot + 1)
  return { capName: toKebab(namespace), method }
}

// ── localProviderLink ──────────────────────────────────────────────

/**
 * Non-terminating tRPC link that intercepts calls when the target
 * capability has a provider registered in the local process.
 *
 * When a local provider is found and implements the requested method,
 * the call is made directly (zero serialization). When no local
 * provider exists, the call passes through to `next(op)`.
 *
 * This is the mechanism that makes `ctx.api.streamBroker.getBrokerStats.query()`
 * resolve in-process on the hub without going through Moleculer, and
 * makes `ctx.api.pipelineExecutor.runPipeline.mutate()` resolve locally
 * on a forked worker that has a co-located pipeline-executor.
 */
export function localProviderLink<TRouter extends AnyRouter>(
  resolver: LocalProviderResolver,
  observerOpts?: CapUsageObserverOptions,
): TRPCLink<TRouter> {
  const localBase =
    resolver.localNodeId !== undefined
      ? (resolver.localNodeId.split('/')[0] ?? resolver.localNodeId)
      : undefined
  return () => {
    return ({ op, next }) => {
      const parsed = parsePath(op.path)
      if (!parsed) return next(op)

      // Fill the method's declared input defaults. A Zod `.default()` only runs
      // where the schema is PARSED — the tRPC router — and an addon's cap call
      // never goes there, so every default silently arrived `undefined`. Three
      // production failures in one afternoon came from exactly that: a thrown
      // degrade engine, an empty notification body, and a NaN gif window
      // (2026-07-30). Additive only: a caller value always wins and unknown
      // keys (the inline `nodeId` routing pin!) survive untouched.
      const opWithDefaults =
        op.input === undefined
          ? op
          : { ...op, input: withCapInputDefaults(parsed.capName, parsed.method, op.input) }

      // Honor an explicit per-call node pin: when the caller pinned this op to
      // a node OTHER than the one we run on, do NOT short-circuit to our own
      // co-located provider of the same cap name — defer to the next link so
      // `ipcParentLink` lifts the pin and the parent's CapRouteResolver routes
      // it to the pinned node. Symmetric to the LocalChildRegistry sibling-skip
      // (the pin must win over a same-named co-located provider). Legacy
      // resolvers with no `localNodeId` keep the original local-first behavior.
      if (localBase !== undefined) {
        const pinnedNodeId = readNodePin(op.context)
        if (pinnedNodeId !== undefined && pinnedNodeId !== localBase) {
          return next(opWithDefaults)
        }
      }

      const provider = resolver.getByName(parsed.capName)
      if (!provider || typeof provider !== 'object') return next(opWithDefaults)

      const fn: unknown = Reflect.get(provider, parsed.method)
      if (typeof fn !== 'function') return next(opWithDefaults)

      if (observerOpts) recordCapUsage(observerOpts, parsed.capName, parsed.method)

      const localInput = CALLER_STAMPED_CAPABILITIES.includes(parsed.capName)
        ? stampCallerAddonId(opWithDefaults.input, observerOpts?.callerAddonId)
        : opWithDefaults.input

      // Call the local provider directly — no serialization.
      return observable((observer) => {
        Promise.resolve((fn as (input: unknown) => unknown).call(provider, localInput))
          .then((data) => {
            observer.next({ result: { type: 'data', data } })
            observer.complete()
          })
          .catch((cause: unknown) => {
            observer.error(
              TRPCClientError.from(cause instanceof Error ? cause : new Error(String(cause))),
            )
          })
        // No teardown needed — the promise resolves once.
        return () => {}
      })
    }
  }
}

// ── brokerTransportLink ────────────────────────────────────────────

/**
 * Terminating tRPC link that routes calls through a Moleculer broker.
 *
 * This is the worker-side fallback when no WSS connection to the hub
 * is available. Translates `op.path` to a Moleculer action name
 * following the `addon-service-factory` naming convention:
 *
 *   op.path = "pipelineExecutor.getAvailableEngines"
 *   → capName = "pipeline-executor"
 *   → action = "pipeline-executor.pipeline-executor.getAvailableEngines"
 *   → broker.call(action, input)
 *
 * MsgPack serializer handles binary natively — no TypedArray workaround needed.
 *
 * Routing (service discovery + node resolution + `capActionName`) is delegated
 * to the shared {@link resolveBrokerCapCall} core — the SAME core
 * `brokerCallForCap` uses. This link only adds its observable wrapper,
 * cap-usage instrumentation, and AbortSignal handling around the resolved
 * dispatch, so the convention can never drift from the F0 fallback.
 */
/**
 * Scan the broker's service registry and return every service + node
 * pairing that exposes the action `${capName}.${method}`. Moleculer service
 * schemas map 1:1 to addonIds via `createAddonService`, so for a cap
 * implemented by the `detection-pipeline` addon this returns entries with
 * `serviceName === "detection-pipeline"`.
 *
 * When `forceServiceName` is provided, only candidates whose service name
 * matches are returned (used when a static serviceMap override fixes the
 * service name and we still need to know which node hosts it).
 */
interface ServiceCandidate {
  readonly serviceName: string
  readonly nodeId: string
}

function findServiceCandidates(
  broker: ServiceBroker,
  capName: string,
  method: string,
  forceServiceName?: string,
): readonly ServiceCandidate[] {
  const actionSuffix = capActionSuffix(capName, method)
  // Bare action key registered by `addon-service-factory.ts:145` —
  // every addon service exposes `<capName>.<method>` directly. Without
  // checking this form we miss the camera-streams cap (svc=stream-broker,
  // action=camera-streams.getRtspEntries) and end up falling back to
  // `<capName>.<capName>.<method>` in the caller, producing the broken
  // `Service 'camera-streams.camera-streams.getRtspEntries' is not found`
  // error reported on devices that go through the snapshot wrapper.
  const bareAction = capBareAction(capName, method)
  const registry = Reflect.get(broker, 'registry') as
    | {
        getServiceList?: (
          opts: Record<string, boolean>,
        ) => readonly { name: string; nodeID: string; actions?: Record<string, unknown> }[]
      }
    | undefined
  const services = registry?.getServiceList?.({ onlyAvailable: true, withActions: true }) ?? []
  const out: ServiceCandidate[] = []
  for (const svc of services) {
    if (forceServiceName && svc.name !== forceServiceName) continue
    const actions = svc.actions ?? {}
    if (
      Object.keys(actions).some(
        (a) => a.endsWith(actionSuffix) || a === `${svc.name}${actionSuffix}` || a === bareAction,
      )
    ) {
      out.push({ serviceName: svc.name, nodeId: svc.nodeID })
    }
  }
  return out
}

/**
 * Resolve the target Moleculer node for a user-provided `nodeId`.
 *
 * Forkable addons run on sub-nodes like `hub/detection-pipeline` — the UI
 * picker exposes only parent nodes (`hub`, `agent-1`), so when the caller
 * pins to `hub` but the service actually lives on `hub/detection-pipeline`
 * Moleculer returns "service not found on 'hub' node". This helper
 * promotes the parent nodeId to the matching child when that's where the
 * action is hosted.
 *
 *   exact match  → use that node
 *   child match  → use the `${preferredNodeId}/…` node that hosts the action
 *   otherwise   → return the preferred nodeId as-is (Moleculer will surface the miss)
 */
function resolveTargetNode(
  candidates: readonly ServiceCandidate[],
  preferredNodeId: string,
): ServiceCandidate | null {
  const exact = candidates.find((c) => c.nodeId === preferredNodeId)
  if (exact) return exact
  const child = candidates.find((c) => c.nodeId.startsWith(`${preferredNodeId}/`))
  if (child) return child
  return null
}

/**
 * Await service discovery for a load-balanced (non-node-pinned) call
 * and return the candidate set. Polls the broker's service registry
 * until a provider for the requested capability appears.
 *
 * **Does not time out.** Caps come and go at any point in a cluster's
 * lifecycle (addon restarts, worker reconnects, agents that join
 * late). A timeout here would make `ctx.api.*` location-aware — fast
 * in-process callers succeed, forked callers under load fail. The
 * whole point of this layer is to hide that difference.
 *
 * Only called when the caller did NOT pin a specific `nodeId` in the
 * input payload. When a nodeId IS pinned the caller has chosen the
 * target node explicitly; that path uses `awaitPinnedServiceCandidates`
 * which applies a bounded retry to absorb the service-registry
 * propagation window (typically 1–2s for forked child processes).
 *
 * The `abort` signal gives tRPC a clean shutdown path when the
 * subscription is torn down while still polling.
 */
/**
 * Caps that are NEVER exposed cross-process (hub-only tRPC core
 * routers). Workers calling `api.<cap>.<method>` for these end up
 * polling forever in the legacy unbounded path. Fast-fail after a
 * short window so the caller falls back gracefully (see
 * `device-state-handle`'s `ensureBridge` which checks the bridge
 * return value and skips silently when undefined).
 */
/**
 * Caps whose providers never appear in the Moleculer cluster registry.
 *
 *  - `live` / `systemEvents` — hub-only routers. Workers reach for them
 *    via the parent UDS bridge; the cluster never sees them.
 *  - `stream-catalog` — device-scope native cap whose providers are
 *    `BaseDevice` subclasses inside their addon runner. They are
 *    registered with the parent's `CapRouteResolver` (resolved per
 *    deviceId) but never advertised as a Moleculer service named
 *    `stream-catalog.getCatalog`. When the resolver returns
 *    `no-provider` (mid-boot window, provider not yet up, device not
 *    yet probed) the broker fallback used to wait 30 s for a service
 *    that will never appear — fast-fail in 5 s instead, the caller's
 *    `withCatalogTimeout(12 s)` already retries on the next poll tick.
 */
const NEVER_BRIDGED_CAPS: ReadonlySet<string> = new Set(['live', 'systemEvents', 'stream-catalog'])
const NEVER_BRIDGED_TIMEOUT_MS = 5_000

/**
 * Hard deadline for service discovery on a load-balanced cap call.
 *
 * Before this constant existed, `awaitServiceCandidates` polled forever
 * if a service never (re-)appeared — every consumer of a wedged cap then
 * hung indefinitely (observed live as `[brokerTransportLink] still
 * awaiting … after 200s+` in dev logs, cascading through every chain
 * that touched the affected cap). With the deadline in place, a missing
 * provider surfaces as a Moleculer "service not found" rejection at the
 * caller site after at most ~30s — within the cold-boot / respawn
 * window for any well-behaved addon, while still bounding the failure
 * mode of a genuinely-stuck cap.
 *
 * Callers that legitimately need to wait longer (e.g. boot ordering)
 * use `ctx.acquireCapability(name, scope, { timeoutMs })` BEFORE issuing
 * the RPC — see CLAUDE.md's "Do not re-implement Moleculer discovery /
 * liveness / events" rule. Per-link override is exposed for tests +
 * tuning via `BrokerTransportLinkOptions.discoveryTimeoutMs`.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000

async function awaitServiceCandidates(
  broker: ServiceBroker,
  capName: string,
  method: string,
  forceServiceName: string | undefined,
  abort: { aborted: boolean },
  discoveryTimeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS,
): Promise<readonly ServiceCandidate[]> {
  // First-attempt fast path — covers the common case where the
  // service is already discoverable.
  const first = findServiceCandidates(broker, capName, method, forceServiceName)
  if (first.length > 0) return first

  // Hub-only routers never appear in the worker's cluster registry —
  // bound the wait so workers don't burn CPU + log spam forever when
  // they reach for them. The caller's observer rejects with an error
  // that callers like `device-state-handle.ensureBridge` swallow.
  const isNeverBridged = NEVER_BRIDGED_CAPS.has(capName)

  // Poll until the service appears OR the discovery deadline elapses.
  // Every 30s emit a `warn` so a slow discovery surfaces in the log;
  // at the deadline emit a terminal `warn` and fast-fail so the
  // caller's `.query(...)` rejects instead of hanging forever.
  const startedAt = Date.now()
  let iterations = 0
  while (!abort.aborted) {
    await new Promise((r) => setTimeout(r, 100))
    const candidates = findServiceCandidates(broker, capName, method, forceServiceName)
    if (candidates.length > 0) return candidates
    iterations++
    if (isNeverBridged && Date.now() - startedAt >= NEVER_BRIDGED_TIMEOUT_MS) {
      // Fast-fail with empty candidates — the link's downstream
      // `broker.call` will fail with a precise "service not found"
      // error which the caller handles instead of polling forever.
      return []
    }
    if (Date.now() - startedAt >= discoveryTimeoutMs) {
      // Hard deadline reached — return empty candidates so the
      // downstream `broker.call` fails with "service not found" at
      // the caller site. Logged at warn (deliberate stderr sink — see
      // comment on the 30s "still awaiting" log below for the rationale).
      console.warn(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        `[brokerTransportLink] discovery deadline exceeded for ${capName}.${method} after ${Date.now() - startedAt}ms on ${broker.nodeID} — call will fast-fail`,
      )
      return []
    }
    if (iterations % 300 === 0) {
      // Deliberate, documented residual: this runs INSIDE the tRPC
      // transport link itself. Routing a `$hub.log` RPC from here would
      // be self-referential (the transport logging through the transport)
      // and risk a feedback loop while service discovery is still
      // resolving. stderr is the safe diagnostic sink for this poll.
      console.warn(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        `[brokerTransportLink] still awaiting ${capName}.${method} after ${Date.now() - startedAt}ms on ${broker.nodeID}`,
      )
    }
  }
  return []
}

/**
 * Await service discovery for a node-pinned call, applying a bounded
 * retry to absorb the Moleculer service-registry propagation window.
 *
 * When a child process emits a capability-ready event, the hub's local
 * service registry may not yet reflect the child's service registration
 * (typically a 1–2s gap). Without retry, `broker.call({nodeID})` fails
 * immediately with "service not found" even though the capability IS ready.
 *
 * Polls `findServiceCandidates` until a candidate matching `preferredNodeId`
 * is found via `resolveTargetNode`, using the same 100ms cadence as the
 * load-balanced path. After `timeoutMs` (default 2 000ms), returns whatever
 * candidates are available — Moleculer will surface the real "not found"
 * error at the `broker.call` site so genuine operator mistakes still bubble up.
 */
async function awaitPinnedServiceCandidates(
  broker: ServiceBroker,
  capName: string,
  method: string,
  forceServiceName: string | undefined,
  preferredNodeId: string,
  abort: { aborted: boolean },
  timeoutMs = 2_000,
): Promise<readonly ServiceCandidate[]> {
  const deadline = Date.now() + timeoutMs
  while (!abort.aborted) {
    const candidates = findServiceCandidates(broker, capName, method, forceServiceName)
    if (resolveTargetNode(candidates, preferredNodeId) !== null) return candidates
    if (Date.now() >= deadline) return candidates
    await new Promise((r) => setTimeout(r, 100))
  }
  return []
}

/**
 * Resolved Moleculer dispatch target for a cap call — the output of the single
 * service-discovery + node-resolution + `capActionName` core shared by
 * `brokerTransportLink` and `brokerCallForCap`.
 */
interface ResolvedBrokerCapCall {
  /** Moleculer action `${serviceName}.${capName}.${method}`. */
  readonly action: string
  /** Params to forward (binary-serialized, routing-only inline `nodeId` stripped). */
  readonly callInput: unknown
  /** Calling options — `{ nodeID }` when a target node resolved, else undefined. */
  readonly callOpts: { nodeID: string } | undefined
  /** The Moleculer service hosting the action (= provider addonId by convention). */
  readonly serviceName: string
}

/** Options for {@link resolveBrokerCapCall}. */
interface ResolveBrokerCapCallOpts {
  /** Explicit node pin (fallback path). Inline `args.nodeId` is used when absent. */
  readonly nodeId?: string
  /** Static service-name override for the cap. */
  readonly forceServiceName?: string
  /** Abort flag — flipped by the caller to tear down a pending discovery wait. */
  readonly abort: { aborted: boolean }
  /**
   * Hard deadline for the load-balanced discovery wait (the pinned path
   * has its own bounded retry via `awaitPinnedServiceCandidates`). Used
   * by tests + tuning. Default {@link DEFAULT_DISCOVERY_TIMEOUT_MS}.
   */
  readonly discoveryTimeoutMs?: number
}

/**
 * The input field a caller uses to NAME one provider of a collection cap.
 *
 * The same spelling the hub-side mount reads (`PROVIDER_PIN_FIELD` in
 * `device-collection-dispatch.ts`), because a pin with two spellings is a pin
 * only one half of the system honours — which is exactly what happened.
 */
const PROVIDER_PIN_FIELD = 'provider'

/**
 * Narrow the discovered candidates to the provider the caller NAMED.
 *
 * ## Why this exists at the transport, and not only at the hub's mount
 *
 * A `collection` cap has several providers, and the hub's tRPC mount already
 * refuses a pin nobody answers rather than letting a sibling answer it
 * (`pinnedProvider`, D552/D554). A cross-process addon never reaches that
 * mount: `ctx.api.<cap>.<method>` leaves its runner over Moleculer, and the
 * dispatch below used to take `candidates[0]` — the first entry in the
 * broker's discovery order. On this hub `videoclips` has three providers, so
 * the operator's clip tap was answered by `recorder` ("an analytics visit has
 * no file behind it") and, after a redeploy in a different order, by
 * `export-hap` ("was not minted by the HomeKit source") — the same clip, two
 * different wrong answers, while the call carried the provider's name twice
 * over and nothing read it (2026-09-22).
 *
 * Moleculer service names map 1:1 to addon ids (`createAddonService`), so the
 * pin is matched against `serviceName` directly.
 *
 * ## Why only when the choice is AMBIGUOUS
 *
 * `provider` is an ordinary parameter name on caps that have one
 * implementation, and 44 capabilities on this hub have more than one provider
 * row. With a single distinct service there is nothing to choose, so an
 * unmatched string is left alone: turning it into a refusal would break calls
 * whose routing was never in question. With several, an unmatched pin is
 * refused BY NAME and the candidates are listed — the caller asked for one
 * addon and must not silently receive another's answer.
 *
 * Unpinned calls are deliberately unchanged. "Which provider should an
 * unpinned cross-process collection call reach" is a separate question from
 * "was the pin honoured", and answering it here would change 44 capabilities
 * at once.
 */
function narrowToPinnedProvider(
  candidates: readonly ServiceCandidate[],
  input: unknown,
  capName: string,
  method: string,
): readonly ServiceCandidate[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return candidates
  const pin: unknown = Reflect.get(input, PROVIDER_PIN_FIELD)
  if (typeof pin !== 'string' || pin.length === 0) return candidates
  const services = new Set(candidates.map((c) => c.serviceName))
  if (services.size < 2) return candidates
  const picked = candidates.filter((c) => c.serviceName === pin)
  if (picked.length > 0) return picked
  throw new Error(
    `Capability "${capName}.${method}": no service answers provider "${pin}". ` +
      `Candidates: ${[...services].join(', ')}. ` +
      `A pin nobody answers is refused rather than served by another provider.`,
  )
}

/**
 * THE single source of truth for turning a (capName, method, args) cap call into
 * a concrete Moleculer dispatch: serialize binary args, strip the routing-only
 * inline `nodeId`, await service discovery (bounded retry when node-pinned,
 * unbounded load-balanced wait otherwise), resolve the target node + service,
 * and build the action via `capActionName`.
 *
 * Both `brokerTransportLink` (worker-side transport link) and `brokerCallForCap`
 * (hub/agent `onUnownedCall` F0 fallback) call this, so the discovery +
 * action-naming convention can never drift between them. Each caller performs
 * its OWN `broker.call` afterwards — the link wraps it in an observable with
 * cap-usage instrumentation, the fallback awaits it directly — and re-checks
 * `abort` after this resolves; hence this returns the target rather than
 * dispatching. (Drift guard: trpc-links-broker-drift.spec.ts.)
 */
async function resolveBrokerCapCall(
  broker: ServiceBroker,
  capName: string,
  method: string,
  rawArgs: unknown,
  opts: ResolveBrokerCapCallOpts,
): Promise<ResolvedBrokerCapCall> {
  const safeInput = rawArgs === undefined ? undefined : serializeTypedArrays(rawArgs)
  const inputObj =
    safeInput && typeof safeInput === 'object' && !Array.isArray(safeInput)
      ? (safeInput as Record<string, unknown>)
      : null
  // Pin source: an explicit `opts.nodeId` (fallback path) OR an inline `nodeId`
  // field carried in the args object (transport-link path). Strip the inline
  // field from the forwarded params whenever it pinned the call.
  const pinnedNodeId =
    opts.nodeId ?? (inputObj && typeof inputObj.nodeId === 'string' ? inputObj.nodeId : undefined)
  const callInput =
    pinnedNodeId !== undefined && inputObj && typeof inputObj.nodeId === 'string'
      ? (() => {
          const { nodeId: _drop, ...rest } = inputObj
          return rest
        })()
      : safeInput

  const candidates = pinnedNodeId
    ? await awaitPinnedServiceCandidates(
        broker,
        capName,
        method,
        opts.forceServiceName,
        pinnedNodeId,
        opts.abort,
      )
    : await awaitServiceCandidates(
        broker,
        capName,
        method,
        opts.forceServiceName,
        opts.abort,
        opts.discoveryTimeoutMs,
      )

  // The provider pin picks the SERVICE; the node pin then picks the host among
  // that service's nodes. Both, in that order — a pin is not a node.
  const eligible = narrowToPinnedProvider(candidates, callInput, capName, method)

  const resolved = pinnedNodeId ? resolveTargetNode(eligible, pinnedNodeId) : null
  const serviceName =
    resolved?.serviceName ?? opts.forceServiceName ?? eligible[0]?.serviceName ?? capName
  const targetNodeId = resolved?.nodeId ?? pinnedNodeId
  const action = capActionName(serviceName, capName, method, false)
  const callOpts = targetNodeId ? { nodeID: targetNodeId } : undefined
  return { action, callInput, callOpts, serviceName }
}

/**
 * Options for {@link brokerCallForCap} — the reusable broker-dispatch core
 * shared by `brokerTransportLink` and the parent-side `onUnownedCall` fallback.
 */
export interface BrokerCapCallOpts {
  /**
   * Pins the call to a specific Moleculer node. When set, the call uses the
   * bounded pinned-discovery retry (2s) and surfaces "service not found" fast,
   * mirroring `brokerTransportLink`'s pinned path. When absent, the call uses
   * the unbounded load-balanced discovery wait.
   */
  readonly nodeId?: string
  /** Static service-name override for the cap (matches `brokerTransportLink`'s serviceMap entry). */
  readonly forceServiceName?: string
  /**
   * Abort flag — set `aborted = true` to tear down a pending discovery wait.
   * Defaults to a never-aborted flag when omitted.
   */
  readonly abort?: { aborted: boolean }
}

/**
 * Resolve and dispatch a cap method call over a Moleculer broker.
 *
 * Routing (service discovery + node resolution + `capActionName`) is delegated
 * to the shared {@link resolveBrokerCapCall} core — the SAME core
 * `brokerTransportLink` uses — so the two can never drift. This function is the
 * thin "resolve then `broker.call`" wrapper.
 *
 * What this function IS used for:
 *   The hub / agent parent-side `onUnownedCall` fallback (F0 — when a forked
 *   child calls a cap no local sibling owns and the resolver returns `no-provider`,
 *   e.g. the hub's `$core-caps` / `$stream-probe` core services, which are
 *   Moleculer services NOT registered as CapabilityRegistry providers).
 *
 * A genuinely-absent service surfaces the broker's "service not found" error
 * (bounded for pinned calls) rather than hanging.
 */
export async function brokerCallForCap(
  broker: ServiceBroker,
  capName: string,
  method: string,
  args: unknown,
  opts?: BrokerCapCallOpts,
): Promise<unknown> {
  const abort = opts?.abort ?? { aborted: false }
  const { action, callInput, callOpts } = await resolveBrokerCapCall(
    broker,
    capName,
    method,
    args,
    {
      ...(opts?.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
      ...(opts?.forceServiceName !== undefined ? { forceServiceName: opts.forceServiceName } : {}),
      abort,
    },
  )

  if (abort.aborted) {
    throw new Error(`brokerCallForCap: aborted while awaiting "${capName}.${method}" discovery`)
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return broker.call(action, callInput, callOpts)
}

/**
 * Tunables for {@link brokerTransportLink}.
 *
 * `discoveryTimeoutMs` bounds the load-balanced service-discovery wait
 * inside `awaitServiceCandidates`. Default {@link DEFAULT_DISCOVERY_TIMEOUT_MS}.
 * Overriding is for tests + tuning — production callers that need a
 * different deadline should use `ctx.acquireCapability` instead, since
 * that's the documented liveness mechanism (CLAUDE.md).
 */
export interface BrokerTransportLinkOptions {
  readonly discoveryTimeoutMs?: number
}

/**
 * Dispatch a call to a device-scoped capability. Supplied by the hub, where it
 * is `callCapabilityOnNode` — the entry the codegen cap routers already use,
 * which extracts the `deviceId` from the input and asks the `CapRouteResolver`.
 */
export type DeviceCapDispatcher = (
  capName: string,
  method: string,
  input: unknown,
) => Promise<unknown>

/**
 * The link that lets an IN-PROCESS addon call a device-scoped cap.
 *
 * Without it the hub's own `ctx.api` chain is `localProviderLink →
 * brokerTransportLink`: a provider in this process, then the Moleculer
 * registry. Forked addon children are BROKER-LESS (UDS), so a device provider
 * such as hikvision's `ptz` advertises nothing on the bus, no service candidate
 * matches, and the call falls back to the `<cap>.<cap>.<method>` shape
 * documented above as the broken one. A forked addon never hits this because
 * its chain ends at `ipcParentLink` → the parent's `CapRouteResolver`; an
 * in-process one had no way to reach that authority at all.
 *
 * Deliberately narrow: it intercepts ONLY a cap whose definition says
 * `scope: 'device'`, and only when the call actually carries a numeric
 * `deviceId` to route on. A system cap that happens to take a `deviceId`
 * argument (`deviceManager.getBindings`, `deviceState.getCapSlice`) is left
 * exactly where it was. There is no fallback to the broker after a resolver
 * failure, on purpose: the resolver's error names the node and the reason,
 * and replacing it with "service not found" is how this class of bug hides.
 */
export function deviceCapResolverLink<TRouter extends AnyRouter>(
  dispatch: DeviceCapDispatcher,
  isDeviceScoped: (capName: string) => boolean,
): TRPCLink<TRouter> {
  return () => {
    return ({ op, next }) => {
      const parsed = parsePath(op.path)
      if (!parsed || !isDeviceScoped(parsed.capName)) return next(op)
      const input = op.input
      const deviceId =
        input !== null && typeof input === 'object' ? Reflect.get(input, 'deviceId') : undefined
      if (typeof deviceId !== 'number' || !Number.isFinite(deviceId)) return next(op)

      return observable((observer) => {
        dispatch(parsed.capName, parsed.method, input)
          .then((data) => {
            observer.next({ result: { type: 'data', data } })
            observer.complete()
          })
          .catch((cause: unknown) => {
            observer.error(
              TRPCClientError.from(cause instanceof Error ? cause : new Error(String(cause))),
            )
          })
        return () => {}
      })
    }
  }
}

export function brokerTransportLink<TRouter extends AnyRouter>(
  broker: ServiceBroker,
  serviceMap?: Readonly<Record<string, string>>,
  observerOpts?: CapUsageObserverOptions,
  linkOptions?: BrokerTransportLinkOptions,
): TRPCLink<TRouter> {
  const map = serviceMap ?? {}
  const discoveryTimeoutMs = linkOptions?.discoveryTimeoutMs

  return () => {
    return ({ op }) => {
      return observable((observer) => {
        const parsed = parsePath(op.path)
        if (!parsed) {
          observer.error(
            TRPCClientError.from(new Error(`brokerTransportLink: invalid op.path "${op.path}"`)),
          )
          return () => {}
        }

        const mapped = map[op.path.split('.')[0]!]

        // Routing (binary serialize, inline-`nodeId` strip + pinning, service
        // discovery — bounded 2s retry when pinned, unbounded load-balanced wait
        // otherwise — and `capActionName`) is delegated to `resolveBrokerCapCall`
        // below. Callers that need bounded waiting for the load-balanced case
        // pass a tRPC `AbortSignal` through the query/mutation options; the
        // teardown below rejects the observer with an AbortError so the
        // `.query(...)` promise rejects at the caller site.
        const abort = { aborted: false }
        // Hook the caller-supplied AbortSignal so bounded-waiting
        // patterns work: `ctx.api.x.y.query(input, { signal })` flips
        // `abort.aborted` when the caller cancels, which causes the
        // polling loop (or the in-flight broker.call) to teardown and
        // the observer to reject with an aborted error.
        const callerSignal = (op as { signal?: AbortSignal | null }).signal
        const onAbort = () => {
          abort.aborted = true
        }
        if (callerSignal && typeof callerSignal.addEventListener === 'function') {
          if (callerSignal.aborted) abort.aborted = true
          else callerSignal.addEventListener('abort', onAbort, { once: true })
        }

        void (async () => {
          // RESOLUTION can refuse — a provider pin no service answers is the
          // named case (`narrowToPinnedProvider`). Before this try/catch a
          // throw here escaped the observable entirely: the promise became an
          // unhandled rejection and the caller's `.query(...)` never settled,
          // so a refusal was indistinguishable from a hang. A branch that
          // drops the caller's work says so, through the caller's own channel.
          let resolvedCall: ResolvedBrokerCapCall
          try {
            resolvedCall = await resolveBrokerCapCall(
              broker,
              parsed.capName,
              parsed.method,
              op.input,
              {
                ...(mapped !== undefined ? { forceServiceName: mapped } : {}),
                ...(discoveryTimeoutMs !== undefined ? { discoveryTimeoutMs } : {}),
                abort,
              },
            )
          } catch (cause: unknown) {
            if (abort.aborted) return
            observer.error(
              TRPCClientError.from(cause instanceof Error ? cause : new Error(String(cause))),
            )
            return
          }
          const { action, callInput, callOpts, serviceName } = resolvedCall
          if (abort.aborted) {
            observer.error(
              TRPCClientError.from(
                new Error(
                  `brokerTransportLink: aborted while awaiting "${parsed.capName}.${parsed.method}" discovery`,
                ),
              ),
            )
            return
          }

          if (observerOpts) {
            try {
              // For broker-routed calls, the resolved Moleculer service
              // IS the provider addon (camstack convention: each addon
              // registers its native-cap service under its own addonId).
              // Falls back to the upstream resolver if discovery couldn't
              // distinguish service from cap.
              const providerAddonId =
                serviceName !== parsed.capName
                  ? serviceName
                  : observerOpts.providerAddonIdForCap(parsed.capName)
              // Same rule as the local link: an unresolved provider must not
              // erase the caller. See UNRESOLVED_PROVIDER_ADDON_ID.
              observerOpts.observer({
                callerAddonId: observerOpts.callerAddonId,
                providerAddonId: providerAddonId ?? UNRESOLVED_PROVIDER_ADDON_ID,
                capName: parsed.capName,
                methodName: parsed.method,
                atMs: Date.now(),
              })
            } catch {
              // Observation is best-effort — never affect the caller.
            }
          }

          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            const data = await broker.call(action, callInput, callOpts)
            if (abort.aborted) return
            observer.next({ result: { type: 'data', data } })
            observer.complete()
          } catch (cause: unknown) {
            if (abort.aborted) return
            observer.error(
              TRPCClientError.from(cause instanceof Error ? cause : new Error(String(cause))),
            )
          }
        })()

        return () => {
          abort.aborted = true
          if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
            callerSignal.removeEventListener('abort', onAbort)
          }
        }
      })
    }
  }
}

// ── ipcParentLink ──────────────────────────────────────────────────
/**
 * Middle link that routes a child addon's outbound `ctx.api` cap call to the
 * parent hub over UDS via `callOut` (obtained at call-time so the child can
 * reconnect without rebuilding its tRPC client).
 *
 * Delegation rules:
 *  - `getCallOut()` returns `null`  → not connected, delegate via `next(op)`.
 *  - `parsePath(op.path)` returns `null` → unparseable path, delegate via `next(op)`.
 *  - `callOut` rejects with a no-route error (message starts with `UDS_NO_ROUTE_PREFIX`)
 *    → the parent could not route the call (no local sibling, no cluster fallback);
 *    delegate via `next(op)` (broker fallback) — safe because no provider ran.
 *  - `callOut` rejects with any other error → real provider error; propagate to
 *    the caller via `observer.error` — NEVER retry via broker to avoid
 *    double-executing side effects.
 */
export function ipcParentLink<TRouter extends AnyRouter>(
  getCallOut: () => ((input: CapCallInput) => Promise<unknown>) | null,
): TRPCLink<TRouter> {
  return () => {
    return ({ op, next }) => {
      const callOut = getCallOut()
      const parsed = parsePath(op.path)

      if (callOut === null || parsed === null) return next(op)

      const input = op.input
      const inputObj =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : null
      const deviceId =
        inputObj && typeof Reflect.get(inputObj, 'deviceId') === 'number'
          ? (Reflect.get(inputObj, 'deviceId') as number)
          : undefined

      // Lift an out-of-band per-call node pin (set via `nodePin(nodeId)` in the
      // call's tRPC context) onto the wire — the parent's `onUnownedCall` passes
      // it to the resolver so a singleton/in-process cap can be served by a
      // SPECIFIC node (e.g. a remote agent's own platform-probe), not the hub.
      const pinnedNodeId = readNodePin(op.context)

      const capCallInput: CapCallInput = {
        capName: parsed.capName,
        method: parsed.method,
        args: op.input,
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(pinnedNodeId !== undefined ? { nodeId: pinnedNodeId } : {}),
      }

      return observable((observer) => {
        callOut(capCallInput).then(
          (data) => {
            observer.next({ result: { type: 'data', data } })
            observer.complete()
          },
          (cause: unknown) => {
            const err = cause instanceof Error ? cause : new Error(String(cause))
            if (err.message.startsWith(UDS_NO_ROUTE_PREFIX)) {
              // No provider was reached — safe to retry via broker.
              next(op).subscribe(observer)
            } else {
              // Real provider error — propagate, never retry.
              observer.error(TRPCClientError.from(err))
            }
          },
        )
        // No teardown needed — the promise resolves once.
        return () => {}
      })
    }
  }
}

// ── Factory: build the link chain for a given context ──────────────

export type LinkChainTarget =
  | { type: 'local-router'; terminatingLink: TRPCLink<AnyRouter> }
  | { type: 'ws'; terminatingLink: TRPCLink<AnyRouter> }
  | { type: 'broker'; broker: ServiceBroker; serviceMap?: Readonly<Record<string, string>> }

/**
 * Optional observer hookup for `buildLinkChain` — threads the same
 * `CapUsageObserverOptions` through `localProviderLink` and
 * `brokerTransportLink` so every op is recorded once regardless of
 * whether it resolved locally or over the broker.
 */
export interface LinkChainObserverHookup {
  readonly observerOpts?: CapUsageObserverOptions
}

/**
 * Build the tRPC link chain for an addon context.
 *
 * Always starts with `localProviderLink` (if a resolver is provided),
 * then falls through to the appropriate terminating link based on the
 * deployment context.
 */
export function buildLinkChain(
  target: LinkChainTarget,
  localResolver?: LocalProviderResolver,
  hookup?: LinkChainObserverHookup,
): TRPCLink<AnyRouter>[] {
  const links: TRPCLink<AnyRouter>[] = []

  if (localResolver) {
    links.push(localProviderLink(localResolver, hookup?.observerOpts))
  }

  switch (target.type) {
    case 'local-router':
    case 'ws':
      links.push(target.terminatingLink)
      break
    case 'broker':
      links.push(brokerTransportLink(target.broker, target.serviceMap, hookup?.observerOpts))
      break
  }

  return links
}
