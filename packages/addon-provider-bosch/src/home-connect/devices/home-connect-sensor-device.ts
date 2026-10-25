import { z } from 'zod'
import {
  BaseDevice,
  binaryCapability,
  type BinaryStatus,
  type DeviceContext,
  enumSensorCapability,
  type EnumSensorStatus,
  type InferNativeProvider,
  numericSensorCapability,
  type NumericSensorStatus,
  powerMeterCapability,
  type PowerMeterStatus,
} from '@camstack/types'
import {
  childSliceFromValue,
  HomeConnectChildBindingSchema,
  type HomeConnectChildBinding,
  legacyKindBinding,
} from '../home-connect-child-bindings.js'
import { homeConnectConnections } from '../home-connect-gateway.js'

export const homeConnectSensorSchema = z.object({
  haId: z.string().min(1),
  brokerId: z.string().min(1),
  /**
   * The entity this child reads. Absent on a child persisted by the fixed-catalog build,
   * which wrote `sensorKind` instead — see {@link resolveSensorBinding}.
   */
  binding: HomeConnectChildBindingSchema.optional(),
  /** Fixed-catalog children only: the old kind, which is also their stable suffix. */
  sensorKind: z.string().min(1).optional(),
  system: z.literal('home-connect').optional(),
  integrationId: z.string().optional(),
})

export type HomeConnectSensorConfig = z.infer<typeof homeConnectSensorSchema>

/**
 * The binding of a persisted child row. A restored child's config is the row the KERNEL
 * kept (a spawn reuses the persisted config for an existing stableId), so a child saved by
 * the fixed-catalog build arrives with `sensorKind` and no `binding`: it is translated, never
 * refused — refusing it failed the restore of every such child and left the container's
 * sensors dead until a re-pair. A row with neither is malformed and throws.
 */
export function resolveSensorBinding(
  config: HomeConnectSensorConfig,
  name: string,
): HomeConnectChildBinding {
  if (config.binding !== undefined) return config.binding
  const legacy = config.sensorKind === undefined ? null : legacyKindBinding(config.sensorKind, name)
  if (legacy === null) {
    throw new Error(
      `Home Connect sensor row has no binding and no known sensorKind (${config.sensorKind ?? 'none'})`,
    )
  }
  return legacy
}

/**
 * What `getStatus` answers before the appliance has reported anything. `lastFetchedAt: 0`
 * is the cap's "never fetched" marker; the number beside it is a placeholder the type
 * demands, and it is NEVER written to the runtime slice — a sensor with no value is
 * offline and has no slice, so nothing reads the placeholder as a measurement.
 */
const NEVER_NUMERIC: NumericSensorStatus = { value: 0, lastFetchedAt: 0 }
const NEVER_POWER: PowerMeterStatus = { lastFetchedAt: 0 }
const NEVER_ENUM: EnumSensorStatus = { value: '', lastFetchedAt: 0 }
const NEVER_BINARY: BinaryStatus = { on: false, lastChangedAt: 0 }

/**
 * One Home Connect entity as a Sensor accessory child of the appliance container. The
 * entity it reads is its `binding.key` — one key, never "the first of several that
 * happens to be present".
 */
export class HomeConnectSensorDevice extends BaseDevice<typeof homeConnectSensorSchema> {
  readonly features = [] as const

  readonly #haId: string
  readonly #brokerId: string
  readonly #binding: HomeConnectChildBinding
  #unwatch: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = homeConnectSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeConnectSensorSchema, { type: ctx.deviceMeta.type })
    this.#haId = persisted.haId
    this.#brokerId = persisted.brokerId
    this.#binding = resolveSensorBinding(persisted, ctx.deviceMeta.name)
    void this.updateSourceInfo({
      id: `${this.#haId}:${this.#binding.stableIdSuffix}`,
      system: 'home-connect',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCap()
    this.markOnline(false)
    this.#unwatch = homeConnectConnections.watch(this.#brokerId, this.#haId, () => this.recompute())
    this.recompute()
  }

  override async removeDevice(): Promise<void> {
    this.#unwatch?.()
    this.#unwatch = null
    await super.removeDevice()
  }

  private recompute(): void {
    const client = homeConnectConnections.getClient(this.#brokerId)
    if (!client || client.getLinkState(this.#haId) !== 'connected') {
      this.markOnline(false)
      return
    }
    const slice = childSliceFromValue({
      binding: this.#binding,
      entity: client.getDescription(this.#haId)?.entityByName(this.#binding.key),
      raw: client.getFeatures(this.#haId).get(this.#binding.key),
      nowMs: Date.now(),
    })
    if (slice === null) {
      // Unknown: say so by being offline. The last slice stays what it was (stale, not zero).
      this.markOnline(false)
      return
    }
    if (slice.cap === 'binary') {
      // `lastChangedAt` is the time of a TRANSITION: an unchanged value keeps its stamp.
      const previous = this.runtimeState.getCapState<BinaryStatus>('binary')
      if (previous !== undefined && previous.on === slice.status.on && previous.lastChangedAt > 0) {
        this.markOnline(true)
        return
      }
    }
    this.runtimeState.setCapState(slice.cap, slice.status)
    this.markOnline(true)
  }

  private registerCap(): void {
    switch (this.#binding.cap) {
      case 'numeric-sensor': {
        const provider: InferNativeProvider<typeof numericSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor') ?? NEVER_NUMERIC,
        }
        this.ctx.registerNativeCap(numericSensorCapability, provider)
        return
      }
      case 'power-meter': {
        const provider: InferNativeProvider<typeof powerMeterCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? NEVER_POWER,
        }
        this.ctx.registerNativeCap(powerMeterCapability, provider)
        return
      }
      case 'enum-sensor': {
        const provider: InferNativeProvider<typeof enumSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<EnumSensorStatus>('enum-sensor') ?? NEVER_ENUM,
        }
        this.ctx.registerNativeCap(enumSensorCapability, provider)
        return
      }
      case 'binary': {
        const provider: InferNativeProvider<typeof binaryCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<BinaryStatus>('binary') ?? NEVER_BINARY,
        }
        this.ctx.registerNativeCap(binaryCapability, provider)
        return
      }
    }
  }
}
