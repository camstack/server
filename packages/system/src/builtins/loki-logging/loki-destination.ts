/**
 * Grafana Loki log destination — batches entries and pushes them to Loki's
 * `POST /loki/api/v1/push`. Payload construction and the label policy live in the
 * pure `loki-payload.ts`; this file owns the batching, the transport and the
 * failure behaviour.
 *
 * ## It must never log
 *
 * This is the constraint that shapes everything else. A `log-destination` that
 * emits a log line feeds itself: one entry → a push → the push logs something →
 * another entry → another push. The `hub-forwarder` builtin carries the same
 * warning in its manifest for the same reason.
 *
 * So this class NEVER calls `ctx.logger`, and it does not throw out of `write()`
 * either — `LogManager` fans one entry to every destination, so throwing here
 * would break the other sinks. Errors are counted and exposed through
 * `getStatus()` for the Admin UI to render. Diagnosing a broken Loki
 * configuration is a UI affordance, deliberately, because it cannot be a log line.
 *
 * ## Backpressure
 *
 * If Loki is down, entries accumulate. A logger that OOMs the process it is
 * observing is worse than a logger that loses lines, so the queue is bounded at
 * `MAX_QUEUE` and drops OLDEST-first when full (a burst during an incident is
 * exactly when the newest lines matter most). Drops are counted and surfaced.
 */
import type {
  ILogDestination,
  LogEntry,
  LogLevel,
  LogReadCapabilities,
  LogReadQuery,
  LogReadResult,
} from '@camstack/types'
import { buildPushBody, parseExtraLabels, type LokiPushBody } from './loki-payload.js'
import { parseQueryRange, readLokiBackward, type LokiRangeQuery } from './loki-read.js'

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Bounded so an unreachable Loki cannot grow the heap without limit. 10k entries
 * of a few hundred bytes is a handful of MB — enough to ride out a restart of the
 * Loki container, not enough to matter if it never comes back.
 */
const MAX_QUEUE = 10_000

export interface LokiConfig {
  readonly enabled: boolean
  /** Base URL of the Loki instance, e.g. `http://loki:3100`. */
  readonly url: string
  readonly job: string
  readonly node: string
  readonly level: LogLevel
  /** Flush period in ms. */
  readonly batchIntervalMs: number
  /** Flush early once this many entries are queued. */
  readonly batchSize: number
  /** `key=value,key2=value2` static labels. Must stay low-cardinality. */
  readonly extraLabels: string
  /** Grafana Cloud / multi-tenant Loki: sent as `X-Scope-OrgID`. */
  readonly tenantId: string
  /** Optional HTTP basic auth. */
  readonly username: string
  readonly password: string
  readonly timeoutMs: number
}

export interface LokiStatus {
  readonly enabled: boolean
  readonly configured: boolean
  readonly queued: number
  readonly pushed: number
  readonly dropped: number
  readonly failures: number
  readonly lastError: string | null
  readonly lastPushAtMs: number | null
}

/** Injected in tests. Matches the shape of global `fetch` that is actually used. */
export type LokiFetch = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Readonly<Record<string, string>>
    /** Absent on a GET (the history read). */
    readonly body?: string
    readonly signal?: AbortSignal
  },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>

export interface LokiDestinationDeps {
  readonly fetchFn?: LokiFetch
  readonly setIntervalFn?: typeof setInterval
  readonly clearIntervalFn?: typeof clearInterval
}

export class LokiDestination implements ILogDestination {
  private config: LokiConfig | null = null
  private queue: LogEntry[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private flushing = false
  private pushed = 0
  private dropped = 0
  private failures = 0
  private lastError: string | null = null
  private lastPushAtMs: number | null = null
  /** In-flight history reads, by requestId, so `cancelRead` can abort the fetch. */
  private readonly reads = new Map<string, AbortController>()

  private readonly fetchFn: LokiFetch
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval

  constructor(deps?: LokiDestinationDeps) {
    // `globalThis.fetch` is read lazily through this wrapper rather than captured,
    // so a test that installs a fetch after construction still sees it.
    this.fetchFn =
      deps?.fetchFn ??
      ((url, init) =>
        globalThis.fetch(url, {
          method: init.method,
          headers: { ...init.headers },
          ...(init.body !== undefined ? { body: init.body } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        }))
    this.setIntervalFn = deps?.setIntervalFn ?? setInterval
    this.clearIntervalFn = deps?.clearIntervalFn ?? clearInterval
  }

  async initialize(config?: LokiConfig): Promise<void> {
    this.config = config ?? null
    this.startTimerIfActive()
  }

  /**
   * Re-apply configuration to an already-initialized destination after a
   * settings change, without dropping the queued tail. Stops the current flush
   * timer, swaps the config in, and starts a fresh timer only when the new
   * config is active. This is what makes the addon's "enable without a restart"
   * contract real: `initialize()` starts a timer, so calling it twice would leak
   * the first one — `reconfigure()` clears it first.
   */
  async reconfigure(config: LokiConfig): Promise<void> {
    this.stopTimer()
    this.config = config
    this.startTimerIfActive()
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer)
      this.timer = undefined
    }
  }

  private startTimerIfActive(): void {
    if (!this.isActive() || this.config === null) return
    this.timer = this.setIntervalFn(
      () => {
        void this.flush()
      },
      Math.max(250, this.config.batchIntervalMs),
    )
    // `unref` so a pending flush timer never holds the process open on shutdown.
    // Guarded: the return type is platform-dependent and a fake timer has no unref.
    const timer: unknown = this.timer
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  }

  /** Enabled AND pointed somewhere. An enabled destination with no URL is inert. */
  private isActive(): boolean {
    return this.config !== null && this.config.enabled && this.config.url.trim().length > 0
  }

  write(entry: LogEntry): void {
    if (!this.isActive() || this.config === null) return
    if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.config.level]) return

    this.queue.push(entry)
    if (this.queue.length > MAX_QUEUE) {
      // Drop oldest: during an incident the newest lines are the ones being read.
      const overflow = this.queue.length - MAX_QUEUE
      this.queue.splice(0, overflow)
      this.dropped += overflow
    }
    if (this.queue.length >= this.config.batchSize) void this.flush()
  }

  /**
   * Push whatever is queued. Never throws and never logs.
   *
   * On failure the batch is put BACK at the front of the queue so a transient
   * Loki outage does not lose lines; `MAX_QUEUE` is what stops that from growing
   * without bound.
   */
  async flush(): Promise<void> {
    if (this.flushing || !this.isActive() || this.config === null) return
    if (this.queue.length === 0) return

    this.flushing = true
    const batch = this.queue
    this.queue = []
    try {
      const body = buildPushBody(batch, {
        job: this.config.job,
        node: this.config.node,
        extra: parseExtraLabels(this.config.extraLabels),
      })
      if (body !== null) {
        await this.push(body, this.config)
        this.pushed += batch.length
        this.lastPushAtMs = Date.now()
        this.lastError = null
      }
    } catch (error) {
      this.failures += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      // Re-queue at the FRONT to preserve order, then re-apply the bound.
      this.queue = [...batch, ...this.queue]
      if (this.queue.length > MAX_QUEUE) {
        const overflow = this.queue.length - MAX_QUEUE
        this.queue.splice(0, overflow)
        this.dropped += overflow
      }
    } finally {
      this.flushing = false
    }
  }

  private async push(body: LokiPushBody, config: LokiConfig): Promise<void> {
    const endpoint = `${config.url.replace(/\/+$/, '')}/loki/api/v1/push`
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.authHeaders(config),
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1_000, config.timeoutMs))
    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        // Loki puts the actual reason in the body — a bad label name, a stream
        // limit, an out-of-order entry. Without it the status alone is useless.
        const detail = await response.text().catch(() => '')
        throw new Error(
          `Loki push failed: ${String(response.status)}${detail.length > 0 ? ` — ${detail.slice(0, 200)}` : ''}`,
        )
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  getStatus(): LokiStatus {
    return {
      enabled: this.config?.enabled === true,
      configured: this.isActive(),
      queued: this.queue.length,
      pushed: this.pushed,
      dropped: this.dropped,
      failures: this.failures,
      lastError: this.lastError,
      lastPushAtMs: this.lastPushAtMs,
    }
  }

  /**
   * One-shot reachability probe for the Admin UI's "Test connection" button.
   * Pushes a single synthetic entry, which validates the URL, the auth, the
   * tenant header AND the label policy in one go — a bare GET would validate
   * none of them.
   */
  async testConnection(config: LokiConfig): Promise<{ ok: boolean; error: string | null }> {
    if (config.url.trim().length === 0) return { ok: false, error: 'No Loki URL configured' }
    const probe: LogEntry = {
      timestamp: new Date(),
      level: 'info',
      scope: 'loki-logging',
      message: 'CamStack connection test',
    }
    const body = buildPushBody([probe], {
      job: config.job,
      node: config.node,
      extra: parseExtraLabels(config.extraLabels),
    })
    if (body === null) return { ok: false, error: 'Nothing to send' }
    try {
      await this.push(body, config)
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Headers every call to this Loki carries: tenant + basic auth. */
  private authHeaders(config: LokiConfig): Record<string, string> {
    const headers: Record<string, string> = {}
    if (config.tenantId.trim().length > 0) headers['X-Scope-OrgID'] = config.tenantId.trim()
    if (config.username.length > 0) {
      const token = Buffer.from(`${config.username}:${config.password}`).toString('base64')
      headers['authorization'] = `Basic ${token}`
    }
    return headers
  }

  /**
   * Readable when it is configured (D898): the same URL and credentials the
   * push uses answer `query_range`. Labels are `job`/`node`/`level`, so those
   * filter at the index; device, addon and text are line filters.
   */
  async describeRead(): Promise<LogReadCapabilities> {
    const configured = this.isActive()
    return {
      readable: configured,
      reason: configured ? null : 'Loki is not enabled or has no URL',
      filters: {
        deviceId: true,
        addonId: true,
        nodeId: true,
        tags: true,
        level: true,
        text: true,
        timeRange: true,
      },
      retentionDays: null,
    }
  }

  /** One backward slice from `query_range`, newest first. Never logs. */
  async read(query: LogReadQuery): Promise<LogReadResult> {
    const config = this.config
    if (config === null || !this.isActive()) throw new Error('Loki is not enabled or has no URL')
    const controller = new AbortController()
    const requestId = query.requestId
    if (requestId !== undefined) this.reads.set(requestId, controller)
    const base = config.url.replace(/\/+$/, '')
    const range: LokiRangeQuery = async ({ logql, startNs, endNs, limit }) => {
      const params = new URLSearchParams({
        query: logql,
        start: String(startNs),
        end: String(endNs),
        limit: String(limit),
        direction: 'backward',
      })
      const timeout = setTimeout(() => controller.abort(), Math.max(1_000, config.timeoutMs))
      try {
        const response = await this.fetchFn(
          `${base}/loki/api/v1/query_range?${params.toString()}`,
          {
            method: 'GET',
            headers: this.authHeaders(config),
            signal: controller.signal,
          },
        )
        const text = await response.text()
        if (!response.ok) {
          throw new Error(
            `Loki query failed: ${String(response.status)}${text.length > 0 ? ` — ${text.slice(0, 200)}` : ''}`,
          )
        }
        return { rows: parseQueryRange(JSON.parse(text)), bytes: Buffer.byteLength(text) }
      } finally {
        clearTimeout(timeout)
      }
    }
    try {
      return await readLokiBackward({
        query,
        labels: { job: config.job },
        range,
        isCancelled: () => controller.signal.aborted,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          entries: [],
          nextBefore: query.before ?? null,
          nextAfter: null,
          scannedBytes: 0,
          done: false,
          cancelled: true,
        }
      }
      throw error
    } finally {
      if (requestId !== undefined) this.reads.delete(requestId)
    }
  }

  async cancelRead(input: {
    readonly requestId: string
  }): Promise<{ readonly cancelled: boolean }> {
    const controller = this.reads.get(input.requestId)
    controller?.abort()
    return { cancelled: controller !== undefined }
  }

  async shutdown(): Promise<void> {
    this.stopTimer()
    // Last flush so the tail of the log survives a graceful restart.
    await this.flush()
    this.config = null
  }
}
