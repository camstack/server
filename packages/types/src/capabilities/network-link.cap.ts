import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * How a device reaches the network, and how well.
 *
 * NOT `connectivity`: that cap is an UPSTREAM system's binary view of whether
 * an entity is reachable (a Home Assistant `binary_sensor` with
 * `device_class: connectivity`). This one is the device's OWN link — the
 * medium it is on and the signal it sees — the way `battery` is the device's
 * own charge.
 *
 * `'wifi'`, `'ethernet'` and `'cellular'` are links the firmware actually
 * reported. `'unknown'` is the ABSENCE of an answer — the provider has
 * registered the capability but has not read the link yet (D315: unknown is
 * not empty). Consumers skip it rather than draw a wire or a bar.
 */
export const NETWORK_LINK_TYPES = ['wifi', 'ethernet', 'cellular', 'unknown'] as const
export type NetworkLinkType = (typeof NETWORK_LINK_TYPES)[number]

/**
 * Network-link snapshot. Same shape for every provider (a Reolink wifi
 * camera, a Home Assistant device with a signal-strength sensor, a Tapo
 * plug): one slice under `device.runtimeState['network-link']`, one badge,
 * one Home Assistant projection.
 */
export const NetworkLinkStatusSchema = z.object({
  /** The link the device is on. `'unknown'` = not read yet, not "no link". */
  type: z.enum(NETWORK_LINK_TYPES),
  /**
   * Link quality, 0..100 inclusive, normalised by the provider from whatever
   * the firmware reports (bars, RSSI, a vendor scale). **`null` means NOT
   * KNOWN or NOT APPLICABLE** — a wired link has no signal, and a wireless
   * one whose reading has not landed must not be drawn at 0 %. Consumers
   * SKIP a null rather than coerce it.
   */
  signalPercent: z.number().min(0).max(100).nullable(),
  /** Raw received signal strength in dBm, when the firmware reports one. */
  rssiDbm: z.number().optional(),
  /** Network name of a wireless link, when the firmware reports it. */
  ssid: z.string().optional(),
  /** Ms epoch of the last observation. Lets consumers reason about freshness. */
  lastUpdated: z.number(),
})

export type NetworkLinkStatus = z.infer<typeof NetworkLinkStatusSchema>

/** The slice a provider seeds before its first read: nothing is known yet. */
export const NETWORK_LINK_UNKNOWN: NetworkLinkStatus = {
  type: 'unknown',
  signalPercent: null,
  lastUpdated: 0,
}

/**
 * Normalise a signal the firmware reports as BARS (0..`maxBars`) to 0..100.
 * Out-of-range or non-finite input is not a reading: `null`.
 */
export function signalPercentFromBars(bars: number | undefined, maxBars: number): number | null {
  if (bars === undefined || !Number.isFinite(bars) || maxBars <= 0) return null
  if (bars < 0 || bars > maxBars) return null
  return Math.round((bars / maxBars) * 100)
}

/**
 * Normalise an RSSI in dBm to 0..100 on the usual wifi scale: -100 dBm and
 * below is 0 %, -50 dBm and above is 100 %, linear between. Non-finite or
 * positive input is not an RSSI: `null`.
 */
export function signalPercentFromRssi(rssiDbm: number | undefined): number | null {
  if (rssiDbm === undefined || !Number.isFinite(rssiDbm) || rssiDbm > 0) return null
  const clamped = Math.min(-50, Math.max(-100, rssiDbm))
  return Math.round((clamped + 100) * 2)
}

export const networkLinkCapability = {
  name: 'network-link',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [
    DeviceType.Camera,
    DeviceType.Sensor,
    DeviceType.Button,
    DeviceType.Switch,
    DeviceType.Light,
    DeviceType.Lock,
    DeviceType.Siren,
  ],
  methods: {},
  events: {
    /**
     * Emitted whenever the cached status changes (a link switch, a signal
     * reading that moved). Mirrored on the parent chain by the
     * DeviceEventPropagator like `battery.onStatusChanged`.
     */
    onStatusChanged: {
      data: z.object({
        deviceId: z.number(),
        status: NetworkLinkStatusSchema,
      }),
    },
  },
  status: {
    schema: NetworkLinkStatusSchema,
    kind: 'push',
    empty: NETWORK_LINK_UNKNOWN,
  },
  /**
   * Runtime-state slice — every provider stores the same shape under
   * `device.runtimeState['network-link']`, read once by the badge and the
   * Home Assistant projector regardless of the driver.
   */
  runtimeState: NetworkLinkStatusSchema,
  /**
   * Runtime-state durability: **restored** — a link reading is slow to
   * change and a sleeping battery camera may not report for hours; the
   * restored slice is what the badge shows until the next read.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series.
   */
  history: {
    fields: {
      signalPercent: { kind: 'gauge', unit: '%', deadband: 3, minIntervalMs: 60000 },
      rssiDbm: { kind: 'gauge', unit: 'dBm', deadband: 2, minIntervalMs: 60000 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastUpdated'],
} as const satisfies CapabilityDefinition

export type INetworkLinkProvider = InferProvider<typeof networkLinkCapability>
