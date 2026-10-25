/**
 * Periodic state reconcile (D869).
 *
 * `DeviceStateChanged` is telemetry and may be dropped (D8, D11): a blind that
 * stopped at 40 % while the event was lost would stay at "moving" in the Alexa
 * app until someone changed it again. Every `RECONCILE_INTERVAL_MS` this reads
 * the slice of every cap behind every exposed generic endpoint and hands it to
 * `StateChangeReporter.reconcile`, which pushes a ChangeReport only where the
 * value differs from the last one REPORTED.
 *
 * A read that fails, or an absent cap, changes nothing (D49): it is not a
 * state, so it is never compared and never pushed.
 */
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { z } from 'zod'
import { GENERIC_STATE_CAPS } from '../endpoints/adapters/index.js'
import { parseCameraEndpointId } from '../handlers/endpoint-id.js'
import type { StateChange } from './state-change-reporter.js'

export const RECONCILE_INTERVAL_MS = 15 * 60_000

const SliceSchema = z.record(z.string(), z.unknown())

export interface StateReconcilerDeps {
  readonly reporter: { readonly reconcile: (change: StateChange) => Promise<number> }
  readonly getExportedEndpoints: () => Readonly<Record<number, readonly string[]>>
  /** One cap slice of a device; rejects (or answers null) when it cannot be read. */
  readonly readSlice: (deviceId: number, capName: string) => Promise<unknown>
  readonly logger: IScopedLogger
  readonly intervalMs?: number
}

export interface ReconcileSummary {
  readonly devices: number
  readonly reads: number
  readonly failedReads: number
  readonly pushed: number
}

export class StateReconciler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly deps: StateReconcilerDeps) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.deps.intervalMs ?? RECONCILE_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** The devices behind the exported generic endpoints. */
  private genericDeviceIds(): readonly number[] {
    const ids = new Set<number>()
    for (const endpointIds of Object.values(this.deps.getExportedEndpoints())) {
      for (const endpointId of endpointIds) {
        const parsed = parseCameraEndpointId(endpointId)
        if (parsed.kind === 'generic') ids.add(parsed.deviceId)
      }
    }
    return [...ids]
  }

  async runOnce(): Promise<ReconcileSummary> {
    if (this.running) return { devices: 0, reads: 0, failedReads: 0, pushed: 0 }
    this.running = true
    let reads = 0
    let failedReads = 0
    let pushed = 0
    const deviceIds = this.genericDeviceIds()
    try {
      for (const deviceId of deviceIds) {
        for (const capName of GENERIC_STATE_CAPS) {
          reads += 1
          const slice = await this.readOne(deviceId, capName)
          if (slice === null) {
            failedReads += 1
            continue
          }
          pushed += await this.deps.reporter.reconcile({ deviceId, capName, slice })
        }
      }
    } catch (err) {
      this.deps.logger.warn('alexa state reconcile: a pass failed', {
        meta: { error: errMsg(err) },
      })
    } finally {
      this.running = false
    }
    const summary: ReconcileSummary = { devices: deviceIds.length, reads, failedReads, pushed }
    if (pushed > 0) {
      this.deps.logger.info('alexa state reconcile: corrected drifted state', {
        meta: { ...summary },
      })
    } else {
      this.deps.logger.debug('alexa state reconcile: nothing drifted', { meta: { ...summary } })
    }
    return summary
  }

  private async readOne(
    deviceId: number,
    capName: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const parsed = SliceSchema.safeParse(await this.deps.readSlice(deviceId, capName))
      return parsed.success ? parsed.data : null
    } catch {
      // A cap the device does not have, or a read that failed: no state to compare.
      return null
    }
  }
}
