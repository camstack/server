import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  type InferNativeProvider,
  type TemperatureSensorStatus,
  temperatureSensorCapability,
} from '@camstack/types'
import { z } from 'zod'
import type { GreeExtras } from '../gree-extras.js'
import { greeConnections } from '../gree-gateway.js'

export const greeSensorSchema = z.object({
  // `error` is retired (the fault is the AC's `error` cap). A child persisted
  // with it still restores, serving nothing, until the accessory reconcile
  // prunes it.
  kind: z.enum(['outdoor', 'error']).describe('Which extra status column this sensor reports'),
  greeMac: z.string().min(1).describe('Gree AC MAC address'),
  connectionKey: z.string().min(1).describe('Per-device connection resolver key'),
  system: z.literal('gree').optional(),
  integrationId: z.string().optional(),
})

const TEMP_CAP = 'temperature-sensor'

/**
 * A sensor child of a Gree AC fed by the extra status columns the library does
 * not poll: the outdoor temperature (`temperature-sensor`).
 */
export class GreeSensorDevice extends BaseDevice<typeof greeSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly reportsOutdoor: boolean
  private readonly greeMac: string
  private readonly connectionKey: string
  private extrasUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = greeSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, greeSensorSchema, { type: ctx.deviceMeta.type })
    this.reportsOutdoor = persisted.kind === 'outdoor'
    this.greeMac = persisted.greeMac
    this.connectionKey = persisted.connectionKey
    this.online = true
    void this.updateSourceInfo({ id: `${this.greeMac}:${persisted.kind}`, system: 'gree' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCap()
    this.apply(greeConnections.getExtras(this.connectionKey, this.greeMac))
    this.extrasUnsub = greeConnections.onExtras(this.connectionKey, () =>
      this.apply(greeConnections.getExtras(this.connectionKey, this.greeMac)),
    )
  }

  override async removeDevice(): Promise<void> {
    this.extrasUnsub?.()
    this.extrasUnsub = null
  }

  private registerCap(): void {
    if (!this.reportsOutdoor) return
    const cold: TemperatureSensorStatus = { temperature: null, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<TemperatureSensorStatus>(TEMP_CAP) ?? cold,
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, provider)
    this.runtimeState.setCapState(TEMP_CAP, cold)
  }

  private apply(extras: GreeExtras | null): void {
    if (!this.reportsOutdoor || extras === null || extras.outdoorTemp === null) return
    this.runtimeState.setCapState(TEMP_CAP, {
      temperature: extras.outdoorTemp,
      lastFetchedAt: Date.now(),
    })
  }
}
