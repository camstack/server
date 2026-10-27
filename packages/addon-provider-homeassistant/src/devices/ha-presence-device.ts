import {
  type BatteryStatus,
  batteryCapability,
  presenceCapability,
  type DeviceContext,
  type InferNativeProvider,
  type PresenceStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

/** No reading yet: unknown, never 0 % (D393). */
const COLD_BATTERY: BatteryStatus = {
  level: null,
  charging: 'unknown',
  sleeping: false,
  lastUpdated: 0,
}

const COLD_START: PresenceStatus = {
  state: 'unknown',
  location: null,
  gps: null,
  lastChangedAt: 0,
}

/**
 * HA-backed presence device — `person.*` or `device_tracker.*`. Read-
 * only; no setters. State value is freeform (`home` / `not_home` /
 * any user-defined zone).
 *
 * HA attributes consumed:
 *   - `latitude` / `longitude` / `gps_accuracy` → gps envelope
 *   - `battery_level` → the `battery` cap (a presence provider never reports
 *     battery on the presence status)
 *   - `friendly_name` and the state value drive the `location` label
 */
export class HaPresenceDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerPresenceCap()
    this.registerBatteryCap()
    this.runtimeState.setCapState('presence', COLD_START)
    const existing = this.runtimeState.getCapState<BatteryStatus>('battery')
    if (existing === undefined) this.runtimeState.setCapState('battery', COLD_BATTERY)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const attrs = state.attributes
    const lat = readNumberAttr(attrs, 'latitude')
    const lon = readNumberAttr(attrs, 'longitude')
    const acc = readNumberAttr(attrs, 'gps_accuracy')
    const battery = readNumberAttr(attrs, 'battery_level')
    const slice: PresenceStatus = {
      state: state.state,
      location: state.state === 'unknown' || state.state === 'not_home' ? null : state.state,
      gps:
        lat !== null && lon !== null
          ? { latitude: lat, longitude: lon, accuracyMeters: acc ?? 0 }
          : null,
      lastChangedAt,
    }
    this.runtimeState.setCapState('presence', slice)
    if (battery !== null) {
      this.runtimeState.setCapState('battery', {
        level: Math.min(100, Math.max(0, battery)),
        charging: 'unknown',
        sleeping: false,
        lastUpdated: lastChangedAt,
      })
    }
  }

  private registerBatteryCap(): void {
    const provider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<BatteryStatus>('battery') ?? COLD_BATTERY,
      // An HA entity is read-only upstream — there is no wake path.
      wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
  }

  private registerPresenceCap(): void {
    const provider: InferNativeProvider<typeof presenceCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<PresenceStatus>('presence') ?? COLD_START
      },
    }
    this.ctx.registerNativeCap(presenceCapability, provider)
  }
}

function readNumberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}
