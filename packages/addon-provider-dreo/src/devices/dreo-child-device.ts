import { z } from 'zod'
import { BaseDevice, errMsg, type DeviceContext, type DeviceFeature } from '@camstack/types'
import type { DreoDeviceHandle } from '../dreo-device-handle.js'
import { dreoConnections } from '../dreo-gateway.js'
import { registerDreoStateRefresh } from '../dreo-state-refresh.js'

/**
 * Persisted config every Dreo accessory child carries. `dreoDeviceId` resolves
 * the live handle from the connection resolver; `brokerId` selects the account;
 * `model` is the cloud model string; `system`/`integrationId` are provenance.
 */
export const dreoChildSchema = z.object({
  dreoDeviceId: z.string().min(1).describe('Dreo cloud device id'),
  brokerId: z.string().min(1).describe('Integration id (persisted under the legacy name brokerId)'),
  model: z.string().optional().describe('Dreo cloud model string'),
  system: z.literal('dreo').optional(),
  integrationId: z.string().optional(),
})

export type DreoChildConfig = z.infer<typeof dreoChildSchema>

/**
 * Shared base for every Dreo accessory child (fan / purifier / heater /
 * humidifier). Holds the dreoDeviceId + integration id resolved from config and the
 * handle-resolution seam. Concrete subclasses register their cap(s) + attach a
 * `stateChanged` listener that recomputes their cap slices.
 *
 * Cap registration + the handle's change listener are wired in `onActivate` (mirrors
 * `DreameChildDevice`) so `registerNativeCap` lands AFTER the device is registered with the
 * kernel. The worker opens the account's push channel during the integration manager's
 * sign-in, so the live handle is already streaming by the time this child activates.
 */
export abstract class DreoChildDevice extends BaseDevice<typeof dreoChildSchema> {
  readonly features: readonly DeviceFeature[] = []

  /** Dreo cloud device id — dispatch + event-filter key. */
  protected readonly dreoDeviceId: string
  /** Integration id selecting the account connection. */
  protected readonly integrationId: string
  /** Cloud model string (e.g. `DR-HTF008S`). */
  protected readonly model: string | undefined

  /** Disposers for the handle's change and reconnect listeners. */
  private readonly handleUnsubs: Array<() => void> = []

  protected constructor(ctx: DeviceContext) {
    const persisted = dreoChildSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, dreoChildSchema, { type: ctx.deviceMeta.type })
    this.dreoDeviceId = persisted.dreoDeviceId
    this.integrationId = persisted.brokerId
    this.model = persisted.model
    this.online = true
    void this.updateSourceInfo({ id: this.dreoDeviceId, system: 'dreo' })
  }

  /** Resolve this child's live Dreo device handle, or null when disconnected. */
  protected resolveHandle(): DreoDeviceHandle | null {
    return dreoConnections.getDevice(this.integrationId, this.dreoDeviceId)
  }

  /** Narrow the optional handle to a present one or throw a clear error. */
  protected requireHandle(): DreoDeviceHandle {
    const handle = this.resolveHandle()
    if (!handle) {
      throw new Error(`DreoChildDevice: cloud connection unavailable (device=${this.dreoDeviceId})`)
    }
    return handle
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Register the cap(s) + seed the cold-start slice, THEN attach the live listeners and
    // replay the handle's last reported state so the slice reflects reality without
    // waiting for the next push.
    this.registerCaps()
    const publishReconnect = registerDreoStateRefresh({
      ctx: this.ctx,
      integrationId: this.integrationId,
      readAccount: () => dreoConnections.refresh(this.integrationId),
    })
    this.attachHandleListeners(publishReconnect)
    this.recomputeSlices()
  }

  override async removeDevice(): Promise<void> {
    for (const unsub of this.handleUnsubs.splice(0)) {
      try {
        unsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
    }
  }

  /** Attach the handle's change listener and the reconnect notice that bumps the epoch. */
  private attachHandleListeners(publishReconnect: () => void): void {
    const handle = this.resolveHandle()
    if (!handle) {
      this.ctx.logger.debug('DreoChildDevice: handle not present; no live listener yet', {
        tags: { deviceId: this.id },
        meta: { dreoDeviceId: this.dreoDeviceId },
      })
      return
    }
    this.handleUnsubs.push(
      handle.onChange(() => {
        try {
          this.recomputeSlices()
        } catch (err) {
          this.ctx.logger.warn('dreo child: state change handler error', {
            tags: { deviceId: this.id },
            meta: { dreoDeviceId: this.dreoDeviceId, error: errMsg(err) },
          })
        }
      }),
      handle.onReconnect(publishReconnect),
    )
  }

  /** Register the device-scoped cap(s) (subclass-specific). */
  protected abstract registerCaps(): void

  /** Recompute + write this child's cap slice(s) from the handle's reported state.
   *  Called on activation (seed) and on every state change. */
  protected abstract recomputeSlices(): void
}
