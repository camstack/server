import { DeviceType, DeviceRole } from '@camstack/types'
import type { HmChannel, HmDataPoint, HmDevice } from 'nodehomematic'

/**
 * PURE mapping of a Homematic device's MAINTENANCE channel + firmware
 * descriptor fields into provider-internal "derived entity" descriptors.
 *
 * A later Container task turns each {@link HmDerivedEntity} into a CamStack
 * accessory child (diagnostic Sensor or an Update child). These helpers are
 * side-effect-free: the same device snapshot always yields the same result.
 * They decide ONLY which children exist and how they are typed — the device
 * class wires live values (push) into the child's cap slice afterwards,
 * keyed on the `sourceParams` declared here.
 *
 * Diagnostic role conventions mirror the Home Assistant provider's
 * `ha-domain-mapping.ts` so the two integrations surface battery / signal /
 * voltage / temperature diagnostics identically:
 *   - battery low (binary)      → Sensor / BatterySensor / ['binary']
 *   - operating voltage (V)     → Sensor / VoltageSensor / ['numeric-sensor']
 *   - signal (dBm)              → Sensor / NumericSensor / ['numeric-sensor']
 *   - duty cycle (% or binary)  → Sensor / NumericSensor / ['numeric-sensor'|'binary']
 *   - temperature (°C)          → Sensor / TemperatureSensor / ['temperature-sensor']
 *
 * Reachability datapoints (UNREACH / STICKY_UNREACH / CONFIG_PENDING) are
 * deliberately NOT children — reachability drives the parent Container's
 * `online` flag instead (see {@link readReachability}).
 *
 * The MAINTENANCE parameter vocabulary below is taken from live CCU3 /
 * RaspberryMatic devices (HmIP-* `MAINTENANCE:0` channels) — not guessed.
 */
export interface HmDerivedEntity {
  /** Stable suffix within the device — e.g. `maint-voltage`, `update`. */
  readonly key: string
  readonly deviceType: DeviceType
  readonly role: DeviceRole | null
  /** CamStack cap names the derived child registers. */
  readonly capabilities: readonly string[]
  /** Human label, e.g. `Operating voltage`, `Signal (device)`, `Firmware`. */
  readonly name: string
  /** Display unit, e.g. `%`, `V`, `dBm`, `°C`. */
  readonly unit?: string
  /**
   * The MAINTENANCE datapoint parameter name(s) this entity reads — the
   * device class wires value pushes by matching these. `undefined` for the
   * firmware update entity (it reads the device-level descriptor fields).
   */
  readonly sourceParams?: readonly string[]
}

const MAINTENANCE_CHANNEL_TYPE = 'MAINTENANCE'

/** Reachability parameters that drive the Container's `online`, not a child. */
const REACHABILITY_PARAMS = ['UNREACH', 'STICKY_UNREACH'] as const

function findMaintenanceChannel(device: Pick<HmDevice, 'channels'>): HmChannel | undefined {
  return device.channels.find((channel) => channel.type?.toUpperCase() === MAINTENANCE_CHANNEL_TYPE)
}

function findParam(channel: HmChannel, parameter: string): HmDataPoint | undefined {
  return channel.dataPoints.find((dp) => dp.parameter.toUpperCase() === parameter)
}

/** A datapoint is "boolean" when its declared CCU type is BOOL/ACTION. */
function isBooleanDataPoint(dp: HmDataPoint): boolean {
  const type = dp.type.toUpperCase()
  return type === 'BOOL' || type === 'ACTION'
}

/**
 * Map a device's MAINTENANCE channel to its diagnostic derived entities.
 * Emits one entity per recognised datapoint; returns `[]` when there is no
 * MAINTENANCE channel or no recognised datapoints. Entities are emitted even
 * when the datapoint `value` is still `null` — the value arrives via push.
 */
export function mapMaintenanceChannel(
  device: Pick<HmDevice, 'channels'>,
): readonly HmDerivedEntity[] {
  const channel = findMaintenanceChannel(device)
  if (!channel) return []

  const entities: HmDerivedEntity[] = []

  // Battery diagnostic — ONLY for battery-powered devices. `LOW_BAT` is the
  // structural marker of a battery device: mains-powered devices (roller
  // shutters, switches) may still carry an `OPERATING_VOLTAGE` datapoint in the
  // descriptor, but it has no meaningful reading (Home Assistant omits it, so do
  // we — otherwise the device shows a phantom "0 V" entity). When the device IS
  // battery-powered, prefer the richer OPERATING_VOLTAGE reading over the
  // LOW_BAT binary.
  const lowBat = findParam(channel, 'LOW_BAT')
  if (lowBat) {
    const voltage = findParam(channel, 'OPERATING_VOLTAGE')
    if (voltage) {
      entities.push({
        key: 'maint-voltage',
        deviceType: DeviceType.Sensor,
        role: DeviceRole.VoltageSensor,
        capabilities: ['numeric-sensor'],
        name: 'Operating voltage',
        unit: voltage.unit ?? 'V',
        sourceParams: ['OPERATING_VOLTAGE'],
      })
    } else {
      entities.push({
        key: 'maint-battery-low',
        deviceType: DeviceType.Sensor,
        role: DeviceRole.BatterySensor,
        capabilities: ['binary'],
        name: 'Battery low',
        sourceParams: ['LOW_BAT'],
      })
    }
  }

  // Signal strength: device-side and (optional) peer-side RSSI.
  const rssiDevice = findParam(channel, 'RSSI_DEVICE')
  if (rssiDevice) {
    entities.push({
      key: 'maint-rssi-device',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.NumericSensor,
      capabilities: ['numeric-sensor'],
      name: 'Signal (device)',
      unit: rssiDevice.unit ?? 'dBm',
      sourceParams: ['RSSI_DEVICE'],
    })
  }
  const rssiPeer = findParam(channel, 'RSSI_PEER')
  if (rssiPeer) {
    entities.push({
      key: 'maint-rssi-peer',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.NumericSensor,
      capabilities: ['numeric-sensor'],
      name: 'Signal (peer)',
      unit: rssiPeer.unit ?? 'dBm',
      sourceParams: ['RSSI_PEER'],
    })
  }

  // Duty cycle: numeric (%) on newer firmware, boolean on older devices.
  const dutyCycle = findParam(channel, 'DUTY_CYCLE')
  if (dutyCycle) {
    if (isBooleanDataPoint(dutyCycle)) {
      entities.push({
        key: 'maint-duty-cycle',
        deviceType: DeviceType.Sensor,
        // Boolean duty-cycle maps to the binary cap, so the role must be the
        // binary-sensor role (a NumericSensor role would render the wrong
        // widget/icon for an on/off value).
        role: DeviceRole.BinarySensor,
        capabilities: ['binary'],
        name: 'Duty cycle',
        sourceParams: ['DUTY_CYCLE'],
      })
    } else {
      entities.push({
        key: 'maint-duty-cycle',
        deviceType: DeviceType.Sensor,
        role: DeviceRole.NumericSensor,
        capabilities: ['numeric-sensor'],
        name: 'Duty cycle',
        unit: dutyCycle.unit ?? '%',
        sourceParams: ['DUTY_CYCLE'],
      })
    }
  }

  // Operating/actual temperature on MAINTENANCE (rare — e.g. overheating
  // guards). Either parameter maps to the same temperature child.
  const operatingTemp = findParam(channel, 'OPERATING_TEMPERATURE')
  const actualTemp = findParam(channel, 'ACTUAL_TEMPERATURE')
  const temp = operatingTemp ?? actualTemp
  if (temp) {
    entities.push({
      key: 'maint-temperature',
      deviceType: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
      capabilities: ['temperature-sensor'],
      name: operatingTemp ? 'Operating temperature' : 'Temperature',
      unit: temp.unit ?? '°C',
      sourceParams: [temp.parameter.toUpperCase()],
    })
  }

  return entities
}

/**
 * Decide whether a device should expose a firmware Update child. Returns the
 * update entity when the device carries ANY firmware descriptor field (at
 * least `firmware`, or `updatable === true`); otherwise `null`. The device
 * class reads the live firmware fields to populate the `update` cap slice;
 * this helper only decides whether the child exists.
 */
export function mapFirmwareUpdate(
  device: Pick<HmDevice, 'firmware' | 'availableFirmware' | 'updatable' | 'firmwareUpdateState'>,
): HmDerivedEntity | null {
  const hasFirmwareDescriptor =
    device.firmware !== undefined ||
    device.availableFirmware !== undefined ||
    device.firmwareUpdateState !== undefined ||
    device.updatable === true

  if (!hasFirmwareDescriptor) return null

  return {
    key: 'update',
    deviceType: DeviceType.Update,
    role: null,
    capabilities: ['update'],
    name: 'Firmware',
  }
}

/**
 * Read the device's reachability from its MAINTENANCE channel. Returns
 * `{ unreach }` when an UNREACH (or STICKY_UNREACH) datapoint is present, or
 * `null` when reachability is unknown. The Container task derives
 * `online = !unreach` from this.
 */
export function readReachability(device: Pick<HmDevice, 'channels'>): { unreach: boolean } | null {
  const channel = findMaintenanceChannel(device)
  if (!channel) return null

  for (const param of REACHABILITY_PARAMS) {
    const dp = findParam(channel, param)
    if (dp) return { unreach: Boolean(dp.value) }
  }
  return null
}
