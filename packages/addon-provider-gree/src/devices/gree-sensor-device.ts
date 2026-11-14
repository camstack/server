import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  type EnumSensorStatus,
  enumSensorCapability,
  type InferNativeProvider,
  type TemperatureSensorStatus,
  temperatureSensorCapability,
} from '@camstack/types'
import { z } from 'zod'
import { type GreeExtras, type GreeSensorKind, greeErrorValue } from '../gree-extras.js'
import { greeConnections } from '../gree-gateway.js'

export const greeSensorSchema = z.object({
  kind: z.enum(['outdoor', 'error']).describe('Which extra status column this sensor reports'),
  greeMac: z.string().min(1).describe('Gree AC MAC address'),
  connectionKey: z.string().min(1).describe('Per-device connection resolver key'),
  system: z.literal('gree').optional(),
  integrationId: z.string().optional(),
})

const TEMP_CAP = 'temperature-sensor'
const ENUM_CAP = 'enum-sensor'

/**
 * A sensor child of a Gree AC fed by the extra status columns the library does
 * not poll: `outdoor` is the outdoor temperature (`temperature-sensor`), `error`
 * is the unit's fault code (`enum-sensor`: `ok` or `E<code>`).
 */
export class GreeSensorDevice extends BaseDevice<typeof greeSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly kind: GreeSensorKind
  private readonly greeMac: string
  private readonly connectionKey: string
  private extrasUnsub: (() => void) | null = null
  private lastErrorCode: number | null = null

  constructor(ctx: DeviceContext) {
    const persisted = greeSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, greeSensorSchema, { type: ctx.deviceMeta.type })
    this.kind = persisted.kind
    this.greeMac = persisted.greeMac
    this.connectionKey = persisted.connectionKey
    this.online = true
    void this.updateSourceInfo({ id: `${this.greeMac}:${this.kind}`, system: 'gree' })
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
    if (this.kind === 'outdoor') {
      const cold: TemperatureSensorStatus = { temperature: null, lastFetchedAt: 0 }
      const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
        getStatus: async () =>
          this.runtimeState.getCapState<TemperatureSensorStatus>(TEMP_CAP) ?? cold,
      }
      this.ctx.registerNativeCap(temperatureSensorCapability, provider)
      this.runtimeState.setCapState(TEMP_CAP, cold)
      return
    }
    const cold: EnumSensorStatus = { value: 'ok', lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof enumSensorCapability> = {
      getStatus: async () => this.runtimeState.getCapState<EnumSensorStatus>(ENUM_CAP) ?? cold,
    }
    this.ctx.registerNativeCap(enumSensorCapability, provider)
    this.runtimeState.setCapState(ENUM_CAP, cold)
  }

  private apply(extras: GreeExtras | null): void {
    if (extras === null) return
    const now = Date.now()
    if (this.kind === 'outdoor') {
      if (extras.outdoorTemp === null) return
      this.runtimeState.setCapState(TEMP_CAP, { temperature: extras.outdoorTemp, lastFetchedAt: now })
      return
    }
    if (extras.errorCode === null) return
    if (extras.errorCode !== 0 && extras.errorCode !== this.lastErrorCode) {
      this.ctx.logger.warn('Gree AC reports a fault', {
        tags: { deviceId: this.id },
        meta: { greeMac: this.greeMac, errorCode: extras.errorCode },
      })
    }
    this.lastErrorCode = extras.errorCode
    this.runtimeState.setCapState(ENUM_CAP, {
      value: greeErrorValue(extras.errorCode),
      lastFetchedAt: now,
    })
  }
}
