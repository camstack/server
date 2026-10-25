import {
  enumSensorCapability,
  EnumSensorDateTimeFormatSchema,
  type DeviceContext,
  type InferNativeProvider,
  type EnumSensorStatus,
  type EnumSensorDateTimeFormat,
  type DeviceRole,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: EnumSensorStatus = { value: '', lastFetchedAt: 0 }

/**
 * HA-backed enum-sensor child. Used for HA `sensor.*` entities with
 * `device_class: enum` or `state_class: enum` — typically string
 * states with an `options[]` attribute (e.g. weather conditions:
 * 'sunny' / 'cloudy' / 'rainy').
 *
 * Cap slice carries the raw string state; UI consumers may also
 * read `attributes.options` from HA via getStatus dispatch on the
 * source attribute side — out of scope here, the cap is push-only.
 */
export class HaEnumSensorDevice extends HaBaseChildDevice {
  /**
   * Locale-render shape for a `DateTimeSensor`-role sensor (HA
   * `device_class=timestamp` → `'datetime'`, `date` → `'date'`). Read from the
   * persisted child config (threaded by the HA mapping) and seeded into the cap
   * slice alongside `value` so the UI renders the ISO string locale-formatted.
   * `undefined` for a plain enum sensor — the slice then omits `format`.
   */
  private readonly dateTimeFormat: EnumSensorDateTimeFormat | undefined

  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as { role?: DeviceRole; dateTimeFormat?: unknown }
    super(ctx, persisted.role !== undefined ? { role: persisted.role } : {})
    const parsedFormat = EnumSensorDateTimeFormatSchema.safeParse(persisted.dateTimeFormat)
    this.dateTimeFormat = parsedFormat.success ? parsedFormat.data : undefined
    this.registerCap()
    this.runtimeState.setCapState('enum-sensor', this.coldStart())
  }

  /** Cold-start slice — carries the format up-front so the UI can render the
   *  correct shape the instant a value lands, with no slice churn. */
  private coldStart(): EnumSensorStatus {
    return {
      ...COLD_START,
      ...(this.dateTimeFormat !== undefined ? { format: this.dateTimeFormat } : {}),
    }
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastFetchedAt = Date.parse(state.last_updated) || Date.now()
    this.runtimeState.setCapState('enum-sensor', {
      value: state.state,
      ...(this.dateTimeFormat !== undefined ? { format: this.dateTimeFormat } : {}),
      lastFetchedAt,
    })
  }

  private registerCap(): void {
    const provider: InferNativeProvider<typeof enumSensorCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<EnumSensorStatus>('enum-sensor') ?? this.coldStart()
      },
    }
    this.ctx.registerNativeCap(enumSensorCapability, provider)
  }
}
