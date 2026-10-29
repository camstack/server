import type {
  ChildCustomActionCatalogs,
  IReadinessRegistryRecord,
  SystemEvent,
} from '@camstack/types'
import { stampCallerAddonId } from './cap-route-resolver.js'
import { liftRoutingHints } from './cap-routing-hints.js'
import type {
  AddonCallInput,
  CapCallInput,
  CapCallOutMessage,
  ChildCapDescriptor,
  ChildEventMessage,
  ChildLogMessage,
  EventSubUpdateMessage,
  EventInterestMessage,
  ParentEventMessage,
  ParentToChildRequest,
  ReadinessSnapshotRequest,
  ReadinessSnapshotResponse,
  RegisterAck,
  RegisterMessage,
  SetLogLevelMessage,
} from './child-cap-protocol.js'
import { createLocalTransport } from './create-local-transport.js'
import { packPayload, unpackPayload } from './frame-codec.js'
import { PayloadReply, type LocalChannel, type LocalTransportClient } from './local-transport.js'

/** Did the parent's `register` answer say it accepts payload-borne args? */
function ackAcceptsRawForward(ack: unknown): boolean {
  if (ack === null || typeof ack !== 'object') return false
  return (ack as RegisterAck).rawForward === true
}

export interface LocalChildClientOptions {
  /** Parent node id — selects the UDS endpoint this child connects to. */
  readonly nodeId: string
  /** This child's stable id (its addon-runner id). */
  readonly childId: string
  /** Cap manifest sent to the parent on registration. */
  readonly caps: readonly ChildCapDescriptor[]
  /** Invoked for each parent→child cap call; returns the cap method's result. */
  readonly dispatch: (call: CapCallInput) => Promise<unknown>
}

/** Handler invoked for each parent→child addon-level call (`routes` / `custom`). */
export type AddonCallHandler = (call: AddonCallInput) => Promise<unknown>

/** A buffered item waiting for the channel to open. */
type PendingEmit =
  | { readonly kind: 'event'; readonly msg: ChildEventMessage }
  | { readonly kind: 'log'; readonly msg: ChildLogMessage }

/**
 * Child side of the local UDS transport. Connects to its parent (hub or
 * agent), registers its cap manifest, and serves parent→child cap calls by
 * delegating to `dispatch`. The provider implementation lives in the child;
 * only routing keys + call arguments cross the wire.
 *
 * Additional channels beyond cap-call:
 *   - `emitEvent`              fire-and-forget event toward the parent
 *   - `sendLog`                fire-and-forget log entry toward the parent
 *   - `requestReadinessSnapshot` request/response snapshot of readiness records
 *   - `onEvent`                register a handler for parent→child events
 *
 * Events and logs emitted before `start()` resolves are buffered and flushed
 * on connect (mirrors the `updateCaps`/`latestCaps` pattern).
 */
export class LocalChildClient {
  private client: LocalTransportClient | null = null
  private channel: LocalChannel | null = null
  /**
   * The cap set `start()` will register, kept current by `updateCaps`. Native
   * device caps register on device-restore, which can race AHEAD of the UDS
   * connect — buffering here lets a pre-start `updateCaps` survive (start sends
   * the latest set) instead of being lost or throwing.
   */
  private latestCaps: readonly ChildCapDescriptor[]

  /**
   * Per-owner (addonId) category-pattern subscription sets, and their union.
   * The union is declared to the parent (in `RegisterMessage.eventPatterns`
   * pre/at-connect, or via an `event-sub` emit post-connect) so the parent can
   * subscription-filter its event fan-out. Per-owner keying keeps the union
   * correct if multiple event buses ever share one client (group-runner case).
   */
  private readonly patternsByOwner = new Map<string, readonly string[]>()
  private latestEventPatterns: readonly string[] = []
  /**
   * Whether `updateEventPatterns` has ever been called. A client that never
   * declared a subscription set (no event bus wired — e.g. a pure cap-call
   * runner) omits `eventPatterns` from its register frame entirely, so the
   * parent treats it as UNDECLARED and fails OPEN (broadcast-all). Once any
   * owner declares (in production every addon context's framework
   * subscriptions do), the register carries the real union — even if empty.
   */
  private hasDeclaredEventPatterns = false

  /**
   * The custom-action catalogs of every hosted addon, once the runner's init
   * loop has produced them (`updateCaps(caps, catalogs)` at post-init). `null`
   * until then, and OMITTED from the register frame while null: the parent
   * reads absence as "not described yet", and a pre-init register must never
   * look like "this child declares no actions". Kept on the client so every
   * later re-register (native-cap change, reconnect) re-carries it unchanged.
   */
  private latestCustomActions: ChildCustomActionCatalogs | null = null

  /** Events and logs queued while the channel is not yet open. */
  private readonly pendingEmits: PendingEmit[] = []

  /**
   * Whether the parent acknowledged raw-forward at `register`. Until it has,
   * `callOut` sends args inline exactly as every child always did — a legacy
   * parent would decode a payload-borne call to `args: undefined` and run the
   * provider on nothing, silently. Re-read on every re-register.
   */
  private parentRawForward = false

  /** Handler for parent→child events. Registered via `onEvent`. */
  private eventHandler: ((event: SystemEvent) => void) | null = null

  /** Handler for `event-interest` pushes. Registered via `onEventInterest`. */
  private eventInterestHandler: ((patterns: readonly string[] | null) => void) | null = null

  /**
   * Handler for parent→child addon-level calls (`routes` / `custom`).
   * Registered via `onAddonCall`. Resolves the loaded addon instance and
   * invokes its `addon-routes.getRoutes()` or its custom-action handler.
   * Replaces the per-addon Moleculer `getRoutes` / `custom.<action>` actions
   * removed in F1/F2. Only one handler is active at a time.
   */
  private addonCallHandler: AddonCallHandler | null = null

  /**
   * Handler for `set-log-level` messages pushed by the parent.
   * Registered via `onSetLogLevel`. The handler applies the new level to the
   * child's local Moleculer logger (mirrors `$node-mgmt.setLogLevel`).
   * E2: wired in `addon-runner.ts` to forward to the broker logger.
   */
  private setLogLevelHandler: ((level: string) => void) | null = null

  /** Callbacks registered via `onConnected`. Fired on every (re)connect. */
  private readonly connectedHandlers: Array<() => void> = []

  constructor(private readonly options: LocalChildClientOptions) {
    this.latestCaps = options.caps
  }

  /**
   * Declare an owner's live category-pattern subscription set. Stores it
   * per-owner (keyed by `ownerId` = addonId), recomputes the union, and — only
   * if the union changed — declares it to the parent:
   *   - pre-connect: buffered only; `start()`'s register frame carries the set.
   *   - post-connect: emitted as a fire-and-forget `event-sub` (full-set
   *     replace).
   * Idempotent on an unchanged union (no redundant `event-sub` frames).
   */
  updateEventPatterns(ownerId: string, patterns: readonly string[]): void {
    this.hasDeclaredEventPatterns = true
    this.patternsByOwner.set(ownerId, patterns)
    const union = this.computePatternUnion()
    if (!this.patternsEqual(union, this.latestEventPatterns)) {
      this.latestEventPatterns = union
      if (this.channel !== null) {
        const msg: EventSubUpdateMessage = { kind: 'event-sub', patterns: union }
        this.channel.emit(msg)
      }
      // Pre-connect: no emit — `start()`'s register frame carries the union.
    }
  }

  /** Sorted, de-duplicated union across all owners' pattern sets. */
  private computePatternUnion(): readonly string[] {
    const all = new Set<string>()
    for (const patterns of this.patternsByOwner.values()) {
      for (const p of patterns) all.add(p)
    }
    return [...all].toSorted()
  }

  /** Order-insensitive equality — both inputs are already sorted unions here. */
  private patternsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  /**
   * Register a callback that fires each time the client successfully connects
   * (or reconnects) to its parent. Multiple handlers may be registered; all
   * are called in registration order. Used by readiness-context in UDS mode
   * to trigger a snapshot hydrate on connect/reconnect.
   */
  onConnected(handler: () => void): void {
    this.connectedHandlers.push(handler)
  }

  /**
   * Register a handler for events pushed from the parent to this child.
   * Must be called before `start()` to avoid missing early events (though
   * registration after start is also safe for events not yet delivered).
   * Replaces any previously registered handler.
   */
  onEvent(handler: (event: SystemEvent) => void): void {
    this.eventHandler = handler
  }

  /**
   * Register the handler invoked when the parent pushes the categories someone
   * else wants (`event-interest`). `null` = unknown → send everything. Replaces
   * any prior handler; one slot, registered once per channel by the event bus.
   */
  onEventInterest(handler: (patterns: readonly string[] | null) => void): void {
    this.eventInterestHandler = handler
  }

  /**
   * Register the handler invoked when the parent sends an `addon-call` (the
   * addon-level routes / custom-action plane). The addon-runner wires this to
   * resolve the loaded addon by id and dispatch to its `getRoutes()` or its
   * custom-action handler. Safe to register before or after `start()`;
   * replaces any prior handler.
   */
  onAddonCall(handler: AddonCallHandler): void {
    this.addonCallHandler = handler
  }

  /**
   * E2: Register a handler invoked when the parent sends a `set-log-level`
   * message to this child. The handler should forward the new level to the
   * child's local Moleculer broker logger (mirrors `$node-mgmt.setLogLevel`).
   * Safe to register before or after `start()`. Replaces any prior handler.
   */
  onSetLogLevel(handler: (level: string) => void): void {
    this.setLogLevelHandler = handler
  }

  /**
   * True once `start()` has successfully connected and registered. Used by
   * callers (event-bus/logger bridges) to know the channel is live.
   */
  get isConnected(): boolean {
    return this.channel !== null
  }

  async start(): Promise<void> {
    if (this.client !== null)
      throw new Error('LocalChildClient: already started — call close() first')
    const client = createLocalTransport().createClient(this.options.nodeId)
    const channel = await client.connect()
    channel.onRequest(async (body, payload) => {
      const msg = body as ParentToChildRequest // wire-boundary: trusted local UDS channel
      if (msg.kind === 'cap-call') {
        // Payload-borne args (raw-forward) are unpacked HERE, in the process
        // that runs the provider — the parent never read them. A call that
        // carried its args inline is served exactly as before.
        // The caller identity is the PARENT's stamp, never the sender's claim
        // (D787): stamped when the parent knew the caller, stripped when not.
        const args = stampCallerAddonId(
          payload !== undefined ? unpackPayload(payload) : msg.args,
          msg.callerAddonId,
        )
        const result = await this.options.dispatch({
          capName: msg.capName,
          method: msg.method,
          args,
          ...(msg.deviceId !== undefined ? { deviceId: msg.deviceId } : {}),
          // Provider-selection hint for grouped runners: without it a runner
          // hosting several addons that register the SAME collection cap can
          // only resolve the first-registered provider (the auth 3×-magic-link
          // bug — every wire field must survive this extraction seam).
          ...(msg.addonId !== undefined ? { addonId: msg.addonId } : {}),
          ...(msg.callerAddonId !== undefined ? { callerAddonId: msg.callerAddonId } : {}),
        })
        // The requester decides the shape: a payload request gets a payload
        // reply, so the parent can forward the answer as opaquely as it
        // forwarded the question. A `z.void()` result stays an omitted body —
        // packing `undefined` would read back as `null` on the far side.
        if (payload !== undefined && result !== undefined) {
          return new PayloadReply(undefined, packPayload(result))
        }
        return result
      }
      if (msg.kind === 'addon-call') {
        if (this.addonCallHandler === null) {
          throw new Error(
            `LocalChildClient: addon-call for "${msg.addonId}" arrived but no onAddonCall handler is registered`,
          )
        }
        return this.addonCallHandler({
          addonId: msg.addonId,
          target: msg.target,
          ...(msg.action !== undefined ? { action: msg.action } : {}),
          ...(msg.method !== undefined ? { method: msg.method } : {}),
          ...(msg.args !== undefined ? { args: msg.args } : {}),
          ...(msg.caller !== undefined ? { caller: msg.caller } : {}),
        })
      }
      throw new Error(`unknown parent request kind: ${(msg as { kind: string }).kind}`) // wire-boundary: trusted local UDS channel
    })
    channel.onEvent((body) => {
      const msg = body as ParentEventMessage | SetLogLevelMessage | EventInterestMessage // wire-boundary: trusted local UDS channel
      if (msg.kind === 'event') {
        this.eventHandler?.(msg.event)
        return
      }
      if (msg.kind === 'event-interest') {
        this.eventInterestHandler?.(msg.patterns)
        return
      }
      if (msg.kind === 'set-log-level') {
        this.setLogLevelHandler?.(msg.level)
      }
    })
    // Latest buffered set — includes any caps `updateCaps` recorded before
    // the connect completed (device-restore race).
    const register = this.registerFrame(this.latestCaps)
    try {
      this.parentRawForward = ackAcceptsRawForward(await channel.request(register))
    } catch (err) {
      await client.close()
      throw err
    }
    this.client = client
    this.channel = channel

    // Flush any events/logs that were emitted before the channel opened.
    this.flushPending(channel)

    // Notify all `onConnected` subscribers (e.g. readiness-context hydrate).
    for (const cb of this.connectedHandlers) {
      cb()
    }
  }

  /** Flush buffered pre-start emits over the now-open channel. */
  private flushPending(channel: LocalChannel): void {
    for (const item of this.pendingEmits) {
      channel.emit(item.msg)
    }
    this.pendingEmits.length = 0
  }

  /**
   * Re-send the cap manifest to the parent, atomically replacing the child's
   * registered descriptor set. Call this after device-restore so newly
   * registered native (device-scoped) caps become routable over UDS.
   *
   * Safe to call before `start()`: the new set is buffered and `start()` sends
   * it (device-restore can race ahead of the UDS connect). After `start()`,
   * the set is sent immediately.
   */
  async updateCaps(
    caps: readonly ChildCapDescriptor[],
    customActions?: ChildCustomActionCatalogs,
  ): Promise<void> {
    this.latestCaps = caps
    // The catalogs exist only after the init loop; a caller that has them
    // hands them over here so ONE post-init register carries caps and
    // catalogs together. A caller without them (native-cap change, reconnect)
    // leaves the remembered set alone.
    if (customActions !== undefined) this.latestCustomActions = customActions
    if (this.channel === null) {
      // Pre-start: buffered into `latestCaps`; `start()` will register it.
      return
    }
    this.parentRawForward = ackAcceptsRawForward(
      await this.channel.request(this.registerFrame(caps)),
    )
  }

  /**
   * The register frame: caps, plus everything a re-register must atomically
   * re-carry so no separate re-sync can be missed — the subscription union
   * (omitted if nothing ever declared, which keeps the fail-open shape) and the
   * custom-action catalogs (omitted until the init loop produced them).
   */
  private registerFrame(caps: readonly ChildCapDescriptor[]): RegisterMessage {
    return {
      kind: 'register',
      childId: this.options.childId,
      caps,
      ...(this.hasDeclaredEventPatterns ? { eventPatterns: this.latestEventPatterns } : {}),
      ...(this.latestCustomActions !== null ? { customActions: this.latestCustomActions } : {}),
      // This client can take payload-borne args on a `cap-call`; whether the
      // parent USES that is the parent's decision (its env, its ack).
      rawForward: true,
    }
  }

  /**
   * Fire-and-forget: send a system event to the parent for forwarding to the
   * hub event bus. Safe to call before `start()` — events are buffered and
   * flushed on connect.
   */
  emitEvent(event: SystemEvent): void {
    const msg: ChildEventMessage = { kind: 'event', event }
    if (this.channel !== null) {
      this.channel.emit(msg)
    } else {
      this.pendingEmits.push({ kind: 'event', msg })
    }
  }

  /**
   * Fire-and-forget: send a structured log entry to the parent. Safe to call
   * before `start()` — log entries are buffered and flushed on connect.
   */
  sendLog(entry: Omit<ChildLogMessage, 'kind'>): void {
    const msg: ChildLogMessage = { kind: 'log', ...entry }
    if (this.channel !== null) {
      this.channel.emit(msg)
    } else {
      this.pendingEmits.push({ kind: 'log', msg })
    }
  }

  /**
   * Request the current readiness snapshot from the parent. Returns the
   * authoritative set of `IReadinessRegistryRecord` entries the hub holds.
   * Requires `start()` to have been called; throws with a clear message if not.
   */
  async requestReadinessSnapshot(): Promise<readonly IReadinessRegistryRecord[]> {
    if (this.channel === null) {
      throw new Error('LocalChildClient: requestReadinessSnapshot called before start()')
    }
    const req: ReadinessSnapshotRequest = { kind: 'readiness-request' }
    // wire-boundary: trusted local UDS channel
    const resp = (await this.channel.request(req)) as ReadinessSnapshotResponse
    return resp.records
  }

  /**
   * Ask the parent to execute a cap call this child does NOT own. The parent
   * routes to the owning local sibling over UDS, or — if no sibling owns it —
   * to its `onUnownedCall` fallback (the cluster CapabilityRegistry in
   * production). Throws if called before `start()`.
   */
  async callOut(input: CapCallInput): Promise<unknown> {
    if (this.channel === null) {
      throw new Error('LocalChildClient: callOut before start')
    }
    const routing = {
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      // Native-only routing hint — the one thing that stops the parent (and
      // this child's own tRPC chain, which never sees this call) resolving a
      // wrapper cap NAME back to the wrapper that is asking.
      ...(input.native === true ? { native: true } : {}),
    }
    if (this.parentRawForward && input.args !== undefined) {
      // Raw-forward: the args are packed ONCE here and travel as the frame's
      // opaque payload. The parent routes on the envelope plus the two fields
      // it used to read out of the args (`hints`), and a sibling unpacks the
      // payload in its own process. Void args (`z.void()`) keep the inline
      // shape: there is nothing to pack, and an omitted key must stay
      // `undefined` on the far side.
      const hints = liftRoutingHints(input.args)
      const msg: CapCallOutMessage = {
        kind: 'cap-call-out',
        capName: input.capName,
        method: input.method,
        ...(Object.keys(hints).length > 0 ? { hints } : {}),
        ...routing,
      }
      const reply = await this.channel.request(msg, { payload: packPayload(input.args) })
      return reply instanceof PayloadReply ? unpackPayload(reply.payload) : reply
    }
    const msg: CapCallOutMessage = {
      kind: 'cap-call-out',
      capName: input.capName,
      method: input.method,
      args: input.args,
      ...routing,
    }
    return this.channel.request(msg)
  }

  /** Disconnect from the parent. Safe to call before `start()` (no-op) and idempotent. */
  async close(): Promise<void> {
    await this.client?.close()
    this.client = null
    this.channel = null
  }
}
