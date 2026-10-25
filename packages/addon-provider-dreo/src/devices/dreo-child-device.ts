import { z } from 'zod'
import { BaseDevice, errMsg, type DeviceContext, type DeviceFeature } from '@camstack/types'
import type { BaseDevice as DreoBaseDevice } from '@apocaliss92/nodedreo'
import { dreoConnections } from '../dreo-gateway.js'

/**
 * Persisted config every Dreo accessory child carries. `dreoDeviceId` resolves
 * the live handle from the connection resolver; `brokerId` selects the account;
 * `model` is the cloud model string; `system`/`integrationId` are provenance.
 */
export const dreoChildSchema = z.object({
  dreoDeviceId: z.string().min(1).describe('Dreo cloud device id'),
  brokerId: z.string().min(1).describe('Registry broker id'),
  model: z.string().optional().describe('Dreo cloud model string'),
  system: z.literal('dreo').optional(),
  integrationId: z.string().optional(),
})

export type DreoChildConfig = z.infer<typeof dreoChildSchema>

/**
 * Shared base for every Dreo accessory child (fan / purifier / heater /
 * humidifier). Holds the dreoDeviceId + brokerId resolved from config and the
 * handle-resolution seam. Concrete subclasses register their cap(s) + attach a
 * `stateChanged` listener that recomputes their cap slices.
 *
 * Cap registration + the device's WebSocket push lifecycle are wired in
 * `onActivate` (mirrors `DreameChildDevice`) so `registerNativeCap` lands AFTER
 * the device is registered with the kernel. The library opens the device's
 * WebSocket push during the integration manager's `connect()`, so the live
 * handle is already streaming by the time this child activates.
 */
export abstract class DreoChildDevice extends BaseDevice<typeof dreoChildSchema> {
  readonly features: readonly DeviceFeature[] = []

  /** Dreo cloud device id — dispatch + event-filter key. */
  protected readonly dreoDeviceId: string
  /** Registry broker id selecting the account connection. */
  protected readonly brokerId: string
  /** Cloud model string (e.g. `DR-HTF008S`). */
  protected readonly model: string | undefined

  /** Disposer for the handle `stateChanged` listener. */
  private stateChangedUnsub: (() => void) | null = null

  protected constructor(ctx: DeviceContext) {
    const persisted = dreoChildSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, dreoChildSchema, { type: ctx.deviceMeta.type })
    this.dreoDeviceId = persisted.dreoDeviceId
    this.brokerId = persisted.brokerId
    this.model = persisted.model
    this.online = true
    void this.updateSourceInfo({ id: this.dreoDeviceId, system: 'dreo' })
  }

  /** Resolve this child's live Dreo device handle, or null when disconnected. */
  protected resolveHandle(): DreoBaseDevice | null {
    return dreoConnections.getDevice(this.brokerId, this.dreoDeviceId)
  }

  /** Narrow the optional handle to a present one or throw a clear error. */
  protected requireHandle(): DreoBaseDevice {
    const handle = this.resolveHandle()
    if (!handle) {
      throw new Error(`DreoChildDevice: cloud connection unavailable (device=${this.dreoDeviceId})`)
    }
    return handle
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Register the cap(s) + seed the cold-start slice, THEN attach the live
    // `stateChanged` listener and replay the current cached values so the slice
    // reflects reality without waiting for the next push.
    this.registerCaps()
    this.attachStateListener()
    this.recomputeSlices()
  }

  override async removeDevice(): Promise<void> {
    if (this.stateChangedUnsub) {
      try {
        this.stateChangedUnsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.stateChangedUnsub = null
    }
  }

  /** Attach the library `stateChanged` listener (handle is per-device already). */
  private attachStateListener(): void {
    const handle = this.resolveHandle()
    if (!handle) {
      this.ctx.logger.debug('DreoChildDevice: handle not present; no live listener yet', {
        meta: { dreoDeviceId: this.dreoDeviceId },
      })
      return
    }
    const onState = (): void => {
      try {
        this.recomputeSlices()
      } catch (err) {
        this.ctx.logger.warn('dreo child: stateChanged handler error', {
          meta: { dreoDeviceId: this.dreoDeviceId, error: errMsg(err) },
        })
      }
    }
    handle.on('stateChanged', onState)
    this.stateChangedUnsub = (): void => {
      handle.off('stateChanged', onState)
    }
  }

  /** Register the device-scoped cap(s) (subclass-specific). */
  protected abstract registerCaps(): void

  /** Recompute + write this child's cap slice(s) from the live handle getters.
   *  Called on activation (seed) and on every `stateChanged` push. */
  protected abstract recomputeSlices(): void
}
