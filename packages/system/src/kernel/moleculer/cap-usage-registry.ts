/**
 * In-memory observation of tRPC cap calls between addons — the store behind
 * `nodes.getCapUsageGraph`.
 *
 * Storage: `Map<callerAddonId, Map<providerAddonId, Map<capName, RollingWindow>>>`.
 * `RollingWindow` is a fixed-size ring of 1-second buckets — default 300
 * buckets = 5 minutes retention. Queries narrower than the retention window
 * filter buckets at read time.
 *
 * ── The ring ages, and that is not free decoration ─────────────────────────
 * Buckets are indexed `second % retention`, so a bucket written at second S is
 * hit again at S + retention·k forever. Until 2026-08-30 nothing ever zeroed
 * them: the `lastCallAtMs` guard hid it while a triple was fully idle, but ONE
 * fresh call re-armed the entire stale ring. A triple that made 1000 calls and
 * then one call five minutes later reported **1001 calls/min instead of 1**.
 * An over-counted edge is worse than the empty graph this instrument shipped
 * with — silence invites doubt, a confident wrong number sends the next
 * investigation at the wrong addon.
 *
 * The fix is clear-forward: on each record, zero the buckets the ring has
 * ADVANCED over since the previous write, and never read past the last written
 * second. Amortised O(1) — a busy triple clears 0–1 buckets per call, and an
 * idle one clears at most `retention` once, when it wakes.
 *
 * ── Cardinality is bounded, because this map lives on hub-main ─────────────
 * The previous docblock claimed "~22 MB worst case … under 200 KB at ~10 active
 * triples". Both numbers were written for a smaller machine and the second was
 * an assumption, not a bound: the key space is caller × provider × cap, and on
 * the live hub that is 64 addons × 64 runners × ~150 caps. Nothing capped it.
 *
 * Today a ring is one `Uint32Array(retention)` — 1.2 KB of ArrayBuffer at the
 * default — plus the three Map entries that reach it. MEASURED (`heapUsed` +
 * `arrayBuffers`, node 24, `--expose-gc`): **1.7 KB per triple**, so ≈1.0 MB at
 * the realistic hub figure (64 callers × a handful of caps each, ≈600 triples)
 * and **6.3 MB at the {@link DEFAULT_MAX_TRIPLES} ceiling**. `recordCall` costs
 * ≈46 ns (1e6 calls in 46 ms) — at the 39 717 calls/min that started this
 * investigation, ≈30 µs of hub-main per second.
 *
 * Reclamation is what keeps it at the low end: a triple whose ring has entirely
 * aged out is dead data and is dropped on the next admission sweep. The hard
 * cap only exists so that a pathological key space (a caller id derived from
 * something unbounded) cannot take hub-main's heap with it — and when it bites,
 * {@link CapUsageRegistry.getStats} says how often, because an instrument that
 * truncates silently is the defect this whole file exists to fix (D237).
 */

/** Ring length in seconds when the caller does not pick one. */
const DEFAULT_RETENTION_SECONDS = 300

/**
 * Ceiling on live `(caller, provider, cap)` triples. ≈1.5 KB each → ≈6 MB.
 * Roughly 6× the realistic hub figure, so it is a backstop against an
 * unbounded key space, not a working limit.
 */
const DEFAULT_MAX_TRIPLES = 4_000

/**
 * Provider placeholder for a call the PARENT routed rather than short-
 * circuiting to a sibling runner: hub-in-process (`settings-store`,
 * `device-manager`, the `$core-caps` bridge), or a remote node. At the layer
 * that records — the parent's `cap-call-out` handler — the sibling id IS the
 * provider and everything else has not been resolved yet.
 *
 * It is a NAMED unknown, not a dropped observation, for the reason D237 was
 * written: the caller is always known, and "who is hammering `settings-store`"
 * is the question this graph exists to answer. Sibling to
 * `UNRESOLVED_PROVIDER_ADDON_ID` in `trpc-links.ts`, which names the same kind
 * of unknown one layer up.
 */
export const PARENT_ROUTED_PROVIDER_ADDON_ID = '(unresolved: parent-routed)'

export interface CapUsageCallRecord {
  readonly callerAddonId: string
  readonly providerAddonId: string
  readonly capName: string
  readonly methodName: string
  readonly atMs: number
}

/**
 * One observed caller → provider → cap edge.
 *
 * There is deliberately no `methodName`: the ring is keyed by CAPABILITY, so
 * `deviceManager.getAllBindings` (the whole fleet) and
 * `deviceManager.getBindings` (one camera) collapse into the same edge. The
 * method IS recorded on the way in ({@link CapUsageCallRecord.methodName}) and
 * discarded here. Splitting the key by method would multiply cardinality by the
 * per-cap method count — worth doing, but it is a schema change to
 * `nodes.getCapUsageGraph`, not a quiet widening of a map on hub-main.
 */
export interface CapUsageEdge {
  readonly callerAddonId: string
  readonly providerAddonId: string
  readonly capName: string
  readonly callsPerMin: number
  readonly lastCallAtMs: number
}

export interface CapUsageRegistryOptions {
  /** Max retention in seconds (ring length). Default 300. */
  readonly retentionSeconds?: number
  /**
   * Ceiling on live `(caller, provider, cap)` triples. Default
   * {@link DEFAULT_MAX_TRIPLES}. Reaching it drops NEW triples (counted in
   * {@link CapUsageStats.droppedTriples}); triples already being watched keep
   * counting exactly.
   */
  readonly maxTriples?: number
}

/** What the registry knows about its own coverage. Never a guess. */
export interface CapUsageStats {
  /** Live `(caller, provider, cap)` triples held right now. */
  readonly triples: number
  /** Ceiling in force. */
  readonly maxTriples: number
  /**
   * New triples refused since process start because the ceiling was full.
   * Non-zero means the graph is INCOMPLETE — some caller→cap edge exists and
   * is not shown. Nothing else in this file can be incomplete without saying so.
   */
  readonly droppedTriples: number
}

interface RollingWindow {
  /** One element per second-bucket; value = call count. Indexed `second % retention`. */
  readonly buckets: Uint32Array
  /** Absolute timestamp (ms) of the most-recent recorded call. `0` = never written. */
  lastCallAtMs: number
}

export class CapUsageRegistry {
  private readonly retentionSeconds: number
  private readonly maxTriples: number
  private readonly map = new Map<string, Map<string, Map<string, RollingWindow>>>()
  private triples = 0
  private droppedTriples = 0

  constructor(opts?: CapUsageRegistryOptions) {
    this.retentionSeconds = Math.max(1, opts?.retentionSeconds ?? DEFAULT_RETENTION_SECONDS)
    this.maxTriples = Math.max(1, opts?.maxTriples ?? DEFAULT_MAX_TRIPLES)
  }

  /**
   * Record one observed cap call.
   *
   * On the hot path: this runs once per cross-process cap call on hub-main's
   * event loop, which is the cluster's only queue (D181). Three Map lookups, an
   * integer increment, and — only when the wall clock has moved on — a bounded
   * clear. No allocation once a triple exists, and it NEVER throws into the
   * call it observes.
   */
  recordCall(rec: CapUsageCallRecord): void {
    try {
      if (rec.callerAddonId === '' || rec.providerAddonId === '' || rec.capName === '') return
      if (!Number.isFinite(rec.atMs) || rec.atMs < 0) return
      const window = this.windowFor(rec)
      if (window === null) return

      const sec = Math.floor(rec.atMs / 1000)
      // Clear-forward: zero every bucket the ring has advanced over since the
      // last write, so a lapped bucket cannot be read as current traffic.
      // Nothing to clear on a fresh window (all zeroes) or a same-second write.
      if (window.lastCallAtMs !== 0) {
        const lastSec = Math.floor(window.lastCallAtMs / 1000)
        const advanced = Math.min(sec - lastSec, this.retentionSeconds)
        for (let k = 1; k <= advanced; k++) {
          window.buckets[(lastSec + k) % this.retentionSeconds] = 0
        }
      }
      const idx = sec % this.retentionSeconds
      window.buckets[idx] = (window.buckets[idx] ?? 0) + 1
      if (rec.atMs > window.lastCallAtMs) window.lastCallAtMs = rec.atMs
    } catch {
      // Observers never fail the caller.
    }
  }

  getGraph(opts: { windowSeconds: number; nowMs: number }): readonly CapUsageEdge[] {
    const windowSeconds = Math.max(1, Math.min(opts.windowSeconds, this.retentionSeconds))
    const minMs = opts.nowMs - windowSeconds * 1000
    const nowSec = Math.floor(opts.nowMs / 1000)
    const out: CapUsageEdge[] = []
    for (const [caller, byProvider] of this.map) {
      for (const [provider, byCap] of byProvider) {
        for (const [capName, window] of byCap) {
          if (window.lastCallAtMs < minMs) continue
          const count = this.sumWindow(window, nowSec, windowSeconds)
          if (count === 0) continue
          const callsPerMin = (count / windowSeconds) * 60
          out.push({
            callerAddonId: caller,
            providerAddonId: provider,
            capName,
            callsPerMin,
            lastCallAtMs: window.lastCallAtMs,
          })
        }
      }
    }
    return out
  }

  /** See {@link CapUsageStats}. Cheap — three counters, no scan. */
  getStats(): CapUsageStats {
    return {
      triples: this.triples,
      maxTriples: this.maxTriples,
      droppedTriples: this.droppedTriples,
    }
  }

  /** Test / diagnostic helper — drops all recorded calls. */
  clear(): void {
    this.map.clear()
    this.triples = 0
    this.droppedTriples = 0
  }

  /**
   * Sum the buckets covering `(nowSec - windowSeconds, nowSec]`.
   *
   * The scan starts at `lastSec`, never at `nowSec`. `recordCall` clears the
   * buckets the ring has advanced OVER, which by definition stops at the last
   * write: the buckets for the seconds since then still hold whatever the
   * previous pass left in them, and reading `nowSec` down would count it. A
   * triple that went quiet for a couple of minutes and then made one call would
   * report the burst it made five minutes earlier.
   *
   * No lower bound is needed beyond the window itself: every bucket at or below
   * `lastSec - retention` was cleared by the advance that reached `lastSec`, so
   * it reads zero anyway. The loop is bounded by `windowSeconds ≤ retention`.
   */
  private sumWindow(window: RollingWindow, nowSec: number, windowSeconds: number): number {
    const lastSec = Math.floor(window.lastCallAtMs / 1000)
    const from = Math.min(nowSec, lastSec)
    const floorSec = nowSec - windowSeconds
    let count = 0
    for (let s = from; s > floorSec; s--) {
      count += window.buckets[s % this.retentionSeconds] ?? 0
    }
    return count
  }

  /**
   * The ring for this triple, creating it if the ceiling allows. `null` means
   * the observation is dropped — counted, never silent (see
   * {@link CapUsageStats.droppedTriples}).
   */
  private windowFor(rec: CapUsageCallRecord): RollingWindow | null {
    let byProvider = this.map.get(rec.callerAddonId)
    if (!byProvider) {
      byProvider = new Map()
      this.map.set(rec.callerAddonId, byProvider)
    }
    let byCap = byProvider.get(rec.providerAddonId)
    if (!byCap) {
      byCap = new Map()
      byProvider.set(rec.providerAddonId, byCap)
    }
    const existing = byCap.get(rec.capName)
    if (existing) return existing

    if (this.triples >= this.maxTriples) {
      this.reclaimExpired(rec.atMs)
      if (this.triples >= this.maxTriples) {
        this.droppedTriples++
        return null
      }
      // The sweep may have removed the branch we just walked to.
      byProvider = this.map.get(rec.callerAddonId)
      if (!byProvider) {
        byProvider = new Map()
        this.map.set(rec.callerAddonId, byProvider)
      }
      byCap = byProvider.get(rec.providerAddonId)
      if (!byCap) {
        byCap = new Map()
        byProvider.set(rec.providerAddonId, byCap)
      }
    }

    const created: RollingWindow = {
      buckets: new Uint32Array(this.retentionSeconds),
      lastCallAtMs: 0,
    }
    byCap.set(rec.capName, created)
    this.triples++
    return created
  }

  /**
   * Drop every triple whose whole ring has aged out — its last call is older
   * than the retention window, so it can contribute to no query. O(triples),
   * and only reachable when the ceiling is full, so it is amortised away by the
   * admissions it enables.
   */
  private reclaimExpired(nowMs: number): void {
    const cutoff = nowMs - this.retentionSeconds * 1000
    for (const [caller, byProvider] of this.map) {
      for (const [provider, byCap] of byProvider) {
        for (const [capName, window] of byCap) {
          if (window.lastCallAtMs >= cutoff) continue
          byCap.delete(capName)
          this.triples--
        }
        if (byCap.size === 0) byProvider.delete(provider)
      }
      if (byProvider.size === 0) this.map.delete(caller)
    }
  }
}

let singleton: CapUsageRegistry | null = null

/**
 * The registry for THIS process. Deliberately per-process: the reader
 * (`nodes.getCapUsageGraph` → `cap-providers.ts`) runs on hub-main, so only
 * writes made on hub-main are ever visible. See the blind-spot list on
 * `LocalChildRegistryOptions.capUsageObserver` for what that excludes.
 */
export function getCapUsageRegistry(): CapUsageRegistry {
  if (!singleton) singleton = new CapUsageRegistry()
  return singleton
}

/** Test helper — clears the singleton (kept module-private elsewhere). */
export function __resetCapUsageRegistryForTests(): void {
  singleton = null
}
