/**
 * Ships the transitions the hub's correlator produced to device-history (D1022).
 * A bounded in-memory queue and a single in-flight flush: telemetry may be
 * dropped (D8), so past the bound the OLDEST rows go, loudly, and a failed
 * flush keeps its batch for the next tick.
 */
import { DEVICE_TRANSITIONS_RECORD_BATCH_MAX, type DeviceTransition } from '@camstack/types'

export const TRANSITIONS_QUEUE_MAX = 10_000
const DROP_LOG_DEVICES_MAX = 10

export interface TransitionSenderLogger {
  error(message: string, meta?: { tags?: { deviceId: number } }): void
}

export interface TransitionSenderDeps {
  readonly send: (batch: readonly DeviceTransition[]) => Promise<void>
  readonly logger: TransitionSenderLogger
  readonly maxQueued?: number
}

export class TransitionSender {
  private queue: DeviceTransition[] = []
  private flushing = false
  private failing = false
  private readonly max: number

  constructor(private readonly deps: TransitionSenderDeps) {
    this.max = deps.maxQueued ?? TRANSITIONS_QUEUE_MAX
  }

  queued(): number {
    return this.queue.length
  }

  /**
   * Give up on what is still queued (shutdown): say how much, and for which devices, then clear.
   * Rows are telemetry (D8), but a hole in the audit is never silent.
   */
  abandon(): void {
    if (this.queue.length === 0) return
    const dropped = this.queue.splice(0)
    this.reportDropped(dropped, 'abandoned at shutdown')
  }

  enqueue(row: DeviceTransition): void {
    this.queue.push(row)
    const over = this.queue.length - this.max
    if (over <= 0) return
    this.reportDropped(this.queue.splice(0, over), `queue over ${this.max}, oldest dropped`)
  }

  private reportDropped(dropped: readonly DeviceTransition[], why: string): void {
    const devices = [...new Set(dropped.map((t) => t.deviceId))]
    this.deps.logger.error(
      `device-transitions ${why}: ${dropped.length} transition(s) across ${devices.length} device(s) lost`,
    )
    for (const deviceId of devices.slice(0, DROP_LOG_DEVICES_MAX)) {
      this.deps.logger.error('device-transitions dropped transitions for this device', {
        tags: { deviceId },
      })
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, DEVICE_TRANSITIONS_RECORD_BATCH_MAX)
        try {
          await this.deps.send(batch)
        } catch (err) {
          // One line per failure streak, not per 2 s tick; the batch stays queued.
          if (!this.failing) {
            this.failing = true
            this.deps.logger.error(
              `device-transitions flush failed, ${this.queue.length} queued: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          return
        }
        this.failing = false
        this.queue.splice(0, batch.length)
      }
    } finally {
      this.flushing = false
    }
  }
}
