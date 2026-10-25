import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  type DeviceRole,
  errMsg,
} from '@camstack/types'
import { z } from 'zod'
import { tuyaConnections, type TuyaDeviceHandle } from '../tuya-gateway.js'

/**
 * Persisted config every Tuya accessory child carries. `integrationId` +
 * `tuyaDeviceId` resolve the PARENT device's single live LAN handle from the
 * shared resolver — a child never opens its own socket (Tuya permits one client
 * per device). Concrete subclasses extend this with their per-DP coordinates.
 */
export const tuyaChildSchema = z.object({
  integrationId: z.string().min(1).describe('Owning Tuya integration id'),
  tuyaDeviceId: z.string().min(1).describe('Parent Tuya cloud device id'),
  system: z.literal('tuya').optional(),
})

export type TuyaChildConfig = z.infer<typeof tuyaChildSchema>

/**
 * Shared base for every Tuya accessory child of a kettle Container. Resolves the
 * parent's live {@link TuyaDeviceHandle} through {@link tuyaConnections} and
 * subscribes to the parent's `dps` fan-out bus so it recomputes its cap slice on
 * every push without attaching a listener to the socket emitter directly.
 * Mirrors `DreameChildDevice`.
 */
export abstract class TuyaChildDevice extends BaseDevice<typeof tuyaChildSchema> {
  readonly features: readonly DeviceFeature[] = []

  protected readonly integrationId: string
  protected readonly tuyaDeviceId: string
  private dpsUnsub: (() => void) | null = null

  protected constructor(ctx: DeviceContext, role?: DeviceRole) {
    const persisted = tuyaChildSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, tuyaChildSchema, {
      type: ctx.deviceMeta.type,
      ...(role !== undefined ? { role } : {}),
    })
    this.integrationId = persisted.integrationId
    this.tuyaDeviceId = persisted.tuyaDeviceId
    this.online = true
  }

  /** Resolve the parent device's live handle, or null when not connected. */
  protected resolveHandle(): TuyaDeviceHandle | null {
    return tuyaConnections.getHandle(this.integrationId, this.tuyaDeviceId)
  }

  /** The parent's latest DP map (empty when the handle is not present). */
  protected dps(): Readonly<Record<string, unknown>> {
    return this.resolveHandle()?.dps ?? {}
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerControlCap()
    this.attachDpsListener()
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
    if (this.dpsUnsub) {
      try {
        this.dpsUnsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.dpsUnsub = null
    }
  }

  private attachDpsListener(): void {
    this.dpsUnsub?.()
    const onDps = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('tuya child: dps handler error', {
          meta: { tuyaDeviceId: this.tuyaDeviceId, error: errMsg(err) },
        })
      }
    }
    this.dpsUnsub = tuyaConnections.onDps(this.integrationId, this.tuyaDeviceId, onDps)
  }

  /** Register the device-scoped control cap (subclass-specific). */
  protected abstract registerControlCap(): void

  /** Recompute + write this child's cap slice from the parent's latest DPs. */
  protected abstract recomputeSlice(): void
}
