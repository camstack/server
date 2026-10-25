/**
 * Per-broker live probe cache (#164).
 *
 * Every 30s we open a transient `mqtt.connect` against each external
 * broker entry, classify the outcome, and store it in an in-memory
 * `Map<id, ProbeResult>`. `listBrokers` reads from this map instead of
 * returning static "disconnected" stubs.
 *
 * Why in-memory rather than `runtimeState`: the runtime-state slice
 * machinery is device-scoped; this is a system-scoped cap. Probe
 * results are fast to rebuild on restart (one 3s timeout per broker)
 * so we don't bother persisting them.
 */
import mqtt from 'mqtt'
import type { MqttBrokerLiveStatus } from '@camstack/types'

type BrokerStatus = MqttBrokerLiveStatus

export interface BrokerProbeInput {
  readonly id: string
  readonly url: string
  readonly username?: string
  readonly password?: string
}

export interface ProbeResult {
  readonly status: BrokerStatus
  readonly latencyMs: number | null
  readonly error?: string
  readonly lastCheckedAt: number
}

interface ProbeCacheConfig {
  readonly intervalMs?: number
  readonly connectTimeoutMs?: number
  readonly onError?: (id: string, error: unknown) => void
}

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000

export class BrokerProbeCache {
  private readonly cache: Map<string, ProbeResult> = new Map()
  private readonly intervalMs: number
  private readonly connectTimeoutMs: number
  private readonly onError: ((id: string, error: unknown) => void) | undefined
  private getBrokers: () => readonly BrokerProbeInput[] = () => []
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  private stopped: boolean = false

  constructor(cfg: ProbeCacheConfig = {}) {
    this.intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL_MS
    this.connectTimeoutMs = cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.onError = cfg.onError
  }

  /** Wire the source of brokers to probe. Re-evaluated every tick. */
  setBrokersSource(source: () => readonly BrokerProbeInput[]): void {
    this.getBrokers = source
  }

  /** Snapshot the cached entry for `id`, or undefined when no probe has run yet. */
  get(id: string): ProbeResult | undefined {
    return this.cache.get(id)
  }

  /** Drop a cached entry (call when a broker is removed). */
  evict(id: string): void {
    this.cache.delete(id)
  }

  start(): void {
    if (this.timer !== null) return
    this.stopped = false
    // Fire once immediately so the first listBrokers after boot has real
    // data, then run on the configured interval.
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.inflight) {
      await this.inflight.catch(() => undefined)
    }
  }

  /** Force a refresh (used by `testConnection` and the page's Refresh button). */
  async probeNow(id: string): Promise<ProbeResult | undefined> {
    const broker = this.getBrokers().find((b) => b.id === id)
    if (!broker) return undefined
    const result = await this.probeOne(broker)
    this.cache.set(broker.id, result)
    return result
  }

  private async tick(): Promise<void> {
    if (this.inflight) return
    this.inflight = (async () => {
      try {
        const brokers = this.getBrokers()
        // Drop stale entries
        const liveIds = new Set(brokers.map((b) => b.id))
        for (const cachedId of Array.from(this.cache.keys())) {
          if (!liveIds.has(cachedId)) this.cache.delete(cachedId)
        }
        await Promise.all(
          brokers.map(async (broker) => {
            if (this.stopped) return
            try {
              const result = await this.probeOne(broker)
              if (this.stopped) return
              this.cache.set(broker.id, result)
            } catch (err) {
              this.onError?.(broker.id, err)
            }
          }),
        )
      } finally {
        this.inflight = null
      }
    })()
    await this.inflight
  }

  private probeOne(broker: BrokerProbeInput): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      const startedAt = Date.now()
      const opts: mqtt.IClientOptions = {
        reconnectPeriod: 0,
        connectTimeout: this.connectTimeoutMs,
        // Disable session resumption — every probe is a fresh check.
        clean: true,
      }
      if (broker.username) opts.username = broker.username
      if (broker.password) opts.password = broker.password

      let settled = false
      let client: mqtt.MqttClient | null = null
      const finalize = (result: ProbeResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (client) {
          try {
            client.end(true)
          } catch {
            /* ignore */
          }
        }
        resolve({ ...result, lastCheckedAt: Date.now() })
      }

      const timer = setTimeout(() => {
        finalize({
          status: 'unreachable',
          latencyMs: null,
          error: `connect timeout (${this.connectTimeoutMs}ms)`,
          lastCheckedAt: 0,
        })
      }, this.connectTimeoutMs + 250)

      try {
        client = mqtt.connect(broker.url, opts)
      } catch (err) {
        finalize({
          status: classifyError(err),
          latencyMs: null,
          error: errMsg(err),
          lastCheckedAt: 0,
        })
        return
      }

      client.once('connect', () => {
        finalize({
          status: 'connected',
          latencyMs: Date.now() - startedAt,
          lastCheckedAt: 0,
        })
      })
      client.once('error', (err) => {
        finalize({
          status: classifyError(err),
          latencyMs: null,
          error: errMsg(err),
          lastCheckedAt: 0,
        })
      })
    })
  }
}

/**
 * Map an mqtt.js error to one of the BrokerStatus variants.
 *
 * Heuristics (mqtt.js doesn't surface a typed error code we can switch
 * on cleanly):
 *   - `Connection refused: Bad username or password` / `Not authorized`
 *     → `auth-failed`
 *   - TLS handshake / cert errors → `tls-error`
 *   - everything else (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, …) →
 *     `unreachable`
 */
export function classifyError(err: unknown): BrokerStatus {
  const message = errMsg(err).toLowerCase()
  if (
    message.includes('bad user name') ||
    message.includes('bad username') ||
    message.includes('not authorized') ||
    message.includes('authentication failed') ||
    message.includes('unauthorized')
  ) {
    return 'auth-failed'
  }
  if (
    message.includes('certificate') ||
    message.includes('tls') ||
    message.includes('ssl') ||
    message.includes('handshake') ||
    message.includes('alert') ||
    message.includes('self signed') ||
    message.includes('self-signed') ||
    message.includes('unable to verify')
  ) {
    return 'tls-error'
  }
  return 'unreachable'
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
