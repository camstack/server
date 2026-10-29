import type { IReadinessRegistryRecord, SystemEvent } from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types/addon'
import type { CapUsageCallRecord } from '../moleculer/cap-usage-registry.js'
import { PARENT_ROUTED_PROVIDER_ADDON_ID } from '../moleculer/cap-usage-registry.js'
import { matchesPattern } from '../moleculer/event-bus-core.js'
import {
  capActionLabel,
  createCapActionCensus,
  type CapActionCensus,
  type CapActionReading,
} from './cap-action-census.js'
import { buildCapChildIndex, type CapChildIndex } from './cap-child-index.js'
import { liftRoutingHints, type CapRoutingHints } from './cap-routing-hints.js'
import { extractDeviceId } from './cap-route-resolver.js'
import { answerClaimedGetStatus, GET_STATUS_METHOD } from './claimed-get-status.js'
import { answerDeviceCallRedirect, type DeviceCallRedirectHook } from './device-call-redirect.js'
import type { ClaimedStatusResolver } from '../status-overlay.js'
import type {
  AddonCallInput,
  AddonCallMessage,
  CapCallInput,
  CapCallMessage,
  CapCallOutMessage,
  ChildCapDescriptor,
  ChildEventMessage,
  ChildLogMessage,
  ChildToParentRequest,
  EventSubUpdateMessage,
  ParentEventMessage,
  ReadinessSnapshotResponse,
  RegisterAck,
  RegisteredChild,
  SetLogLevelMessage,
} from './child-cap-protocol.js'
import { unpackPayload } from './frame-codec.js'
import type { LocalChannel, LocalTransportServer } from './local-transport.js'
import type { SocketTrafficSample } from './socket-traffic.js'

/**
 * How many child `cap-call-out`s this parent forwarded WITHOUT reading their
 * args (`raw`) against how many it decoded (`decoded`: an inline-args frame,
 * a target that cannot take a payload, or a call that left the sibling path
 * for `onUnownedCall`). Cumulative; the heartbeat reports the window.
 *
 * It exists because raw-forward makes the parent blind to the bytes on
 * purpose, and the one thing it must not be blind to is how often that
 * happens. A plane that says "raw=0" under load is a plane where the
 * negotiation failed, and nothing else would show it.
 */
export interface ForwardCensus {
  readonly raw: number
  readonly decoded: number
}

/**
 * Peer id the action census charges frames that arrived before `register`.
 *
 * One frame per connection, and it is named rather than dropped: a census is
 * only worth its coverage, and coverage you cannot see is coverage you cannot
 * check.
 */
export const PRE_REGISTER_PEER_ID = '(pre-register)'

/** The source every runner lifecycle event this registry emits carries. */
const LIFECYCLE_SOURCE = { type: 'core', id: 'local-child-registry' } as const

/** Per-child event fan-out counters (sent = delivered, suppressed = gated/would-gate). */
export interface ChildEventStats {
  sent: number
  suppressed: number
}

/**
 * D467 — one PRODUCED category over the life of the process.
 *
 * `broadcasts` counts emits, not deliveries: one call to
 * {@link LocalChildRegistry.broadcastEventToChildren} is one broadcast no
 * matter how many children are connected. This is the number the per-child
 * `sent`/`suppressed` counters cannot give — those are (event × child) pairs,
 * so on a 39-child node they read ~38x the production rate and a reader who
 * sums them concludes the cluster emits an order of magnitude more than it does.
 *
 * `wanted` is the number of (event × child) pairs whose SUBSCRIPTION matched —
 * the gate answer, which is also the delivery answer. `wanted === 0` over a window means
 * the category was serialised and walked across every child and **nobody asked
 * for it**: pure waste, and the one finding worth acting on.
 */
export interface CategoryFanoutSample {
  readonly category: string
  readonly broadcasts: number
  readonly wanted: number
}

/**
 * Cap on the census map. `EventCategory` is a closed enum of ~120 members, so
 * 256 holds every legitimate category twice over; the cap exists because a
 * hand-rolled topic (forbidden, but this is the meter that would SEE one) could
 * otherwise grow the map without bound in a long-lived process. Overflow is not
 * silent — {@link LocalChildRegistry.categoryCensusOverflow} counts it and the
 * heartbeat prints it.
 */
export const CATEGORY_CENSUS_MAX = 256

/**
 * Sentinel prefix used in the no-route error thrown when `cap-call-out` has no
 * local sibling and no `onUnownedCall` fallback. `ipcParentLink` detects this
 * prefix to distinguish routing failures (safe to retry via broker) from real
 * provider errors (must NOT retry to avoid double-executing side effects).
 */
export const UDS_NO_ROUTE_PREFIX = 'UDS_NO_ROUTE'

/**
 * Minimal logger interface accepted by `LocalChildRegistry`.
 * Kept narrow so the registry doesn't depend on any concrete logger class.
 */
export interface LocalChildRegistryLogger {
  info(msg: string, meta?: unknown): void
}

/**
 * Options accepted by `LocalChildRegistry`.
 * The `server` field is the UDS server to listen on.
 * The optional `onUnownedCall` is the parent-supplied fallback invoked when no
 * local child owns the requested cap (the hub / agent will wire this to the
 * cluster CapabilityRegistry).
 * The optional `logger` receives a single deduplicated INFO line the first time
 * each capName is routed child→sibling over UDS.
 */
/**
 * Where the registry says that a runner came up or went away — the parent's
 * kernel bus. A forked runner has no Moleculer broker (Phase F), so
 * `$node.connected` never fires for it and the Moleculer-side emitter
 * (`agent-registry.service.ts`) never sees one: this registry is the only place
 * that knows (fix round 1 of the 2026-10-02 motion-release-order work, C1).
 */
export interface ChildLifecycleEvents {
  /** This parent's node id (`'hub'`, or the bare agent id): the `<node>` of `<node>/<childId>`. */
  readonly parentNodeId: () => string
  /** The parent's kernel bus `emit`. Telemetry (D8): a consumer must survive a dropped event. */
  readonly emit: (event: SystemEvent) => void
  /**
   * After `WorkerOnline` is emitted and before the pre-init register is acked.
   * Production omits this and the registry uses {@link afterWorkerOnlineAnnounce}.
   * Tests inject a seam so dropping the await turns the lifecycle spec red.
   */
  readonly afterOnlineAnnounce?: () => Promise<void>
}

/**
 * One event-loop turn after `WorkerOnline` before the child's register is acked.
 * Gives a UDS sibling that already holds the frame (the orchestrator provider
 * gate) a turn to close its cameras before the child loads addons.
 */
export function afterWorkerOnlineAnnounce(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

export interface LocalChildRegistryOptions {
  readonly server: LocalTransportServer
  /**
   * Emit `WorkerOnline { workerId: '<parent>/<childId>' }` at a new
   * incarnation's FIRST register — the pre-init frame `LocalChildClient.start()`
   * sends before any addon module is loaded, so before `initialize()` and any
   * device restore; it is emitted, then one event-loop turn is yielded, before
   * that frame is acked — so a UDS consumer (the motion-slice provider gate)
   * already has the frame in its socket and one turn to close the gate before
   * the child proceeds to load — and `WorkerOffline` when the LIVE connection
   * closes (never for a superseded one). Omitted: nothing is emitted.
   */
  readonly lifecycleEvents?: ChildLifecycleEvents
  readonly onUnownedCall?: (input: CapCallInput) => Promise<unknown>
  readonly logger?: LocalChildRegistryLogger
  /**
   * Resolver for the operator's active-singleton preference. When two or
   * more local children register the SAME singleton capName (e.g. two
   * addons both providing `webrtc-session`), the registry must consult
   * `CapabilityRegistry` to pick the operator-selected provider instead of
   * returning the first-registered child by insertion order. Returns the preferred
   * addonId (== childId for solo-addon runners), or null when no
   * preference is set or the cap is not a singleton.
   */
  readonly getActiveSingletonAddonId?: (capName: string) => string | null
  /**
   * Resolve an addonId to its runner/child id — the addon's
   * `execution.group` when it declares one, else the addon id itself
   * (`resolveRunnerId`). Needed so the active-singleton preference (which
   * is expressed as an addonId) can be matched against the registry's
   * candidate CHILD ids: a grouped addon's child id is the group name, not
   * its own id. Omitted → identity (addonId === childId), preserving the
   * solo-runner behaviour for every ungrouped addon.
   */
  readonly resolveChildIdForAddon?: (addonId: string) => string
  /**
   * This node's own Moleculer nodeId (`'hub'` on the hub, the bare agent id on
   * an agent). Used ONLY to decide whether an explicit per-call `nodeId` pin
   * bypasses the local-sibling short-circuit in the `cap-call-out` path:
   *   - a pin naming THIS node is satisfied by a co-resident sibling (the pin's
   *     target lives here), so it routes locally exactly like an unpinned call;
   *   - a pin naming ANOTHER node bypasses the sibling and reaches
   *     `onUnownedCall` (so it is never silently answered by a same-named
   *     provider on the wrong node).
   *
   * Omitted (legacy / positional construction) ⇒ prior behaviour EXACTLY: any
   * pin bypasses the local sibling — without this node's id the registry cannot
   * distinguish a pin-to-self from a pin-to-another-node.
   */
  readonly ownNodeId?: string
  /**
   * Does `(capName, method)` name a `mode:'collection'` array method whose
   * contract is the UNION across every provider? Such a call must NOT be
   * short-circuited to a local sibling: `resolveChildId` picks ONE provider
   * (first-registered, or the singleton preference — meaningless here), so the
   * caller would see a fraction of the catalog the hub's own tRPC router
   * returns. It goes to `onUnownedCall`, which owns the aggregate over local
   * siblings, in-process providers and remote nodes alike.
   *
   * `notification-output` has three provider siblings; the Notification Center
   * landed on one holding no targets, read the empty list as "target deleted"
   * and permanently dead-lettered every notification it ever produced
   * (2026-07-30). Omitted ⇒ prior behaviour exactly (sibling short-circuit for
   * everything). The kernel has no cap registry, so the wiring side injects it.
   */
  readonly isAggregatedCollectionMethod?: (capName: string, method: string) => boolean
  /**
   * Does this call carry an explicit `{ addonId }` selector naming the provider
   * it wants? Such a call must NOT be short-circuited to a local sibling
   * either: `resolveChildId` picks the FIRST-registered child for the cap name,
   * which is the one thing the caller took the trouble to say it did not want.
   * It goes to `onUnownedCall`, which resolves the named provider.
   *
   * The third argument is the call's ROUTING HINTS (`{ nodeId?, addonId? }`,
   * `cap-routing-hints.ts`) — the two top-level string fields the parent ever
   * read out of the args — not the args themselves. Under raw-forward the
   * parent does not decode the args at all; the sender lifts the hints, and
   * for a legacy frame the parent lifts them itself. Both modes reach this
   * predicate with the same shape.
   *
   * The array-method bypass above and this one are the same defect seen twice.
   * `broker.getBrokerConfig({id:'ha_001', addonId:'provider-homeassistant'})`
   * from the Home Assistant export was answered by `provider-homematic` — which
   * returns `null` for a broker it does not own, indistinguishable from "no
   * such broker" — so the export could never open a link. Fixing only
   * `onUnownedCall` did nothing, because this decision is made first: measured
   * on the live hub with a deliberately bogus addonId, which came back `null`
   * instead of refused (2026-08-09, [D105]).
   *
   * Omitted ⇒ prior behaviour exactly. The kernel has no cap registry, so the
   * wiring side injects it, sharing the predicate with the handler that then
   * performs the routing — a rule implemented twice is a rule that drifts.
   */
  readonly isAddonPinnedCall?: (capName: string, method: string, hints: CapRoutingHints) => boolean
  /**
   * The hub's claim authority for a device-scoped `getStatus` (D663, ruling
   * S3) — fifth member of the "an explicit intent must win over a co-located
   * provider" family. A `getStatus` about a device whose cap is CLAIMED is
   * answered HERE, from the hub mirror's merged slice, before `resolveChildId`
   * is consulted: the sibling short-circuit would dispatch it straight to the
   * owning child, whose `getStatus` is the NATIVE slice — an HA-MQTT / HomeKit
   * exporter or the notification center (hub-local forked children) asking
   * `battery.getStatus({ deviceId })` of a device owned by the hub-local
   * `provider-homeassistant` child read the native value while the UI showed
   * the merged one. The parent's `onUnownedCall` had the same answer, on a path
   * this call never took. Same shared function (`answerClaimedGetStatus`) as
   * that handler and the hub's `callCapabilityOnNode`, so the three entries
   * cannot drift; a device whose claims are not yet known has them resolved
   * first and is never answered native.
   *
   * Omitted (the agent has no claim authority) ⇒ prior behaviour exactly. The
   * kernel has no cap registry, so the wiring side injects it.
   */
  readonly claimedStatus?: ClaimedStatusResolver
  /**
   * The device-call redirect (D963): asked right after the claim authority for a
   * COVERED device-scoped call — a media-player command whose role the device's
   * remote binds — before the sibling short-circuit can hand it to the owning
   * child's native cap. Same shared function (`answerDeviceCallRedirect`) as the
   * parent-routed handler and `callCapabilityOnNode`. A redirected call is
   * answered here; a failing redirect fails the call. Omitted (the agent has no
   * redirect authority) ⇒ prior behaviour exactly.
   */
  readonly deviceCallRedirect?: DeviceCallRedirectHook
  /**
   * Per-cap-method bound for UDS cap calls, in ms — read from the cap
   * definition's declared `timeoutMs`. The SAME resolver the remote plane uses
   * (`CapRouteResolver.capTimeoutMs`), so the two planes agree by construction
   * instead of by coincidence.
   *
   * Without this the channel default (60 s) would apply to everything, and a
   * legitimately long method — `applyServerUpdate` declares 16 min because it
   * awaits a full npm install — would be cut off mid-run. Omitted ⇒ the
   * channel default for every cap call.
   */
  readonly capTimeoutMs?: (capName: string, method: string) => number | undefined
  /**
   * Sink for observed cap calls — the ONE place a forked addon's outbound
   * `ctx.api` traffic can be recorded in the process that also holds the reader.
   *
   * ── Why here, and not in the caller ───────────────────────────────────────
   * `getCapUsageRegistry()` is a per-process module singleton and the reader
   * (`nodes.getCapUsageGraph`) runs on hub-main. The only writer used to be
   * `addon-context-factory.ts`'s `localProviderLink` observer, which runs in
   * the FORKED RUNNER — so every observation it made was written to an object
   * hub-main can never read, and it fired only for co-located providers anyway
   * (`ipcParentLink`, which carries every cross-process call, takes no
   * observer). `nodes.getCapUsageGraph` therefore returned `[]` in 0.21 s
   * against a hub running 64 addons and 1019 devices.
   *
   * ── Why here, and not in `onUnownedCall` ──────────────────────────────────
   * Because most inter-addon traffic never gets there. `resolveChildId`
   * short-circuits a cap owned by a sibling runner straight to `callCap`, and
   * on the hub every addon IS a sibling runner. Recording in `onUnownedCall`
   * would have seen `ctx.settings.*` (hub-in-process `settings-store`) and
   * missed every addon→addon call — a graph with a whole plane silently
   * missing, which is the defect it was meant to end.
   *
   * This handler is strictly upstream of BOTH branches, and it is where
   * `callerAddonId` is already stamped off the UDS connection the frame
   * arrived on — a caller identity the child cannot spoof.
   *
   * ── What it still cannot see (say it, do not hide it) ─────────────────────
   *  1. **hub-main → hub-main.** An in-process builtin's `ctx.api` is
   *     `AddonRegistryService.getBrokerApi()` — ONE lazily-built tRPC client
   *     shared by every addon, so there is no per-caller identity to record.
   *     Giving it an observer needs a per-addon client first.
   *  2. **A runner's co-located calls.** `localProviderLink` answers inside the
   *     runner and the frame never reaches this socket. Only the `detection` /
   *     `ml` execution groups have co-located providers at all (D9, D29).
   *  3. **An agent's own runners.** Their parent is the agent process, whose
   *     `LocalChildRegistry` writes to the agent's singleton. Aggregating that
   *     needs a transport hop. `$hub-cap-fwd`'s envelope has carried the
   *     agent-stamped `callerAddonId` since D787 (the keychain owner-checks
   *     it), but the hub does not feed it to this observer — an
   *     agent-originated call is still not recorded here.
   *
   * MUST NOT throw; the call site catches anyway (see the record site).
   */
  readonly capUsageObserver?: (obs: CapUsageCallRecord) => void
}

interface ChildEntry {
  readonly childId: string
  readonly channel: LocalChannel
  readonly caps: readonly ChildCapDescriptor[]
  /** See {@link RegisteredChild.incarnation}. */
  readonly incarnation: number
  /**
   * The child's declared category-pattern subscription set (mirror of its
   * local `SharedBusState.handlers` keys). `null` = the child never declared
   * one (legacy runner / undeclared) → the fan-out fails OPEN (broadcast-all).
   */
  readonly eventPatterns: readonly string[] | null
  /** The child declared it takes payload-borne args (`RegisterMessage.rawForward`). */
  readonly rawForward: boolean
}

/**
 * Parent-side authority for local addon-runners reachable over a
 * `LocalTransportServer` (UDS). Children register their cap manifest on
 * connect; the registry routes `(capName, deviceId?)` cap calls to the
 * owning child over the channel and drops a child's caps on disconnect.
 */
export class LocalChildRegistry {
  private readonly children = new Map<string, ChildEntry>()
  private registeredHandler: (child: RegisteredChild) => void = () => {}
  private goneHandler: (childId: string, incarnation: number) => void = () => {}
  /** Source of {@link RegisteredChild.incarnation}; one bump per accepted connection. */
  private nextIncarnation = 1
  private eventHandler: ((childId: string, event: SystemEvent) => void) | null = null
  private logHandler: ((childId: string, entry: ChildLogMessage) => void) | null = null
  private readinessHandler: (() => readonly IReadinessRegistryRecord[]) | null = null
  private readonly server: LocalTransportServer
  private readonly onUnownedCall?: (input: CapCallInput) => Promise<unknown>
  private readonly logger?: LocalChildRegistryLogger
  private readonly lifecycleEvents?: ChildLifecycleEvents
  /** Per childId: the incarnation `WorkerOnline` was last said for. */
  private readonly announcedIncarnation = new Map<string, number>()
  private readonly getActiveSingletonAddonId?: (capName: string) => string | null
  private readonly resolveChildIdForAddon?: (addonId: string) => string
  /** This node's own Moleculer nodeId (see {@link LocalChildRegistryOptions.ownNodeId}). */
  private readonly ownNodeId?: string
  /** See {@link LocalChildRegistryOptions.isAggregatedCollectionMethod}. */
  private readonly isAggregatedCollectionMethod?: (capName: string, method: string) => boolean
  private readonly isAddonPinnedCall?: (
    capName: string,
    method: string,
    hints: CapRoutingHints,
  ) => boolean
  /** See {@link ForwardCensus}. Mutable counters on the hot path, by design. */
  private forwardedRaw = 0
  private forwardedDecoded = 0
  /**
   * The per-ACTION byte census (D456). `ForwardCensus` above is the same
   * question asked of the whole plane; this one asks it per `<cap>.<method>`,
   * beside the bytes that method actually moved. Both are kept: `socketFwd=`
   * says whether the negotiation is working at all, and a `raw=0` on ONE
   * method with `raw>0` on its neighbours is a different fault.
   */
  private readonly actionCensus: CapActionCensus = createCapActionCensus()
  /** See {@link LocalChildRegistryOptions.capTimeoutMs}. */
  private readonly capTimeoutMs?: (capName: string, method: string) => number | undefined
  /** See {@link LocalChildRegistryOptions.claimedStatus}. */
  private readonly claimedStatus?: ClaimedStatusResolver
  /** See {@link LocalChildRegistryOptions.deviceCallRedirect}. */
  private readonly deviceCallRedirect?: DeviceCallRedirectHook
  /** See {@link LocalChildRegistryOptions.capUsageObserver}. */
  private readonly capUsageObserver?: (obs: CapUsageCallRecord) => void
  /** Tracks capNames already logged as UDS-routed; one INFO line per capName per process. */
  private readonly egressRoutedCaps = new Set<string>()
  /** Per-child event fan-out counters (sent / suppressed). */
  private readonly childEventStats = new Map<string, ChildEventStats>()
  /** D467: per-category production census (cumulative). See {@link CategoryFanoutSample}. */
  private readonly categoryStats = new Map<string, { broadcasts: number; wanted: number }>()
  /** Broadcasts whose category did not fit in {@link CATEGORY_CENSUS_MAX}. */
  private categoryOverflow = 0
  /** One INFO line the first time the census cap trips, never per event. */
  private categoryOverflowLogged = false
  /** Last pattern-set string logged per child, to dedup the INFO line. */
  private readonly loggedPatternSet = new Map<string, string>()
  /**
   * Derived `(cap, device?) → child` index over {@link children}, or `null`
   * when it must be rebuilt. See {@link capIndex} for why it is a cache and
   * never a registry (D3, D457).
   */
  private capChildIndex: CapChildIndex | null = null

  /**
   * Accepts either a plain positional `server` argument (backward-compatible)
   * or a full `LocalChildRegistryOptions` object.
   *
   * Positional overloads (existing call sites are unchanged):
   *   new LocalChildRegistry(server)
   *   new LocalChildRegistry(server, onUnownedCall)
   *
   * Options object (new call sites that pass a logger):
   *   new LocalChildRegistry({ server, onUnownedCall, logger })
   */
  constructor(
    serverOrOptions: LocalTransportServer | LocalChildRegistryOptions,
    onUnownedCallArg?: (input: CapCallInput) => Promise<unknown>,
  ) {
    // Distinguish options-object from positional by checking for `listen`
    // which is defined on `LocalTransportServer` but NOT on `LocalChildRegistryOptions`.
    // We can't use `'server' in opts` because UdsLocalTransportServer has a
    // private `server` field that would cause a false positive.
    if (serverOrOptions && !('listen' in serverOrOptions)) {
      // Options-object form: { server, onUnownedCall?, logger?, getActiveSingletonAddonId? }
      const opts = serverOrOptions as LocalChildRegistryOptions
      this.server = opts.server
      this.onUnownedCall = opts.onUnownedCall
      this.logger = opts.logger
      this.lifecycleEvents = opts.lifecycleEvents
      this.getActiveSingletonAddonId = opts.getActiveSingletonAddonId
      this.resolveChildIdForAddon = opts.resolveChildIdForAddon
      this.ownNodeId = opts.ownNodeId
      this.isAggregatedCollectionMethod = opts.isAggregatedCollectionMethod
      this.isAddonPinnedCall = opts.isAddonPinnedCall
      this.capTimeoutMs = opts.capTimeoutMs
      this.claimedStatus = opts.claimedStatus
      this.deviceCallRedirect = opts.deviceCallRedirect
      this.capUsageObserver = opts.capUsageObserver
    } else {
      // Positional form: LocalChildRegistry(server, onUnownedCall?)
      this.server = serverOrOptions as LocalTransportServer
      this.onUnownedCall = onUnownedCallArg
    }
  }

  async start(): Promise<void> {
    this.server.onConnection((channel) => this.onConnection(channel))
    await this.server.listen()
  }

  /**
   * Per-child event fan-out counters (`{ sent, suppressed }`) or `null` if the
   * child has no recorded events yet. Exposed for the starvation-verification
   * surface (operator debug).
   */
  getChildEventStats(childId: string): ChildEventStats | null {
    const s = this.childEventStats.get(childId)
    return s === undefined ? null : { sent: s.sent, suppressed: s.suppressed }
  }

  /**
   * D467: every category this node has broadcast, with its emit count and how
   * many child subscriptions matched. Cumulative for the life of the process —
   * the heartbeat differences it, the same discipline as the per-child
   * counters. Largest `broadcasts` first.
   */
  categoryFanout(): readonly CategoryFanoutSample[] {
    const out: CategoryFanoutSample[] = []
    for (const [category, s] of this.categoryStats) {
      out.push({ category, broadcasts: s.broadcasts, wanted: s.wanted })
    }
    return out.toSorted(
      (a, b) => b.broadcasts - a.broadcasts || a.category.localeCompare(b.category),
    )
  }

  /** Broadcasts the census could not attribute because it was full (cumulative). */
  categoryCensusOverflow(): number {
    return this.categoryOverflow
  }

  /**
   * This child's socket traffic — bytes and messages, both directions, split by
   * frame kind — or `null` when the child is gone or its channel keeps no
   * counters (an in-process or test transport).
   *
   * The event counters above cover ONE kind of frame and, once surfaced on
   * 2026-08-29, accounted for 4% of hub-main's ~44 000 socket syscalls/s. This
   * is the same question asked of every frame the channel moves, and it is the
   * only per-peer attribution that exists: `/proc` reports one `rchar`/`wchar`
   * pair for the whole process and has no per-socket breakdown.
   */
  getChildSocketTraffic(childId: string): SocketTrafficSample | null {
    const entry = this.children.get(childId)
    if (entry === undefined) return null
    return entry.channel.readTraffic?.() ?? null
  }

  /**
   * Bytes this process has written to a child that the child has not yet
   * taken, live, or `null` when the channel keeps no such reading. Read on
   * every heartbeat probe (D446) — a child that stops draining is the shape
   * of an outbound-queue episode, and the number lives on the channel.
   */
  getChildQueuedBytes(childId: string): number | null {
    const entry = this.children.get(childId)
    if (entry === undefined) return null
    return entry.channel.queuedBytes?.() ?? null
  }

  /** Cumulative {@link ForwardCensus} of this parent's `cap-call-out` routing. */
  readForwardCensus(): ForwardCensus {
    return { raw: this.forwardedRaw, decoded: this.forwardedDecoded }
  }

  /**
   * Cumulative per-action byte census: peer → `<cap>.<method>` → bytes, calls
   * and the raw/decoded split. A COPY (`cap-action-census.ts` explains why it
   * must be one); the heartbeat subtracts the previous reading.
   *
   * This is the instrument D454 closed by asking for. `socketTopBytes=` names
   * the peer that moves the bytes and `txkB=` says they are responses; neither
   * can say WHICH method originates them, and after raw-forward the bytes that
   * cross are no longer the proxy for what hub-main pays — 85.7 % of sibling
   * calls cross unread. What costs is what hub-main LOOKS at, and that is the
   * `decoded` half of an entry, next to the bytes it carried.
   */
  readActionCensus(): CapActionReading {
    return this.actionCensus.read()
  }

  /**
   * Connected children that never declared a subscription pattern set.
   *
   * Each one is a fail-open on BOTH planes: `childWantsEvent` returns true for
   * an undeclared child ({@link ChildEntry.eventPatterns} `=== null`), and
   * `aggregateEventInterest` returns `null` — accept everything — if ANY
   * connected child is undeclared, which disables the node's inbound cross-node
   * gate as well. **One legacy runner silently turns off the filtering for the
   * whole node**, and nothing reported it, so a zero here is as load-bearing as
   * a non-zero one.
   */
  undeclaredChildCount(): number {
    let count = 0
    for (const entry of this.children.values()) {
      if (entry.eventPatterns === null) count += 1
    }
    return count
  }

  /**
   * Does `entry` want to receive an event in `category`? Undeclared patterns
   * (`null`) → always (fail-open, counted by {@link undeclaredChildCount});
   * else the child's declared set must match via `matchesPattern` — the SAME
   * function the child's own `deliverShared` map-key gate uses, giving provable
   * delivery parity. The parent always filters: the `CAMSTACK_UDS_EVENT_FANOUT`
   * shadow/broadcast modes were removed on 2026-10-06.
   *
   * NOTE: this gate must NOT consult `RING_BUFFER_DENY_PATTERNS` /
   * `isHighFrequencyCategory` — those are ring-buffer STORAGE policy; a child
   * that explicitly subscribes to a ring-denied category must still RECEIVE it.
   */
  private childWantsEvent(entry: ChildEntry, category: string): boolean {
    if (entry.eventPatterns === null) return true
    return entry.eventPatterns.some((p) => matchesPattern(p, category))
  }

  /**
   * D2: this node's aggregate cross-node event interest — the UNION of every
   * connected child's declared category patterns. Consumed by the parent's
   * `$event-bus` inbound gate (via `setNodeEventInterest`) so the node only
   * accepts cross-node (Moleculer) categories at least one local child wants.
   *
   * Returns `null` (fail-open — accept everything) when:
   *   - NO child is currently connected (boot window before the first forked
   *     child completes its UDS handshake, or every child has disconnected): a
   *     node MUST NOT drop 100% of inbound cross-node events during that window,
   *     and a child may connect imminently. This is distinct from the
   *     declared-empty case below.
   *   - ANY connected child is UNDECLARED (`eventPatterns === null`, a legacy
   *     runner): a node cannot safely narrow its inbound set while a child's
   *     real interest is unknown. Mirrors the per-child fail-open in
   *     {@link childWantsEvent}, aggregated conservatively.
   *
   * Returns an EMPTY array only when ≥1 child is connected and EVERY connected
   * child declared an explicit empty set — a genuine "wants nothing". Reads the
   * live `children` map, so a child registering / disconnecting / sending
   * `event-sub` is reflected on the next call with no extra bookkeeping.
   */
  aggregateEventInterest(): readonly string[] | null {
    if (this.children.size === 0) return null // no forked child (boot / all gone) → fail-open
    const union = new Set<string>()
    for (const entry of this.children.values()) {
      if (entry.eventPatterns === null) return null // undeclared child → node fails open
      for (const p of entry.eventPatterns) union.add(p)
    }
    return [...union]
  }

  private statsFor(childId: string): ChildEventStats {
    let s = this.childEventStats.get(childId)
    if (s === undefined) {
      s = { sent: 0, suppressed: 0 }
      this.childEventStats.set(childId, s)
    }
    return s
  }

  /** Deduped INFO line whenever a child's declared pattern set changes. */
  private logPatternSet(childId: string, patterns: readonly string[] | null): void {
    const key = patterns === null ? '<undeclared>' : JSON.stringify([...patterns].toSorted())
    if (this.loggedPatternSet.get(childId) === key) return
    this.loggedPatternSet.set(childId, key)
    this.logger?.info('child event patterns', { childId, patterns: patterns ?? null })
  }

  /**
   * Child id that can service a call to `capName` (optionally addressing
   * `deviceId`), or null.
   *
   * `deviceId` is a routing HINT, not a hard filter. A singleton cap
   * (`pipeline-runner`, `stream-broker`, …) addresses devices through its
   * METHOD ARGUMENTS — `attachCamera({ deviceId })` is one provider serving
   * many cameras — so its descriptor carries no `deviceId`. Resolving on
   * `deviceId` alone would never match it and would force the call onto the
   * broker fallback (which then hangs in service discovery). Hence:
   *   1. exact device-scoped owner (native per-device caps where each child
   *      owns a disjoint device subset) is preferred, then
   *   2. a singleton owner (deviceId-less descriptor) is the fallback.
   * A cap is globally singleton XOR device-scoped, so the two tiers never
   * compete for the same capName.
   */
  resolveChildId(capName: string, deviceId?: number): string | null {
    const index = this.capIndex()
    if (deviceId !== undefined) {
      const deviceOwner = index.deviceOwner(capName, deviceId)
      if (deviceOwner !== null) return deviceOwner
    }
    // Collect every child that owns this singleton/global cap. When more
    // than one is registered (e.g. two addons both providing
    // `webrtc-session`), insertion order would
    // silently pick the first-registered — bypassing the operator's
    // `setActiveSingleton` choice. Consult the registry's preference
    // resolver and prefer the configured addonId when it matches one of
    // the candidates; fall through to first-match only when no preference
    // is set or the preferred addon isn't a candidate.
    const candidates = index.singletonCandidates(capName)
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]!
    const preferredAddonId = this.getActiveSingletonAddonId?.(capName) ?? null
    if (preferredAddonId !== null) {
      // The preference is an addonId; candidates are CHILD ids (a grouped
      // addon's child id is its group, not its own id). Map the preferred
      // addonId to its runner/child id before matching. Without a resolver
      // the mapping is identity (addonId === childId — every ungrouped
      // addon), so this is a no-op for the common case.
      const preferredChildId = this.resolveChildIdForAddon?.(preferredAddonId) ?? preferredAddonId
      if (candidates.includes(preferredChildId)) return preferredChildId
    }
    return candidates[0]!
  }

  /**
   * Publish one cap-usage observation, if a sink is wired.
   *
   * Cost discipline — this is on the hot path (D181: hub-main's event loop is
   * the cluster's only queue): no sink means one undefined check; with a sink
   * it is one object literal and one `Date.now()`, and the sink itself is O(1).
   * Wrapped so a broken observer can never fail the call it observes — the
   * registry swallows too, and BOTH matter: this catch also covers a sink that
   * is not the registry.
   */
  private recordCapUsage(
    callerChildId: string | null,
    providerChildId: string | null,
    capName: string,
    methodName: string,
  ): void {
    const sink = this.capUsageObserver
    if (sink === undefined || callerChildId === null) return
    try {
      sink({
        callerAddonId: callerChildId,
        providerAddonId: providerChildId ?? PARENT_ROUTED_PROVIDER_ADDON_ID,
        capName,
        methodName,
        atMs: Date.now(),
      })
    } catch {
      // Observation is best-effort and never affects the caller.
    }
  }

  /**
   * The cap index over the CURRENT children, rebuilt on first use after any
   * mutation of {@link children}.
   *
   * This replaced a linear walk of every child's cap manifest per
   * `cap-call-out`, measured at **7.1 % of hub-main's busy main thread**
   * across 39 children (D456). Why it did not exist before is the whole
   * design: what it indexes moves — a runner is replaced on every update, a
   * crash respawns one, a child re-registers with a replacement manifest after
   * init — and an index that names a dead child routes work into a socket
   * nobody is reading, which is strictly worse than a slow scan.
   *
   * So it is not maintained; it is DISCARDED. `buildCapChildIndex` is a pure
   * function of `children.values()`, the only two writers of that map
   * ({@link invalidateCapIndex}'s call sites) drop the index in the same
   * statement, and nothing else can construct one. There is no add-on-register
   * / remove-on-close path that could disagree with the map — i.e. no shadow
   * registry (D3): the map remains the single authority and this holds no fact
   * it does not.
   *
   * The operator's active-singleton preference is deliberately NOT indexed —
   * it changes without any child connecting or leaving, so `resolveChildId`
   * reads it live and the index only supplies the candidate list.
   */
  private capIndex(): CapChildIndex {
    if (this.capChildIndex === null) {
      this.capChildIndex = buildCapChildIndex(this.children.values())
    }
    return this.capChildIndex
  }

  /** Drop the derived index. MUST follow every write to {@link children}. */
  private invalidateCapIndex(): void {
    this.capChildIndex = null
  }

  /**
   * Does the named child currently provide `(capName, deviceId?)`?
   *
   * Used by the hub proxy seam, which knows the EXACT addon (→ runner →
   * childId) a provider belongs to. Unlike `resolveChildId` (which picks the
   * first child owning `capName`), this targets one child — required for
   * COLLECTION caps (`addon-widgets-source`, …) where many children register
   * the same capName: routing by capName alone collapses every provider to
   * the first child. Same deviceId-as-hint semantics as `resolveChildId`:
   * a device-scoped descriptor matching `deviceId` OR a deviceId-less
   * (singleton/collection) descriptor counts.
   */
  /**
   * Is `childId` currently connected (has it completed its UDS handshake)?
   * Coarser than {@link childProvides}: it answers "is the child reachable
   * over UDS at all", regardless of which caps it has announced yet. Used by
   * the route-mount fallback to decide between the handler-stripped
   * `callAddonOnChild(target:'routes')` path (child reachable) and awaiting a
   * cap proxy's `getRoutes()` (child not yet UDS-registered).
   */
  isChildKnown(childId: string): boolean {
    return this.children.has(childId)
  }

  childProvides(childId: string, capName: string, deviceId?: number): boolean {
    const entry = this.children.get(childId)
    if (!entry) return false
    if (
      deviceId !== undefined &&
      entry.caps.some((cap) => cap.capName === capName && cap.deviceId === deviceId)
    ) {
      return true
    }
    return entry.caps.some((cap) => cap.capName === capName && cap.deviceId === undefined)
  }

  /**
   * Per-request options for a cap call: the cap method's declared `timeoutMs`
   * when one exists, else `undefined` so the channel applies its default.
   * Mirrors `CapRouteResolver.callTimeout` for the remote plane.
   */
  private capRequestOpts(input: CapCallInput): { timeoutMs: number } | undefined {
    const declared = this.capTimeoutMs?.(input.capName, input.method)
    return typeof declared === 'number' ? { timeoutMs: declared } : undefined
  }

  /** Forward a cap method call to a SPECIFIC child by id over UDS; rejects if that child is absent. */
  async callCapOnChild(childId: string, input: CapCallInput): Promise<unknown> {
    const entry = this.children.get(childId)
    if (!entry) {
      throw new Error(`no local child "${childId}" for cap "${input.capName}"`)
    }
    return entry.channel.request(this.toCapCall(input), this.capRequestOpts(input))
  }

  /** Forward a cap method call to the owning child over UDS; rejects if none. */
  async callCap(input: CapCallInput): Promise<unknown> {
    const childId = this.resolveChildId(input.capName, input.deviceId)
    const entry = childId === null ? undefined : this.children.get(childId)
    if (!entry) {
      const where = input.deviceId === undefined ? '' : ` for device ${input.deviceId}`
      throw new Error(`no local child provides cap "${input.capName}"${where}`)
    }
    return entry.channel.request(this.toCapCall(input), this.capRequestOpts(input))
  }

  /**
   * Forward an ADDON-LEVEL call (routes / custom-action) to a SPECIFIC child
   * by id over UDS; rejects if that child is absent.
   *
   * The childId for a hub-local single-addon runner equals the addonId
   * (`resolveRunnerId` returns the addonId when no `execution.group` is
   * declared — no shipped addon declares one). Mirrors `callCapOnChild` for
   * the cap plane; carries the two surfaces the removed per-addon Moleculer
   * broker used to serve (`getRoutes` + `custom.<action>`).
   */
  async callAddonOnChild(childId: string, input: AddonCallInput): Promise<unknown> {
    const entry = this.children.get(childId)
    if (!entry) {
      throw new Error(`no local child "${childId}" for addon-call (${input.target})`)
    }
    return entry.channel.request(this.toAddonCall(input))
  }

  /** Build the parent→child `addon-call` wire message from an addon-call input. */
  private toAddonCall(input: AddonCallInput): AddonCallMessage {
    return {
      kind: 'addon-call',
      addonId: input.addonId,
      target: input.target,
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      // Only carried for a `target:'custom'` action declaring `caller:'required'`
      // (the hub router derives it server-side). Absent otherwise, keeping the
      // wire frame additive for legacy children.
      ...(input.caller !== undefined ? { caller: input.caller } : {}),
    }
  }

  /** Build the parent→child `cap-call` wire message from a routing input. */
  private toCapCall(input: CapCallInput): CapCallMessage {
    return {
      kind: 'cap-call',
      capName: input.capName,
      method: input.method,
      args: input.args,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.addonId !== undefined ? { addonId: input.addonId } : {}),
      // The caller travels to the serving child, which stamps it into the
      // args (overwriting any claim) — the sibling short-circuit's half of
      // D787. Absent for a hub-originated call: the child then strips a claim.
      ...(input.callerAddonId !== undefined ? { callerAddonId: input.callerAddonId } : {}),
    }
  }

  listChildren(): readonly RegisteredChild[] {
    return [...this.children.values()].map((e) => ({
      childId: e.childId,
      caps: e.caps,
      incarnation: e.incarnation,
    }))
  }

  /** Register the (single) child-registered handler. Only one handler is active at a time. */
  onChildRegistered(handler: (child: RegisteredChild) => void): void {
    this.registeredHandler = handler
  }
  /**
   * Register the (single) child-gone handler. Only one handler is active at a
   * time. The handler receives the {@link RegisteredChild.incarnation} of the
   * connection that closed — carry it into whatever teardown it triggers, so a
   * dead generation cannot tear down its successor's work.
   */
  onChildGone(handler: (childId: string, incarnation: number) => void): void {
    this.goneHandler = handler
  }

  /**
   * Register the (single) child-event handler. Invoked when a child sends an
   * event via `LocalChildClient.emitEvent`. Only one handler is active at a
   * time; a new handler replaces the prior one. Pass `null` to clear the
   * handler entirely (used by the UDS event bridge disposer on shutdown).
   */
  onChildEvent(handler: ((childId: string, event: SystemEvent) => void) | null): void {
    this.eventHandler = handler
  }

  /**
   * Register the (single) child-log handler. Invoked when a child sends a log
   * entry via `LocalChildClient.sendLog`. Only one handler is active.
   */
  onChildLog(handler: (childId: string, entry: ChildLogMessage) => void): void {
    this.logHandler = handler
  }

  /**
   * Register the handler that supplies the authoritative readiness snapshot
   * when a child sends a `readiness-request`. Only one handler is active.
   */
  onReadinessSnapshotRequest(handler: () => readonly IReadinessRegistryRecord[]): void {
    this.readinessHandler = handler
  }

  /**
   * Push a parent→child event to a specific child. Fire-and-forget (uses the
   * one-way `emit` path on the channel). No-op if the child is not connected.
   */
  sendEventToChild(childId: string, event: SystemEvent, sourceNodeId: string): void {
    const entry = this.children.get(childId)
    if (entry === undefined) return
    const msg: ParentEventMessage = { kind: 'event', event, sourceNodeId }
    entry.channel.emit(msg)
  }

  /**
   * Push a parent→child event to every registered child, optionally skipping
   * one (the originating child, to avoid echo). Fire-and-forget.
   */
  broadcastEventToChildren(event: SystemEvent, sourceNodeId: string, exceptChildId?: string): void {
    const msg: ParentEventMessage = { kind: 'event', event, sourceNodeId }
    let subscribed = 0
    for (const entry of this.children.values()) {
      if (entry.childId === exceptChildId) continue
      const wants = this.childWantsEvent(entry, event.category)
      const stats = this.statsFor(entry.childId)
      if (!wants) {
        stats.suppressed++
        continue
      }
      subscribed += 1
      stats.sent++
      entry.channel.emit(msg)
    }
    this.recordCategoryBroadcast(event.category, subscribed)
  }

  /**
   * Record one PRODUCED event against its category. Called once per broadcast,
   * outside the per-child loop, because production is what the census measures.
   */
  private recordCategoryBroadcast(category: string, subscribed: number): void {
    const existing = this.categoryStats.get(category)
    if (existing !== undefined) {
      existing.broadcasts += 1
      existing.wanted += subscribed
      return
    }
    if (this.categoryStats.size >= CATEGORY_CENSUS_MAX) {
      this.categoryOverflow += 1
      if (!this.categoryOverflowLogged) {
        this.categoryOverflowLogged = true
        this.logger?.info('event category census full — further new categories are unattributed', {
          max: CATEGORY_CENSUS_MAX,
          firstDropped: category,
        })
      }
      return
    }
    this.categoryStats.set(category, { broadcasts: 1, wanted: subscribed })
  }

  /**
   * E2: Send a `set-log-level` control message to a specific child.
   * Returns `true` if the child is currently connected and the message was
   * emitted; `false` if the child is not connected (no-op). The `false`
   * return lets the caller (MoleculerService.setChildLogLevelByNodeId) fall
   * back to the Moleculer `$node-mgmt.setLogLevel` action for the node.
   * Mirrors the `$node-mgmt.setLogLevel` Moleculer action for UDS children.
   */
  setChildLogLevel(childId: string, level: string): boolean {
    const entry = this.children.get(childId)
    if (entry === undefined) return false
    const msg: SetLogLevelMessage = { kind: 'set-log-level', level }
    entry.channel.emit(msg)
    return true
  }

  async close(): Promise<void> {
    await this.server.close()
  }

  /** `WorkerOnline`, once per incarnation: a re-register of the same connection says nothing. */
  private announceOnline(childId: string, incarnation: number): void {
    const events = this.lifecycleEvents
    if (events === undefined || this.announcedIncarnation.get(childId) === incarnation) return
    this.announcedIncarnation.set(childId, incarnation)
    const workerId = `${events.parentNodeId()}/${childId}`
    this.emitLifecycle(
      events,
      createEvent(EventCategory.WorkerOnline, LIFECYCLE_SOURCE, { workerId }),
      incarnation,
    )
  }

  /** `WorkerOffline` for the LIVE connection's close (a superseded close never reaches here). */
  private announceOffline(childId: string, incarnation: number): void {
    const events = this.lifecycleEvents
    if (events === undefined) return
    this.announcedIncarnation.delete(childId)
    const workerId = `${events.parentNodeId()}/${childId}`
    this.emitLifecycle(
      events,
      createEvent(EventCategory.WorkerOffline, LIFECYCLE_SOURCE, { workerId }),
      incarnation,
    )
  }

  private emitLifecycle(
    events: ChildLifecycleEvents,
    event: SystemEvent,
    incarnation: number,
  ): void {
    // A bus that throws must never fail the handshake or the teardown it rides
    // on — and a dropped lifecycle event is said, never silent (D391).
    try {
      events.emit(event)
    } catch (err) {
      this.logger?.info('runner lifecycle event could not be emitted', {
        category: event.category,
        incarnation,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private onConnection(channel: LocalChannel): void {
    let childId: string | null = null
    const incarnation = this.nextIncarnation++

    // The per-action census, wired before anything can be served. `childId` is
    // read at RECORD time, not captured: a connection has no id until its
    // `register` frame lands, and the frames before it (the register itself)
    // are charged to a named pre-register peer rather than dropped — an
    // instrument that discards what it cannot attribute reports a clean
    // attribution of a fraction it never mentions.
    channel.observeActions?.({
      label: capActionLabel,
      record: (label, reqBytes, resBytes) => {
        const peerId = childId ?? PRE_REGISTER_PEER_ID
        if (label === null) this.actionCensus.recordUnlabelled(peerId, reqBytes + resBytes)
        else this.actionCensus.record(peerId, label, reqBytes, resBytes)
      },
    })

    // Fire-and-forget child→parent messages (events + logs + event-sub) arrive
    // via `onEvent`.
    channel.onEvent((body) => {
      const msg = body as ChildEventMessage | ChildLogMessage | EventSubUpdateMessage // wire-boundary: trusted local UDS channel
      if (msg.kind === 'event') {
        if (childId !== null) this.eventHandler?.(childId, msg.event)
        return
      }
      if (msg.kind === 'log') {
        if (childId !== null) this.logHandler?.(childId, msg)
        return
      }
      if (msg.kind === 'event-sub') {
        // Full-set replace of the child's declared subscription patterns.
        // Defensive: ignore if the child hasn't registered yet (cannot happen
        // on the in-order socket — the client only emits event-sub post-start,
        // and pre-start subs ride the register frame).
        if (childId === null) return
        const entry = this.children.get(childId)
        if (entry === undefined) return
        this.children.set(childId, { ...entry, eventPatterns: msg.patterns })
        this.logPatternSet(childId, msg.patterns)
        return
      }
      // Unknown fire-and-forget kind: ignore (mixed-version safety — an old
      // parent must silently drop a new child's unknown frame, never throw).
    })

    channel.onRequest(async (body, payload) => {
      const msg = body as ChildToParentRequest // wire-boundary: trusted local UDS channel
      if (msg.kind === 'register') {
        if (childId !== null && childId !== msg.childId) {
          throw new Error(
            `child attempted to change identity from "${childId}" to "${msg.childId}"`,
          )
        }
        childId = msg.childId
        // `eventPatterns` absent → legacy/undeclared child → null → fail-open.
        const eventPatterns = msg.eventPatterns ?? null
        const superseded = this.children.get(msg.childId)
        if (superseded !== undefined && superseded.channel !== channel) {
          // An update replaced the runner: the successor connected before the
          // predecessor's socket close was observed. Say so — the predecessor's
          // close is about to be ignored, and a silent takeover is exactly what
          // made the 2026-08-20 recording outage unreadable in the logs.
          this.logger?.info('local child superseded by a new connection', {
            childId: msg.childId,
            supersededIncarnation: superseded.incarnation,
            incarnation,
          })
        }
        this.children.set(msg.childId, {
          childId: msg.childId,
          channel,
          caps: msg.caps,
          eventPatterns,
          incarnation,
          rawForward: msg.rawForward === true,
        })
        // A register REPLACES the manifest wholesale (the post-init register
        // carries caps the pre-init one did not), so the index is dropped here
        // and not only when a child is new.
        this.invalidateCapIndex()
        this.logPatternSet(msg.childId, eventPatterns)
        // Before the handler and before the ack: the child loads no addon until
        // this frame is acked, so a consumer hears of the new incarnation before
        // anything it runs can act. `announceOnline` emits on the parent bus
        // (sync local fan-out + UDS write into sibling sockets). One
        // `setImmediate` turn then lets a sibling that already has the frame
        // (the orchestrator's provider gate) close its cameras before this
        // child proceeds to load, initialize and restore — the documented
        // event-delivery race of the D696 motion path.
        this.announceOnline(msg.childId, incarnation)
        await (this.lifecycleEvents?.afterOnlineAnnounce?.() ?? afterWorkerOnlineAnnounce())
        this.registeredHandler({
          childId: msg.childId,
          caps: msg.caps,
          incarnation,
          // Passed through as declared: absent stays absent ("not described
          // yet"), so the consumer can tell a pre-init register from a child
          // that described an empty catalog.
          ...(msg.customActions !== undefined ? { customActions: msg.customActions } : {}),
        })
        // Raw-forward IS the behaviour of this parent: every child that
        // declares it is acknowledged, and there is no switch. The only
        // decoded path left is the one for a peer of a release that did not
        // declare — protocol compatibility, not an operator knob (D449). The
        // way out of a bad release is `serverManagement.rollbackServerUpdate`.
        const ack: RegisterAck = { ok: true, rawForward: true }
        return ack
      }
      if (msg.kind === 'cap-call-out') {
        const out = msg as CapCallOutMessage // wire-boundary: trusted local UDS channel
        // Everything the routing below reads out of the args, in ONE shape for
        // both modes: lifted by the sender under raw-forward (the args are
        // opaque bytes here), lifted by the parent for a legacy inline frame.
        const hints = out.hints ?? liftRoutingHints(out.args)
        // The args as a VALUE — only materialised on the paths that need one.
        // Under raw-forward that is a decode of the payload the parent would
        // otherwise never touch, so it is deferred to the branch that pays it.
        const materialise = (): unknown =>
          payload !== undefined ? unpackPayload(payload) : out.args
        const buildInput = (): CapCallInput => ({
          capName: out.capName,
          method: out.method,
          args: materialise(),
          ...(out.deviceId !== undefined ? { deviceId: out.deviceId } : {}),
          ...(out.nodeId !== undefined ? { nodeId: out.nodeId } : {}),
          ...(out.native === true ? { native: true } : {}),
          // The ORIGINATING addon, known here because the parent owns the UDS
          // connection this frame arrived on (`childId` was captured at
          // `register`, never claimed by the child in this message) — see
          // `CapCallMessage.callerAddonId`. A solo-addon runner's childId IS
          // its addonId (`resolveRunnerId`); a grouped runner attributes to
          // the RUNNER, which is the identity actually known at this layer.
          ...(childId !== null ? { callerAddonId: childId } : {}),
        })
        // `getStatus` of a CLAIMED cap — the hub mirror answers (D663, S3),
        // before any name-based resolution below. See
        // `LocalChildRegistryOptions.claimedStatus`. The device is the lifted
        // `out.deviceId`; a legacy inline frame carries it in `out.args`. A
        // raw-forward tail is NOT decoded for it (D448: the parent decodes
        // nothing of what it carries) — the sender lifts the id whenever the
        // args hold one, so a raw frame without it has none to find.
        if (this.claimedStatus !== undefined && out.method === GET_STATUS_METHOD) {
          const claimed = await answerClaimedGetStatus(this.claimedStatus, {
            capName: out.capName,
            method: out.method,
            deviceId:
              out.deviceId ?? (payload === undefined ? extractDeviceId(out.args) : undefined),
          })
          if (claimed !== null) {
            // Observed like a parent-routed call: the hub answered, no sibling
            // served it. The channel census already counted the call; it is
            // neither `raw` nor `decoded` — nothing was forwarded and nothing
            // read — so `calls − raw − decoded` is what the parent answered (D456).
            this.recordCapUsage(childId, null, out.capName, out.method)
            return claimed.slice
          }
        }
        // A covered device-scoped call the device's remote takes over (D963).
        // Args are decoded only for a method the hook covers (D448).
        const redirected = await answerDeviceCallRedirect(this.deviceCallRedirect, {
          capName: out.capName,
          method: out.method,
          ...(out.deviceId !== undefined ? { deviceId: out.deviceId } : {}),
          args: materialise,
        })
        if (redirected !== null) {
          this.recordCapUsage(childId, null, out.capName, out.method)
          return redirected.result
        }
        // Explicit per-call node pin (op.context `nodeId`, or an inline `nodeId`
        // in the args). A pin naming ANOTHER node must NOT be short-circuited to
        // a local sibling that happens to own the same cap name — that silently
        // runs the work on the wrong node (the benchmark's hub→agent execution
        // pinning). Such a pin routes through onUnownedCall, whose resolver
        // classifies it correctly (hub → hub-in-process / hub-local-uds, agent →
        // agent-child-forward).
        //
        // A pin naming THIS node, however, is SATISFIED by the co-resident
        // sibling — the pin's target lives right here. Bypassing the sibling for
        // a pin-to-self forced the call out to onUnownedCall needlessly: on an
        // AGENT (which has no CapRouteResolver) that meant forwarding to the hub
        // and hoping the hub's node registry knew the agent hosts the cap —
        // failing with "no provider registered" when a forked-addon singleton
        // (e.g. `pipeline-executor`) was pinned to the agent it already runs on
        // (the benchmark tabs on an agent node). Treating a pin-to-self like an
        // unpinned call keeps it local. When `ownNodeId` is unset (legacy /
        // positional construction) the registry can't tell self from other, so
        // it preserves the prior "any pin bypasses" behaviour.
        const pinnedNodeId = out.nodeId ?? hints.nodeId
        const pinTargetsThisNode =
          pinnedNodeId !== undefined &&
          this.ownNodeId !== undefined &&
          pinnedNodeId === this.ownNodeId
        // A collection ARRAY method answers with the union across every
        // provider, so it must never be short-circuited to one sibling — it
        // goes to onUnownedCall, which owns the aggregate. (A pin decides
        // first: an explicit node wins over any cluster-wide union.)
        const aggregated =
          pinnedNodeId === undefined &&
          this.isAggregatedCollectionMethod?.(out.capName, out.method) === true
        // An explicit `{ addonId }` selector names the provider the caller
        // wants; the sibling short-circuit picks the FIRST-registered one, i.e.
        // exactly what the selector exists to override. Same bypass as the
        // union above, and for the same reason it must happen HERE: this
        // decision runs before `onUnownedCall`, so a pin resolved only there is
        // resolved never.
        const addonPinned =
          pinnedNodeId === undefined &&
          this.isAddonPinnedCall?.(out.capName, out.method, hints) === true
        // `native: true` asks for the per-device NATIVE provider, and
        // `resolveChildId` cannot answer that question: it matches by capName
        // and falls back to any deviceId-less descriptor — which, for a wrapper
        // cap, is the wrapper's own child. The one authority that separates
        // native from wrapper is the parent's CapabilityRegistry, reached
        // through `onUnownedCall`. Fourth member of the "an explicit intent
        // must win over a co-located provider" family, alongside the node pin,
        // the collection union and the `{ addonId }` selector.
        const nativeOnly = out.native === true
        const target =
          !nativeOnly &&
          !aggregated &&
          !addonPinned &&
          (pinnedNodeId === undefined || pinTargetsThisNode)
            ? this.resolveChildId(out.capName, out.deviceId)
            : null
        // ONE observation per cross-process cap call, taken before the branch
        // so both routes are covered and neither can double-count. `childId` is
        // the caller off the connection, `target` the sibling that will serve
        // it; a parent-routed call names its unknown provider rather than
        // dropping the caller with it (D237).
        //
        // This counts ATTEMPTS, not successes — deliberately. The graph answers
        // "who is hammering this cap", and a call that ends in a routing miss
        // cost the same event-loop time as one that answered. Recording after
        // dispatch would also have to survive both an await and a throw on the
        // hottest path in the parent. See
        // `LocalChildRegistryOptions.capUsageObserver` for what this cannot see.
        this.recordCapUsage(childId, target, out.capName, out.method)
        // The per-action half of the forward census: the SAME key the channel
        // charges this call's bytes to, so "150 MB to analytics" and "of which
        // this much was never read" are one row and not two instruments.
        const actionPeer = childId ?? PRE_REGISTER_PEER_ID
        const actionLabel = `${out.capName}.${out.method}`
        if (target !== null) {
          if (!this.egressRoutedCaps.has(out.capName)) {
            this.egressRoutedCaps.add(out.capName)
            this.logger?.info('routed child egress over UDS', { capName: out.capName })
          }
          const entry = this.children.get(target)
          if (payload !== undefined && entry !== undefined && entry.rawForward) {
            // Raw-forward: the payload — a view into the frame it arrived on —
            // is written through to the sibling behind a fresh envelope, and
            // the sibling's answer (a `PayloadReply` or a plain value) is
            // returned to the caller's channel as-is, which writes it the
            // same way. The parent decoded nothing of what either carries.
            this.forwardedRaw += 1
            this.actionCensus.recordForward(actionPeer, actionLabel, 'raw')
            const forward: CapCallMessage = {
              kind: 'cap-call',
              capName: out.capName,
              method: out.method,
              // Omitted on the wire (`ignoreUndefined`): the args ARE the payload.
              args: undefined,
              ...(out.deviceId !== undefined ? { deviceId: out.deviceId } : {}),
              // The caller, known from the connection this frame arrived on —
              // the sibling stamps it into the args it decodes (D787).
              ...(childId !== null ? { callerAddonId: childId } : {}),
            }
            const declared = this.capTimeoutMs?.(out.capName, out.method)
            return entry.channel.request(forward, {
              ...(typeof declared === 'number' ? { timeoutMs: declared } : {}),
              payload,
            })
          }
          this.forwardedDecoded += 1
          this.actionCensus.recordForward(actionPeer, actionLabel, 'decoded')
          // `target` is already resolved; `callCap` would resolve the same cap
          // a SECOND time for the same answer, which is why the scan this
          // branch pays used to be counted twice per decoded sibling call.
          // Falls back to `callCap` only when the entry vanished between the
          // resolution and here, so the "no local child provides cap" wording
          // that callers read is unchanged.
          const input = buildInput()
          return entry !== undefined ? this.callCapOnChild(target, input) : this.callCap(input)
        }
        this.forwardedDecoded += 1
        this.actionCensus.recordForward(actionPeer, actionLabel, 'decoded')
        if (this.onUnownedCall !== undefined) {
          return this.onUnownedCall(buildInput())
        }
        throw new Error(
          `${UDS_NO_ROUTE_PREFIX}: cap-call-out has no local provider for "${out.capName}" and no fallback`,
        )
      }
      if (msg.kind === 'readiness-request') {
        const records = this.readinessHandler?.() ?? []
        const resp: ReadinessSnapshotResponse = { kind: 'readiness-snapshot', records }
        return resp
      }
      throw new Error(`unknown child request kind: ${(msg as { kind: string }).kind}`)
    })
    channel.onClose(() => {
      if (childId === null) return
      const entry = this.children.get(childId)
      if (entry === undefined) return
      if (entry.channel !== channel) {
        // This connection has already been superseded by a newer one holding
        // the same childId (`resolveRunnerId` is deterministic, so a replaced
        // runner reconnects under the SAME id). Deleting by id here evicted the
        // LIVE successor and made the hub unregister its capabilities from a
        // healthy process — `recording` was dead for 7 hours on 2026-08-20.
        this.logger?.info('ignoring close of a superseded local child connection', {
          childId,
          incarnation,
          liveIncarnation: entry.incarnation,
        })
        return
      }
      this.children.delete(childId)
      this.invalidateCapIndex()
      this.childEventStats.delete(childId)
      // Drop the peer's per-action counters with it. A replaced runner
      // reconnects under the SAME id (`resolveRunnerId`), and leaving the dead
      // generation's totals in place would charge its successor bytes it never
      // moved. The window's clamp then reads the first cycle after a respawn
      // as quiet, exactly as `diffSocketPlane` already does for the same peer.
      this.actionCensus.forget(childId)
      this.loggedPatternSet.delete(childId)
      // The parent's teardown first (the hub unregisters the child's caps), then
      // the event: a consumer that asks after `WorkerOffline` is answered by a
      // registry that no longer holds the departed process.
      this.goneHandler(childId, incarnation)
      this.announceOffline(childId, incarnation)
    })
  }
}
