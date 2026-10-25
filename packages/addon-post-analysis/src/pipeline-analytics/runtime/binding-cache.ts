/**
 * BindingCache — in-memory cache of `pipeline-analytics` wrapper binding
 * state per device. Populated lazily on first lookup via
 * `device-manager.getBindings`, invalidated by `DeviceBindingsChanged`
 * events for the same cap.
 *
 * Read path is frame-rate hot (`PipelineInferenceResult` fires ~10fps
 * per camera). Avoiding a tRPC round-trip for every frame matters.
 * Cache is event-driven (no TTL), so the source of truth stays
 * device-manager.
 */

import type { AddonApi, IScopedLogger } from '@camstack/types'

export interface BindingCacheDeps {
  readonly api: AddonApi
  readonly logger: IScopedLogger
  readonly capName?: string
}

export class BindingCache {
  private readonly api: AddonApi
  private readonly logger: IScopedLogger
  private readonly capName: string
  private readonly state = new Map<number, boolean>()
  private readonly inflight = new Map<number, Promise<boolean>>()

  constructor(deps: BindingCacheDeps) {
    this.api = deps.api
    this.logger = deps.logger
    this.capName = deps.capName ?? 'pipeline-analytics'
  }

  async isActive(deviceId: number): Promise<boolean> {
    const cached = this.state.get(deviceId)
    if (cached !== undefined) return cached
    const pending = this.inflight.get(deviceId)
    if (pending) return pending
    const promise = (async () => {
      try {
        const res = await this.api.deviceManager.getBindings.query({ deviceId })
        const active = res.entries.some((e) => e.capName === this.capName)
        this.state.set(deviceId, active)
        return active
      } catch (err) {
        // WARN, not debug (2026-07-23): a failing getBindings makes every
        // frame of the device drop silently at the intake gate — during the
        // 15-minute all-camera analytics blackout this was the only candidate
        // signal and it sat below the Winston file level. Uncached, so a
        // sustained failure re-fires per lookup; keep it visible.
        this.logger.warn('BindingCache.isActive lookup failed — frames will drop as inactive', {
          tags: { deviceId },
          meta: { error: String(err) },
        })
        // Conservative default: treat as inactive so we don't write
        // garbage while the cap registry is racing to come up.
        return false
      } finally {
        this.inflight.delete(deviceId)
      }
    })()
    this.inflight.set(deviceId, promise)
    return promise
  }

  onBindingsChanged(event: {
    readonly deviceId: number
    readonly capName: string
    readonly reason:
      | 'native-registered'
      | 'native-unregistered'
      | 'wrapper-activated'
      | 'wrapper-deactivated'
  }): void {
    if (event.capName !== this.capName) return
    if (event.reason === 'wrapper-activated') {
      this.state.set(event.deviceId, true)
      return
    }
    if (event.reason === 'wrapper-deactivated') {
      this.state.set(event.deviceId, false)
      return
    }
    // native-registered / native-unregistered don't apply to a wrapper
    // cap — just invalidate so the next lookup re-fetches.
    this.state.delete(event.deviceId)
  }

  invalidate(deviceId: number): void {
    this.state.delete(deviceId)
  }

  clearAll(): void {
    this.state.clear()
    this.inflight.clear()
  }
}
