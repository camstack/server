import { DeviceType, DeviceRole } from '@camstack/types'
import type { DeviceFeature } from '@camstack/types'
import type { HmChannel, HmDevice } from 'nodehomematic'

/**
 * Homematic channel `TYPE` → CamStack materialisation triplet. Pure:
 * same channel shape always yields the same mapping. Mirrors the Home
 * Assistant `ha-domain-mapping.ts` design — the single source of truth
 * for which CamStack `DeviceType` + caps a Homematic device exposes.
 *
 * Homematic(IP) devices are channel-based: one physical device exposes
 * several channels, each with a `TYPE`. The controllable channel is
 * typically the `*_VIRTUAL_RECEIVER` (writable datapoints); its live
 * read-back status arrives on the matching `*_TRANSMITTER` channel. The
 * addon registers the cap against the VIRTUAL_RECEIVER channel address
 * (the facade custom-entity layer resolves the sibling transmitter for
 * status), and decodes status pushes from BOTH channels by parameter
 * name in the device class's `valueChanged` handler.
 *
 * The channel-type vocabulary below is taken from a live CCU3 /
 * RaspberryMatic (HmIP-BSM / BS2 / BROLL / BWTH / STHD / WTH-2 /
 * eTRV-C / SMI / DLD / ESI, …) — NOT guessed.
 *
 * Returns `null` for channel types with no supported mapping yet — the
 * caller skips them (maintenance channels, status-only transmitter
 * mirrors, key/remote channels, week-profile channels, …).
 */

export interface HmChannelMapping {
  readonly deviceType: DeviceType
  readonly role: DeviceRole | null
  /** CamStack cap names to register on the device for this channel. */
  readonly capabilities: readonly string[]
  /** Optional DeviceFeature flags surfaced on `device.features`. */
  readonly features?: readonly DeviceFeature[]
}

/**
 * Map a single Homematic channel to its CamStack triplet. The channel
 * `TYPE` is the discriminator. Only the controllable / primary channel
 * types map; status-only `*_TRANSMITTER` mirrors and the various key /
 * remote / week-profile channels return `null` (their datapoints are
 * still decoded into the owning cap's slice via the device's
 * `valueChanged` handler, keyed by parameter name).
 */
export function mapHmChannel(channelType: string | undefined): HmChannelMapping | null {
  if (!channelType) return null
  const type = channelType.toUpperCase()

  switch (type) {
    // ── Switch family (HmIP-BSM / BS2 relays + plugs) ──────────────────
    // The VIRTUAL_RECEIVER is the writable side (STATE / ON_TIME); the
    // sibling SWITCH_TRANSMITTER carries the read-back STATE.
    case 'SWITCH_VIRTUAL_RECEIVER':
      return { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] }

    // ── Cover family (HmIP-BROLL roller shutters) ──────────────────────
    // SHUTTER_VIRTUAL_RECEIVER is writable (LEVEL 0..1, STOP); the
    // sibling SHUTTER_TRANSMITTER carries LEVEL / LEVEL_STATUS /
    // ACTIVITY_STATE read-back.
    case 'SHUTTER_VIRTUAL_RECEIVER':
      return { deviceType: DeviceType.Cover, role: null, capabilities: ['cover'] }

    // ── Climate / heating (HmIP-eTRV-C / BWTH / STHD / WTH-2 /
    //    HEATING / FALMOT-C12) ──────────────────────────────────────────
    // Writable SET_POINT_TEMPERATURE / CONTROL_MODE / BOOST_MODE;
    // readable ACTUAL_TEMPERATURE / HUMIDITY / VALVE_STATE. WTH/BWTH
    // wall thermostats also report HUMIDITY → humidity-sensor cap.
    case 'HEATING_CLIMATECONTROL_TRANSCEIVER':
      return {
        deviceType: DeviceType.Thermostat,
        role: null,
        capabilities: ['climate-control', 'temperature-sensor', 'humidity-sensor'],
      }

    // ── Motion (HmIP-SMI) ──────────────────────────────────────────────
    // MOTION (bool) + ILLUMINATION (lux). Optional RESET_MOTION write.
    case 'MOTIONDETECTOR_TRANSCEIVER':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.MotionSensor,
        capabilities: ['motion', 'ambient-light-sensor'],
      }

    // ── Lock (HmIP-DLD door-lock drive) ────────────────────────────────
    // Writable LOCK_TARGET_LEVEL; readable LOCK_STATE / ACTIVITY_STATE.
    case 'DOOR_LOCK_STATE_TRANSMITTER':
      return {
        deviceType: DeviceType.Lock,
        role: null,
        capabilities: ['lock-control'],
      }

    // ── Energy / power meter (HmIP-BSM built-in + HmIP-ESI gas/energy) ──
    // Read-only POWER / ENERGY_COUNTER / VOLTAGE / CURRENT / FREQUENCY.
    case 'ENERGIE_METER_TRANSMITTER':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.PowerSensor,
        capabilities: ['power-meter'],
      }

    // ── Key / remote channels (wall switches HmIP-WRC2/WRC6, remotes
    //    HmIP-RC8, HmIP-KRC4 key-ring, push-buttons) ─────────────────────
    // Each key channel is one button. The device's key channels collapse
    // to ONE `event-emitter` cap (singleton) whose vocabulary is the union
    // of the channels' native `PRESS_*` datapoints (verbatim). The button
    // index lives in the fired event's `data.channel`, not in the cap name.
    //   - KEY_TRANSCEIVER : HmIP key/remote channels (PRESS_SHORT/LONG/…)
    //   - KEY_TRANSMITTER : HmIP-RC remote transmit-only key channels
    //   - VIRTUAL_KEY     : CCU virtual-key channels (e.g. doorbell remotes)
    //   - KEY             : classic Homematic (BidCos) push-button channels
    case 'KEY_TRANSCEIVER':
    case 'KEY_TRANSMITTER':
    case 'VIRTUAL_KEY':
    case 'KEY':
      return { deviceType: DeviceType.EventEmitter, role: null, capabilities: ['event-emitter'] }

    // ── Status-only transmitters, week profiles, maintenance — no
    //    standalone mapping. ─────────────────────────────────────────────
    // Their datapoints (where relevant) are decoded into the owning
    // actuator's slice by the device class, keyed on parameter name.
    default:
      return null
  }
}

/**
 * Best-effort parent DeviceType for a whole Homematic device, derived
 * from the union of its channel mappings. Actuators win over sensors so
 * a switch + energy-meter device (HmIP-BSM) reports as a Switch, not a
 * Sensor, and a thermostat with a humidity sensor reports as a
 * Thermostat. A remote/wall-switch is primarily an EventEmitter: it is
 * ranked above Sensor so its battery / maintenance sensor channels don't
 * win the parent type. Returns `DeviceType.Generic` when no channel maps.
 */
const PARENT_TYPE_PRIORITY: readonly DeviceType[] = [
  DeviceType.Thermostat,
  DeviceType.Lock,
  DeviceType.Cover,
  DeviceType.Light,
  DeviceType.Switch,
  DeviceType.EventEmitter,
  DeviceType.Sensor,
]

export function inferHmDeviceType(device: Pick<HmDevice, 'channels'>): DeviceType {
  const present = new Set<DeviceType>()
  for (const channel of device.channels) {
    const mapping = mapHmChannel(channel.type)
    if (mapping) present.add(mapping.deviceType)
  }
  for (const dt of PARENT_TYPE_PRIORITY) {
    if (present.has(dt)) return dt
  }
  return DeviceType.Generic
}

/**
 * Collect every supported channel mapping for a device, paired with the
 * channel it came from. Drives the device class's cap-registration loop.
 */
export interface MappedChannel {
  readonly channel: HmChannel
  readonly mapping: HmChannelMapping
}

export function mapHmDeviceChannels(device: Pick<HmDevice, 'channels'>): readonly MappedChannel[] {
  const out: MappedChannel[] = []
  for (const channel of device.channels) {
    const mapping = mapHmChannel(channel.type)
    if (mapping) out.push({ channel, mapping })
  }
  return out
}
