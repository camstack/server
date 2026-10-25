import { redactLogEntry } from './log-redactor.js'
import { type LogEntry, type LogFilter, type LogLevel, matchesLogTags } from './log-ring-buffer.js'
import type { LoggingGate } from './logging-gate.js'
import { getLoggingGate } from './logging-gate.singleton.js'
import { PartitionedLogBuffer, type PartitionedLogBufferOptions } from './partitioned-log-buffer.js'
import { type IScopedLogger, ScopedLogger } from './scoped-logger.js'
import type { ILogDestination } from '@camstack/types'

export type { ILogDestination }

/**
 * A short id for one process lifetime: the first half of every entry `id`.
 * Base-36 epoch ms plus a random suffix, so two boots of the same process in
 * the same millisecond still mint different ids.
 */
function newBootId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')}`
}

/**
 * The reserved destination id of the in-memory buffer. Not an addon: the
 * buffer must exist before any addon loads (boot lines) and it backs
 * `logs.query`/`subscribe`, so it lives in the kernel — but it answers to the
 * SAME orchestrator toggle as every other destination.
 */
export const LOG_BUFFER_DESTINATION_ID = 'log-buffer'

/**
 * The addon that OWNS stdout. Every other shipped destination writes somewhere
 * else (winston is file-only, loki is remote), so this is the single id whose
 * arrival means "the real console is up now".
 *
 * It exists because the console destination is a core builtin that boots after
 * the whole runner plan: a measured hub boot produced no stdout for ~40 s and
 * then flushed the backlog newest-first. {@link LogManager.attachBootstrapConsole}
 * covers that window, and this constant is how the handover is recognised.
 */
export const STDOUT_DESTINATION_ADDON_ID = 'console-logging'

export class LogManager {
  private readonly ringBuffer: PartitionedLogBuffer
  /**
   * Destinations, each tagged with the addon that provides it (when known) so
   * the fan-out can honour the operator's per-destination toggle.
   */
  private readonly destinations: Array<{ dest: ILogDestination; addonId?: string }> = []
  /**
   * "Is this destination enabled?", injected by the wiring side (which owns
   * the capability registry). Absent ⇒ everything is enabled.
   *
   * WHY: the orchestrator's Enable/Disable toggle only added the addon to
   * `disabledProviders` and NOTHING consulted it for `log-destination` — so
   * console and winston could not be turned off at all and the badge in the UI
   * lied, while Loki appeared to work only because it carried a SECOND,
   * private `enabled` setting of its own (audit 2026-07-30).
   */
  private isDestinationEnabled?: (addonId: string) => boolean
  private readonly subscribers = new Map<
    string,
    { filter: Partial<LogFilter>; callback: (entry: LogEntry) => void }
  >()
  private deviceNameLookup: ((deviceId: number) => string | null) | null = null
  /**
   * The bootstrap stdout sink, while one is attached. Detached — and its
   * replay suppressed — when {@link STDOUT_DESTINATION_ADDON_ID} registers.
   */
  private bootstrapConsole: ILogDestination | null = null

  /**
   * The node-wide level floor, mirrored from the logging settings document.
   *
   * Consulted on EVERY emitted line, so it is a boolean field read and nothing
   * else while nothing is configured — see {@link LoggingGate}. It gates the
   * DESTINATIONS only: the ring buffer keeps the line either way, because a
   * floor that also blinded the log viewer would make raising the level to
   * quieten a disk cost the operator the one window they read incidents from.
   */
  private gate: LoggingGate = getLoggingGate()

  /**
   * Entry identity (D898): `<bootId>.<seq>`, stamped once, here, on every line
   * this process accepts — so the in-memory tail, the live subscription and
   * the rotated file carry the SAME id and a page read from disk dedupes
   * exactly against the lines pushed live.
   */
  private readonly bootId = newBootId()
  private seq = 0

  /**
   * `perAddonCapacity` bounds EACH addon's bucket, not the total — a chatty addon
   * evicts only its own lines, so quiet addons keep their sparse history.
   *
   * `options.maxTotalEntries` ceilings the total across all buckets, because the
   * per-bucket bound scales with addon count, and `options.maxBuckets` ceilings the
   * bucket count itself. When the total is exceeded, entries at or below
   * `options.pruneLevel` (default `debug`) are discarded first — a live addon's
   * `warn`/`error` are never evicted to satisfy it — and only if that cannot reach
   * the target are whole least-recently-written buckets dropped. Both bounds are ON
   * by default; pass an explicit `null` to opt out. See {@link PartitionedLogBuffer}.
   */
  constructor(perAddonCapacity: number = 5000, options: PartitionedLogBufferOptions = {}) {
    this.ringBuffer = new PartitionedLogBuffer(perAddonCapacity, options)
  }

  /** Entries currently retained across every bucket. */
  bufferSize(): number {
    return this.ringBuffer.size()
  }

  /**
   * Register a callback that resolves `deviceId → deviceName`. Called
   * for every emitted entry that carries `tags.deviceId` but no
   * explicit `tags.deviceName` — the LogManager injects the resolved
   * name directly into the entry's tags BEFORE ring-buffer / destination
   * write, so every destination (local console, file, remote forwarder,
   * addon-bundled copies of core) sees the enriched shape regardless of
   * which module instance the destination was built from.
   */
  setDeviceNameLookup(lookup: ((deviceId: number) => string | null) | null): void {
    this.deviceNameLookup = lookup
  }

  createLogger(scope?: string): IScopedLogger {
    return new ScopedLogger(scope, (entry: LogEntry) => {
      // The central redactor (D787 §8) runs before ANY sink: ring buffer,
      // destinations (file, Loki) and live subscribers all see the same line.
      const enriched: LogEntry = {
        ...redactLogEntry(this.enrichDeviceName(entry)),
        id: `${this.bootId}.${String(++this.seq)}`,
      }
      // The in-memory buffer is a DESTINATION like any other for enablement
      // purposes — the operator can turn it off (it is RAM, and its "off" is a
      // legitimate choice) — but it lives in the kernel rather than in an
      // addon because it must exist from the first boot line, before any addon
      // has loaded, and because it is also the READ path for
      // `logs.query/subscribe`. Turning it off therefore also empties the log
      // viewer, which is exactly what the operator is asking for.
      if (this.isDestinationEnabled?.(LOG_BUFFER_DESTINATION_ID) !== false) {
        this.ringBuffer.push(enriched)
      }
      // The node-wide floor. First statement inside the gate is a boolean
      // field, so an unconfigured hub pays one read per line.
      if (this.gate.allowsDestination(enriched)) {
        for (const entry of this.destinations) {
          if (entry.addonId !== undefined && this.isDestinationEnabled?.(entry.addonId) === false) {
            continue
          }
          entry.dest.write(enriched)
        }
      }
      // Notify real-time subscribers
      for (const [, sub] of this.subscribers) {
        if (this.matchesFilter(enriched, sub.filter)) {
          try {
            sub.callback(enriched)
          } catch {
            /* subscriber error — ignore */
          }
        }
      }
    })
  }

  private enrichDeviceName(entry: LogEntry): LogEntry {
    if (!this.deviceNameLookup) return entry
    const tags = entry.tags
    if (!tags) return entry
    const deviceId = (tags as { deviceId?: unknown }).deviceId
    if (typeof deviceId !== 'number' || !Number.isFinite(deviceId)) return entry
    if (typeof (tags as { deviceName?: unknown }).deviceName === 'string') return entry
    const name = this.deviceNameLookup(deviceId)
    if (!name) return entry
    return { ...entry, tags: { ...tags, deviceName: name } }
  }

  /** Subscribe to live logs matching a filter. Returns an unsubscribe function. */
  subscribe(filter: Partial<LogFilter>, callback: (entry: LogEntry) => void): () => void {
    const id = Math.random().toString(36).slice(2)
    this.subscribers.set(id, { filter, callback })
    return () => {
      this.subscribers.delete(id)
    }
  }

  private matchesFilter(entry: LogEntry, filter: Partial<LogFilter>): boolean {
    if (filter.level) {
      const levels: string[] = ['debug', 'info', 'warn', 'error']
      const minIdx = levels.indexOf(filter.level)
      const entryIdx = levels.indexOf(entry.level)
      if (entryIdx < minIdx) return false
    }
    if (filter.tags) {
      if (!matchesLogTags(entry.tags, filter.tags)) return false
    }
    return true
  }

  /**
   * Register a log destination.
   *
   * @param opts.replay  If true (default), replay every entry currently in
   *                     the ring buffer to the new destination before live
   *                     traffic starts. Lets a destination added mid-boot
   *                     still receive boot-time log entries.
   */
  /** Apply new in-memory buffer limits at runtime (see PartitionedLogBuffer). */
  reconfigureBuffer(options: {
    readonly perAddonCapacity?: number
    readonly maxTotalEntries?: number | null
    readonly pruneLevel?: LogLevel
  }): void {
    this.ringBuffer.reconfigure(options)
  }

  /**
   * Swap the node-wide level gate. Production uses the process singleton;
   * a spec passes its own so two suites cannot arm each other's floor.
   */
  setLoggingGate(gate: LoggingGate): void {
    this.gate = gate
  }

  /** Set the per-destination enablement check (see {@link isDestinationEnabled}). */
  setDestinationEnabledCheck(check: ((addonId: string) => boolean) | null): void {
    this.isDestinationEnabled = check ?? undefined
  }

  /**
   * Attach a minimal console sink that carries the boot log until the real
   * `console-logging` builtin registers — see {@link STDOUT_DESTINATION_ADDON_ID}.
   *
   * Registered WITHOUT an `addonId` on purpose: the per-destination toggle
   * could otherwise hide the one window an operator cannot read any other way
   * (a hub that dies before pass 3 would emit nothing at all). It is detached
   * the moment the stdout owner arrives, so stdout never carries two copies.
   *
   * Idempotent: a second call while one is attached is a no-op.
   */
  attachBootstrapConsole(dest: ILogDestination): void {
    if (this.bootstrapConsole !== null) return
    this.bootstrapConsole = dest
    this.destinations.push({ dest })
  }

  addDestination(dest: ILogDestination, opts: { replay?: boolean; addonId?: string } = {}): void {
    // The stdout owner SUPERSEDES the bootstrap console: the operator has
    // already read every buffered line on stdout, in order, so replaying the
    // backlog into it would print the whole boot a second time.
    const supersedesBootstrap =
      this.bootstrapConsole !== null && opts.addonId === STDOUT_DESTINATION_ADDON_ID
    if (supersedesBootstrap && this.bootstrapConsole !== null) {
      this.removeDestination(this.bootstrapConsole)
      this.bootstrapConsole = null
    }
    const replay = opts.replay ?? !supersedesBootstrap
    this.destinations.push(opts.addonId === undefined ? { dest } : { dest, addonId: opts.addonId })
    if (replay) {
      // OLDEST-FIRST. `PartitionedLogBuffer.query` sorts descending because the
      // log VIEWER wants newest-first; a destination is a stream and must
      // receive events in the order they happened, or the file/console copy of
      // every boot reads backwards (docs/design/boot-to-usable-camera.md).
      for (const entry of [...this.ringBuffer.query({})].reverse()) {
        try {
          dest.write(entry)
        } catch {
          /* destination replay error — ignore */
        }
      }
    }
  }

  removeDestination(dest: ILogDestination): void {
    const index = this.destinations.findIndex((d) => d.dest === dest)
    if (index !== -1) {
      this.destinations.splice(index, 1)
    }
  }

  query(filter: LogFilter): LogEntry[] {
    return this.ringBuffer.query(filter)
  }

  /**
   * Drop ring-buffer entries matching `filter`. Returns the count
   * removed. Backs the UI's "Clear logs" admin action so an operator
   * can wipe the historical window for a scope (per-device, per-addon,
   * agent-level) without restarting the server. External destinations
   * (file, forwarder) are NOT touched — only the in-memory ring.
   */
  clear(filter: LogFilter = {}): number {
    return this.ringBuffer.clear(filter)
  }
}
