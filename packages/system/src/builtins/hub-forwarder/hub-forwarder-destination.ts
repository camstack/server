import type { IClusterBroker, ILogDestination, IScopedLogger, LogEntry } from '@camstack/types'
import { formatLogLine } from '../../logging/formatter.js'

const DEFAULT_OUTBOUND_BUFFER_SIZE = 500

/**
 * Log destination for agent mode.
 *
 * - Writes to console ONLY when hub is not yet reachable (cold-start
 *   fallback). Forked-worker agents share stdout with their parent
 *   hub, so logging to local console AND forwarding to hub's
 *   `log-receiver` would print the entry twice on the hub terminal.
 *   Once the hub is discovered, local console output stops and the
 *   hub's own ConsoleDestination owns the render.
 * - When a Moleculer broker is connected and the hub node is reachable,
 *   forwards every log entry to the hub via `log-receiver.ingest`.
 * - Entries written before the hub is reachable are buffered internally
 *   (ring-buffered to `DEFAULT_OUTBOUND_BUFFER_SIZE`) and flushed on connect,
 *   so boot-time logs still reach the hub without any external replay trigger.
 */
export class HubForwarderDestination implements ILogDestination {
  private broker: IClusterBroker | null = null
  private hubConnected = false
  private readonly outboundBuffer: LogEntry[] = []
  private statusLogger: IScopedLogger | null = null

  async initialize(): Promise<void> {
    // Console destination is always active — no setup needed.
  }

  /**
   * Provide a logger for the destination's own status messages
   * (discovery, disconnect, reconnect). Routed through the agent's
   * LogManager but never through this same destination — the owning
   * addon must hand in a logger that does NOT route back here, or
   * status writes will recurse.
   */
  setStatusLogger(logger: IScopedLogger): void {
    this.statusLogger = logger
  }

  private status(level: 'info' | 'warn', msg: string): void {
    if (this.statusLogger) {
      if (level === 'warn') this.statusLogger.warn(msg)
      else this.statusLogger.info(msg)
      return
    }
    // Cold-start fallback: status logger not yet wired.
    if (level === 'warn') console.warn(`[hub-forwarder] ${msg}`)
    else console.log(`[hub-forwarder] ${msg}`)
  }

  /**
   * Attach the Moleculer broker so hub forwarding can start.
   * Called by the owning addon from `onInitialize(ctx)` with
   * `ctx.kernel.cluster?.broker`.
   */
  connectBroker(broker: IClusterBroker): void {
    this.broker = broker

    // Wait for `log-receiver` service (no timeout — waits until available).
    // The service is registered on the hub after app.init(), so it may
    // appear after node discovery. This is fully event-driven.
    broker
      .waitForServices('log-receiver')
      .then(() => {
        this.hubConnected = true
        this.status('info', 'log-receiver discovered — log forwarding active')
        this.flushOutbound()
      })
      .catch(() => {
        /* broker stopped before discovery */
      })

    broker.localBus.on('$node.disconnected', ({ node }) => {
      if (node.id === 'hub') {
        this.hubConnected = false
        this.status('info', 'Hub disconnected — log forwarding paused')
        // Re-wait for reconnect
        broker
          .waitForServices('log-receiver')
          .then(() => {
            this.hubConnected = true
            this.status('info', 'Hub reconnected — log forwarding resumed')
            this.flushOutbound()
          })
          .catch(() => {
            /* broker stopped */
          })
      }
    })
  }

  write(entry: LogEntry): void {
    // 1. Forward to hub when connected, otherwise buffer for flush-on-connect.
    if (this.hubConnected && this.broker) {
      this.forward(entry)
      return
    }
    this.bufferOutbound(entry)

    // 2. Local console output ONLY as a cold-start fallback. Forked-worker
    //    stdout is already piped to the hub's terminal; once the hub
    //    ingests our forwarded entry it renders it there. Printing
    //    locally would show the same line twice.
    const line = formatLogLine(entry, { colorize: true })
    if (entry.level === 'error') console.error(line)
    else if (entry.level === 'warn') console.warn(line)
    else console.log(line)
  }

  async shutdown(): Promise<void> {
    this.hubConnected = false
    this.broker = null
    this.outboundBuffer.length = 0
  }

  private bufferOutbound(entry: LogEntry): void {
    this.outboundBuffer.push(entry)
    // Ring-buffer: drop oldest entries once we're past the cap so the
    // outbound buffer never grows without bound.
    if (this.outboundBuffer.length > DEFAULT_OUTBOUND_BUFFER_SIZE) {
      this.outboundBuffer.splice(0, this.outboundBuffer.length - DEFAULT_OUTBOUND_BUFFER_SIZE)
    }
  }

  private flushOutbound(): void {
    if (!this.broker || !this.hubConnected) return
    const pending = this.outboundBuffer.splice(0, this.outboundBuffer.length)
    for (const entry of pending) {
      this.forward(entry)
    }
  }

  private forward(entry: LogEntry): void {
    if (!this.broker) return
    this.broker
      .call('log-receiver.ingest', {
        level: entry.level,
        message: entry.message,
        addonId: entry.tags?.addonId ?? 'agent',
        nodeId: entry.tags?.nodeId ?? this.broker.nodeID,
        ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
        ...(entry.tags ? { tags: entry.tags } : {}),
        ...(entry.meta ? { meta: entry.meta } : {}),
      })
      .catch(() => {
        // Hub unreachable — silently drop. Will resume on reconnect.
      })
  }
}
