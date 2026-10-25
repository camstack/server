/**
 * ReadinessRegistry — kernel-side tracker for capability readiness
 * transitions. Spec: `docs/superpowers/specs/2026-04-19-system-readiness-design.md`.
 *
 * Each process owns one registry. The registry:
 *  - Listens to `system.ready-state` events on the event bus.
 *  - Maintains a `Map<key, ReadinessRecord>` snapshot of the most
 *    recently observed state + generation + derived epoch.
 *  - Exposes `emitReady` / `emitStarting` / `emitDown` helpers for
 *    local producers (which stamp the process-wide `generation`).
 *  - Exposes `awaitReady(capName, scope, {timeoutMs, signal})` and
 *    `onReadyState(capName, scope, handler)` for consumers.
 *
 * Epoch derivation:
 *  - First `ready` observed for a `(capName, scope)` → epoch = 1.
 *  - `ready` received with a generation different from the last
 *    `currentGeneration` → epoch++.
 *  - Same-generation repeated `ready` events → epoch unchanged
 *    (idempotent keepalive; e.g. re-emit on `$node.connected`).
 *
 * Not persisted. Rebuilt from the event stream + optional boot-time
 * snapshot rehydration by the caller.
 */
import type {
  IEventBus,
  ReadinessScope,
  ReadinessState,
  SystemReadyStatePayload,
} from '../interfaces/event-bus.js'
import { createEvent } from '../interfaces/event-bus.js'
import type { IScopedLogger } from '../interfaces/logging.js'
import type {
  IAwaitReadyOptions,
  IReadinessHandler,
  IReadinessRegistry,
  IReadinessTransition,
} from '../interfaces/readiness.js'

/**
 * Concrete types live here; `interfaces/readiness.ts` declares the
 * matching narrow interfaces (`IReadinessTransition`,
 * `IReadinessHandler`, `IAwaitReadyOptions`) used by `AddonContext`
 * and other consumer-facing types.
 */
export type ReadinessTransition = IReadinessTransition
export type ReadinessHandler = IReadinessHandler
export type AwaitReadyOptions = IAwaitReadyOptions

export class ReadinessTimeoutError extends Error {
  readonly capName: string
  readonly scope: ReadinessScope
  readonly waitedMs: number
  constructor(capName: string, scope: ReadinessScope, waitedMs: number) {
    super(
      `Timed out waiting for ${capName} (${scopeKey(scope)}) to become ready after ${waitedMs}ms`,
    )
    this.name = 'ReadinessTimeoutError'
    this.capName = capName
    this.scope = scope
    this.waitedMs = waitedMs
  }
}

interface ReadinessRecord {
  capName: string
  scope: ReadinessScope
  state: ReadinessState
  generation: string
  epoch: number
  lastChange: number
  /**
   * Node that emitted the latest transition for this record. Needed for
   * `agent.offline` demux of `device`-scoped caps (scope itself carries
   * no node info). For `node`-scoped caps this matches `scope.nodeId`.
   */
  sourceNodeId: string
}

interface Subscription {
  readonly capName: string
  readonly scope: ReadinessScope
  readonly handler: ReadinessHandler
}

/**
 * Build a canonical string key for a `(capName, scope)` pair. Used as
 * the snapshot map key and for log/debug output.
 */
export function readinessKey(capName: string, scope: ReadinessScope): string {
  return `${capName}|${scopeKey(scope)}`
}

function scopeKey(scope: ReadinessScope): string {
  switch (scope.type) {
    case 'global':
      return 'global'
    case 'node':
      return `node:${scope.nodeId}`
    case 'device':
      return `device:${scope.deviceId}`
  }
}

/**
 * Producer transition order within ONE generation: `starting → ready →
 * down`. Used by `hydrate` to accept only forward moves for
 * same-generation snapshot records (a snapshot can be ahead of a lost
 * delta, never behind it, within one producer generation).
 */
function stateRank(state: ReadinessState): number {
  switch (state) {
    case 'starting':
      return 0
    case 'ready':
      return 1
    case 'down':
      return 2
  }
}

function scopesEqual(a: ReadinessScope, b: ReadinessScope): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'global' || b.type === 'global') return true
  if (a.type === 'node' && b.type === 'node') return a.nodeId === b.nodeId
  if (a.type === 'device' && b.type === 'device') return a.deviceId === b.deviceId
  return false
}

export interface ReadinessRegistryOptions {
  readonly eventBus: IEventBus
  readonly sourceNodeId: string
  /**
   * Per-process generation id — stamped on every emit made via this
   * registry's `emitReady`/`emitStarting`/`emitDown` helpers. Caller
   * owns the value so it can survive across subsystem re-bindings
   * within the same process. Default: a random 12-char id.
   */
  readonly generation?: string
  readonly logger?: IScopedLogger
  /**
   * Clock source. Injectable for tests.
   */
  readonly now?: () => number
  /**
   * Opt-in per-record debug logging for DEVICE-scoped transitions.
   *
   * Default `false` — and that default is load-bearing. Device-scoped
   * readiness is O(caps × devices) (observed live: 776 pairs for one
   * producer generation), and EVERY process runs a registry whose logs
   * forward to the hub `LogManager`. With per-record logging on, one hub
   * container boot produced 21 577 identical-shape debug lines in a
   * single minute (776 pairs × ~28 processes, 2026-08-01 15:04Z) — noise
   * that buried the lines that mattered while the operator was asking
   * why the viewer stalled. Node/global-scoped transitions stay logged
   * per-record unconditionally: they are low-cardinality and every
   * readiness investigation so far has needed them.
   */
  readonly verboseDeviceScopeLogs?: boolean
}

export class ReadinessRegistry implements IReadinessRegistry {
  private readonly bus: IEventBus
  private readonly sourceNodeId: string
  private readonly logger: IScopedLogger | undefined
  private readonly now: () => number
  private readonly generation: string
  private readonly verboseDeviceScopeLogs: boolean
  private readonly snapshot = new Map<string, ReadinessRecord>()
  private readonly subscriptions = new Set<Subscription>()
  private readonly unsubscribeBus: () => void
  private readonly unsubscribeAgentOffline: () => void

  constructor(options: ReadinessRegistryOptions) {
    this.bus = options.eventBus
    this.sourceNodeId = options.sourceNodeId
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.generation = options.generation ?? randomGeneration()
    this.verboseDeviceScopeLogs = options.verboseDeviceScopeLogs ?? false

    this.unsubscribeBus = this.bus.subscribe({ category: 'system.ready-state' }, (event) =>
      this.ingest(event.data as SystemReadyStatePayload),
    )
    // Auto-heal on agent disconnect: when `agent.offline` fires, walk
    // our own snapshot and synthesize `down` transitions for every
    // node-scoped cap bound to the disconnected nodeId. This covers
    // ungraceful producer deaths (process crash, network blip,
    // SIGKILL) where the producer's own shutdown hook never fires —
    // subscribers would otherwise keep waiting on a stale `ready`.
    // Synthesized transitions are local-only (we don't re-emit on the
    // bus) — every registry reacts independently to the same agent.offline.
    this.unsubscribeAgentOffline = this.bus.subscribe({ category: 'agent.offline' }, (event) =>
      this.synthesizeDownForNode((event.data as { agentId: string }).agentId),
    )
    // Hydrate from recent bus events so a late-starting registry
    // (e.g. an addon subscribed mid-session, or a hub reboot where
    // producers haven't re-emitted yet) picks up already-fired
    // readiness transitions. Safe to run after subscribe: ingest()
    // is idempotent for same-generation replays.
    if (typeof this.bus.getRecent === 'function') {
      try {
        const recent = this.bus.getRecent({ category: 'system.ready-state' })
        for (const event of recent) {
          this.ingest(event.data as SystemReadyStatePayload)
        }
      } catch {
        // getRecent is optional — a minimal test bus may not support it.
      }
    }
  }

  /** Release the event-bus subscription. Idempotent. */
  close(): void {
    this.unsubscribeBus()
    this.unsubscribeAgentOffline()
    this.subscriptions.clear()
  }

  /** Current snapshot for a `(capName, scope)` pair, or `null` if never seen. */
  get(capName: string, scope: ReadinessScope): ReadinessRecord | null {
    return this.snapshot.get(readinessKey(capName, scope)) ?? null
  }

  /**
   * Serializable snapshot for cross-process transport. Returns an array
   * of `ReadinessRecord` plain objects — safe for MsgPack / JSON
   * transport. Used by the hub's `$readiness.getSnapshot` Moleculer
   * action; consumers hydrate their local registry from the result.
   */
  getSnapshotForTransport(): readonly ReadinessRecord[] {
    return Array.from(this.snapshot.values())
  }

  /**
   * Hydrate the snapshot from an authoritative source — a RECONCILE, not
   * an add-only merge (D8: readiness events are telemetry and may be
   * lost; the on-reconnect/periodic snapshot re-pull is the repair path,
   * so it MUST be able to advance a stale record — the 2026-07-17
   * "still awaiting platform-probe forever" wedge was this method
   * skipping every already-seen key).
   *
   *  - **Unseen keys** are added (epoch 1 — mirrors the value the
   *    consumer would have derived from the first observed `ready`).
   *  - **Existing keys** are UPDATED when the authoritative record
   *    carries a different generation (producer restart / synthetic-down
   *    superseded — epoch bumps on a new-generation `ready`, mirroring
   *    `ingest`), or a FORWARD state move within the same generation
   *    (`starting → ready → down`; within one producer generation a
   *    snapshot can only be ahead of a lost delta, never behind it).
   *  - **Never a same-generation regress** — a snapshot pulled just
   *    before a live delta landed must not un-ready a record (the next
   *    reconcile round converges it anyway).
   *  - **Never a record this process is authoritative for** — node-scoped
   *    records for our own nodeId, and device/global records we emitted,
   *    keep local truth (an authority's stale copy of OUR record must
   *    not regress us).
   *
   * Every applied entry dispatches a one-shot transition to matching
   * subscriptions so pending `awaitReady` callers unblock without having
   * to wait for a fresh event.
   *
   * Returns the number of records APPLIED (added or advanced). Callers
   * doing periodic reconciles use this to stay silent when the snapshot
   * changed nothing — the every-60s "hydrated 1446 record(s)" heartbeat
   * from every child process was pure noise (≈2 800 lines/hour observed
   * live on 2026-08-01).
   */
  hydrate(records: readonly ReadinessRecord[]): number {
    const now = this.now()
    let applied = 0
    for (const record of records) {
      const key = readinessKey(record.capName, record.scope)
      const prev = this.snapshot.get(key) ?? null
      let epoch: number
      let durationInPrevState: number
      if (prev !== null) {
        if (this.isLocallyAuthoritative(prev)) continue
        const sameGeneration = prev.generation === record.generation
        if (sameGeneration && stateRank(record.state) <= stateRank(prev.state)) continue
        epoch = !sameGeneration && record.state === 'ready' ? prev.epoch + 1 : prev.epoch
        durationInPrevState = Math.max(0, now - prev.lastChange)
      } else {
        epoch = 1
        durationInPrevState = 0
      }
      const hydrated: ReadinessRecord = {
        capName: record.capName,
        scope: record.scope,
        state: record.state,
        generation: record.generation,
        epoch,
        lastChange: now,
        sourceNodeId: record.sourceNodeId,
      }
      this.snapshot.set(key, hydrated)
      applied++
      this.logPerRecord(
        record.scope,
        `readiness: ${record.capName} (${scopeKey(record.scope)}) → ${record.state} (hydrated${prev !== null ? ' update' : ''}, gen=${record.generation.slice(0, 6)})`,
      )
      const transition: ReadinessTransition = {
        capName: record.capName,
        scope: record.scope,
        state: record.state,
        epoch,
        generation: record.generation,
        sourceNodeId: 'hydrated',
        ts: now,
        durationInPrevState,
      }
      for (const sub of this.subscriptions) {
        if (sub.capName !== record.capName) continue
        if (!scopesEqual(sub.scope, record.scope)) continue
        try {
          sub.handler(transition)
        } catch (err) {
          this.logger?.warn(
            `readiness hydrate handler threw for ${record.capName}: ${(err as Error).message ?? String(err)}`,
          )
        }
      }
    }
    return applied
  }

  /**
   * Per-record debug line, volume-gated: device-scoped records are logged
   * only when `verboseDeviceScopeLogs` is set (see the option's doc for
   * the 21 577-lines-per-boot-minute incident that forced the gate);
   * node/global records always log. Device lines carry `tags.deviceId`
   * so they group per-camera (CLAUDE.md logging rule).
   */
  private logPerRecord(scope: ReadinessScope, message: string): void {
    if (!this.logger) return
    if (scope.type === 'device') {
      if (!this.verboseDeviceScopeLogs) return
      this.logger.debug(message, { tags: { deviceId: scope.deviceId } })
      return
    }
    this.logger.debug(message)
  }

  /**
   * True when THIS process is the origin authority for `record` — a
   * snapshot pulled from elsewhere must never overwrite it:
   *  - node-scoped records whose `scope.nodeId` is our own node id
   *    (this process — or a child bridged onto our bus — emits them);
   *  - device/global-scoped records whose latest transition WE emitted.
   */
  private isLocallyAuthoritative(record: ReadinessRecord): boolean {
    if (record.scope.type === 'node') return record.scope.nodeId === this.sourceNodeId
    return record.sourceNodeId === this.sourceNodeId
  }

  /** Shallow copy of the full snapshot — mainly for diagnostics/tests. */
  getAll(): ReadonlyMap<string, ReadinessRecord> {
    return new Map(this.snapshot)
  }

  /**
   * Emit a `ready` transition for a locally-owned capability. The
   * payload carries this registry's `generation` so remote registries
   * can derive their own `epoch`.
   */
  emitReady(capName: string, scope: ReadinessScope): void {
    this.emitTransition(capName, scope, 'ready')
  }

  emitStarting(capName: string, scope: ReadinessScope): void {
    this.emitTransition(capName, scope, 'starting')
  }

  emitDown(capName: string, scope: ReadinessScope): void {
    this.emitTransition(capName, scope, 'down')
  }

  /**
   * One-shot: resolve once the cap is `ready`. Reads the snapshot
   * first — if already ready, resolves synchronously on the next tick.
   *
   * Default behaviour is **wait indefinitely** (timeoutMs = `Infinity`):
   * the orchestrator and other callers never want to attach a camera
   * with empty steps just because a cap took longer than 30s to come
   * up. Pass an explicit finite `timeoutMs` to bound the wait, or an
   * `AbortSignal` to cancel externally. `Infinity` is honoured natively
   * — no `setTimeout` is registered (Node's setTimeout silently clamps
   * values above ~24.8d, so we must skip the timer entirely).
   */
  awaitReady(capName: string, scope: ReadinessScope, opts: AwaitReadyOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? Number.POSITIVE_INFINITY
    const start = this.now()
    const current = this.get(capName, scope)
    if (current?.state === 'ready') {
      return Promise.resolve()
    }
    if (opts.signal?.aborted) {
      return Promise.reject(opts.signal.reason ?? new Error('aborted'))
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const unsubscribe = this.onReadyState(capName, scope, (t) => {
        if (t.state !== 'ready') return
        if (settled) return
        settled = true
        cleanup()
        resolve()
      })
      const isInfinite = !Number.isFinite(timeoutMs)
      const timer: ReturnType<typeof setTimeout> | null = isInfinite
        ? null
        : setTimeout(() => {
            if (settled) return
            settled = true
            cleanup()
            reject(new ReadinessTimeoutError(capName, scope, this.now() - start))
          }, timeoutMs)
      // Periodic diagnostic: an `awaitReady` that never resolves (e.g. a
      // missed cross-process `system.ready-state` delta to a forked UDS
      // child) is otherwise completely silent. Emit a `warn` every 30s
      // while still pending so a wedged wait surfaces in the log with the
      // cap, scope, and elapsed time — mirrors brokerTransportLink's
      // "still awaiting" diagnostic. `unref()` so the timer never keeps
      // the process alive on its own.
      const PENDING_LOG_INTERVAL_MS = 30_000
      const pendingLogTimer: ReturnType<typeof setInterval> = setInterval(() => {
        if (settled) return
        this.logger?.warn(
          `readiness: still awaiting ${capName} (${scopeKey(scope)}) after ${this.now() - start}ms`,
        )
      }, PENDING_LOG_INTERVAL_MS)
      if (typeof pendingLogTimer.unref === 'function') pendingLogTimer.unref()
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(opts.signal?.reason ?? new Error('aborted'))
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      function cleanup(): void {
        unsubscribe()
        if (timer !== null) clearTimeout(timer)
        clearInterval(pendingLogTimer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
    })
  }

  /**
   * Observable: every transition (starting/ready/down) dispatches to
   * `handler`. On subscription, if the snapshot has a current state,
   * the handler fires ONCE asynchronously with that state as the
   * initial transition (duration = 0) so late subscribers can pick up
   * current state without racing the next transition.
   *
   * Returns an unsubscribe function.
   */
  onReadyState(capName: string, scope: ReadinessScope, handler: ReadinessHandler): () => void {
    const sub: Subscription = { capName, scope, handler }
    this.subscriptions.add(sub)
    const current = this.get(capName, scope)
    if (current !== null) {
      queueMicrotask(() => {
        if (!this.subscriptions.has(sub)) return
        handler({
          capName,
          scope,
          state: current.state,
          epoch: current.epoch,
          generation: current.generation,
          sourceNodeId: this.sourceNodeId,
          ts: current.lastChange,
          durationInPrevState: 0,
        })
      })
    }
    return () => {
      this.subscriptions.delete(sub)
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private emitTransition(capName: string, scope: ReadinessScope, state: ReadinessState): void {
    const ts = this.now()
    this.bus.emit(
      createEvent(
        'system.ready-state',
        { type: 'capability', id: capName, nodeId: this.sourceNodeId },
        {
          capName,
          scope,
          state,
          generation: this.generation,
          sourceNodeId: this.sourceNodeId,
          ts,
        },
      ),
    )
  }

  /**
   * Update snapshot + dispatch to subscribers. Idempotent: same
   * `generation + state` replay is a no-op for both snapshot and
   * subscribers.
   *
   * Defensive against malformed payloads (legal reason: a mock bus's
   * `getRecent` may ignore the category filter and replay unrelated
   * events when we hydrate at construction time).
   */
  private ingest(payload: SystemReadyStatePayload): void {
    if (typeof payload?.capName !== 'string') return
    if (payload.state !== 'ready' && payload.state !== 'starting' && payload.state !== 'down')
      return
    if (typeof payload.generation !== 'string') return
    if (
      payload.scope?.type !== 'global' &&
      payload.scope?.type !== 'node' &&
      payload.scope?.type !== 'device'
    )
      return

    const key = readinessKey(payload.capName, payload.scope)
    const prev = this.snapshot.get(key) ?? null
    const now = this.now()

    let epoch: number
    if (prev === null) {
      epoch = payload.state === 'ready' ? 1 : 0
    } else if (prev.generation !== payload.generation && payload.state === 'ready') {
      epoch = prev.epoch + 1
    } else {
      epoch = prev.epoch
    }

    // Idempotent replay: same generation + same state + we've already
    // recorded it — skip both snapshot write and dispatch.
    if (prev !== null && prev.generation === payload.generation && prev.state === payload.state) {
      return
    }

    const durationInPrevState = prev === null ? 0 : Math.max(0, now - prev.lastChange)
    const next: ReadinessRecord = {
      capName: payload.capName,
      scope: payload.scope,
      state: payload.state,
      generation: payload.generation,
      epoch,
      lastChange: now,
      sourceNodeId: payload.sourceNodeId,
    }
    this.snapshot.set(key, next)

    const transition: ReadinessTransition = {
      capName: payload.capName,
      scope: payload.scope,
      state: payload.state,
      epoch,
      generation: payload.generation,
      sourceNodeId: payload.sourceNodeId,
      ts: payload.ts,
      durationInPrevState,
    }

    this.logPerRecord(
      payload.scope,
      `readiness: ${payload.capName} (${scopeKey(payload.scope)}) → ${payload.state} epoch=${epoch} gen=${payload.generation.slice(0, 6)} (prev ${durationInPrevState}ms)`,
    )

    for (const sub of this.subscriptions) {
      if (sub.capName !== payload.capName) continue
      if (!scopesEqual(sub.scope, payload.scope)) continue
      try {
        sub.handler(transition)
      } catch (err) {
        this.logger?.warn(
          `readiness handler threw for ${payload.capName}: ${(err as Error).message ?? String(err)}`,
        )
      }
    }
  }

  /**
   * `agent.offline` demux. When an agent disconnects ungracefully,
   * its BaseAddon's shutdown hook doesn't fire — consumers would
   * otherwise keep waiting on a stale `ready`. Walk the snapshot and
   * synthesize a `down` transition for every node-scoped record bound
   * to the disconnected `nodeId`, skipping records already `down`.
   *
   * Synthesis is LOCAL: we don't re-emit on the bus. Every registry
   * (one per process) receives the same `agent.offline` and reacts
   * independently, which means no duplicated downs and no central
   * supervisor required.
   */
  private synthesizeDownForNode(offlineNodeId: string): void {
    const now = this.now()
    for (const [key, record] of this.snapshot) {
      if (record.state === 'down') continue
      // Node-scoped records: match on scope.nodeId.
      // Device-scoped records: match on sourceNodeId (which node emitted
      // the latest ready) because the scope itself carries no node info.
      // Global-scoped records are skipped — they're not tied to a node.
      const matchesOfflineNode =
        (record.scope.type === 'node' && record.scope.nodeId === offlineNodeId) ||
        (record.scope.type === 'device' && record.sourceNodeId === offlineNodeId)
      if (!matchesOfflineNode) continue

      const durationInPrevState = Math.max(0, now - record.lastChange)
      const next: ReadinessRecord = {
        ...record,
        state: 'down',
        lastChange: now,
      }
      this.snapshot.set(key, next)

      const transition: ReadinessTransition = {
        capName: record.capName,
        scope: record.scope,
        state: 'down',
        epoch: record.epoch,
        generation: record.generation,
        sourceNodeId: this.sourceNodeId,
        ts: now,
        durationInPrevState,
      }
      this.logPerRecord(
        record.scope,
        `readiness: ${record.capName} (${scopeKey(record.scope)}) → down (synthesized from agent.offline ${offlineNodeId})`,
      )
      for (const sub of this.subscriptions) {
        if (sub.capName !== record.capName) continue
        if (!scopesEqual(sub.scope, record.scope)) continue
        try {
          sub.handler(transition)
        } catch (err) {
          this.logger?.warn(
            `readiness handler threw during agent.offline demux for ${record.capName}: ${(err as Error).message ?? String(err)}`,
          )
        }
      }
    }
  }
}

function randomGeneration(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2, 14)
}

// ---------------------------------------------------------------------------
// Helpers for `$node.disconnected` demultiplexing
// ---------------------------------------------------------------------------

/**
 * Given a list of `(capName, scope)` pairs that a just-disconnected
 * node owned, emit a `down` transition for each. Callers (kernel
 * supervisor, hub `$node.disconnected` handler) wire this up once they
 * know which caps the node held.
 */
export function emitDownForOwnedCaps(
  registry: ReadinessRegistry,
  owned: ReadonlyArray<{ readonly capName: string; readonly scope: ReadinessScope }>,
): void {
  for (const { capName, scope } of owned) {
    registry.emitDown(capName, scope)
  }
}

// Re-export the scope key helper for consumers that want to
// collate by key in their own maps (e.g. debug UIs).
export { scopeKey }
