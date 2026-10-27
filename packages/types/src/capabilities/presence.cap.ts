import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Presence cap. Models HA `person.*` and `device_tracker.*` entities
 * on `DeviceType.Presence`. Read-only — no setters: presence is
 * derived from upstream signals (mobile-app location, router DHCP
 * lease, Bluetooth beacon, manual zone change) and pushed into the
 * slice.
 *
 * `state` follows HA's canonical values — `home` / `not_home` /
 * `<zone-name>` for any other named zone. The zone name is freeform
 * because users define arbitrary zones (`work`, `gym`, `school`).
 *
 * GPS coordinates are nullable — tracker types without location
 * (Bluetooth scanner, MQTT presence) omit them. The presence of
 * GPS data is signaled by `DeviceFeature.PresenceGps` for fast
 * UI map-pin rendering.
 */

const GpsLocationSchema = z.object({
  /** Latitude in decimal degrees, -90..90. */
  latitude: z.number().min(-90).max(90).meta(readingMeta('angle')),
  /** Longitude in decimal degrees, -180..180. */
  longitude: z.number().min(-180).max(180).meta(readingMeta('angle')),
  /** Reported accuracy in meters (lower = better). */
  accuracyMeters: z.number().nonnegative().meta(readingMeta('length')),
})
export type GpsLocation = z.infer<typeof GpsLocationSchema>

export const PresenceStatusSchema = z.object({
  /** `home` / `not_home` / any user-defined zone name. */
  state: z.string(),
  /** Optional textual location label (zone name, city, address). Null
   *  when only the binary state is known. */
  location: z.string().nullable(),
  /** GPS coordinates when available. Null otherwise. */
  gps: GpsLocationSchema.nullable(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type PresenceStatus = z.infer<typeof PresenceStatusSchema>

export const presenceCapability = {
  name: 'presence',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Presence],
  methods: {},
  status: {
    schema: PresenceStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI presence card
   * reads `state` + `location` for the text label; iff `gps !== null`
   * the map pin is rendered (use `DeviceFeature.PresenceGps` for the
   * pre-fetch fast-path check).
   */
  runtimeState: PresenceStatusSchema,

  /**
   * Runtime-state durability: **restored** — occupancy-relevant: the restored state is what an occupancy rule compares the first post-restart observation against.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  history: 'none',
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IPresenceProvider = InferProvider<typeof presenceCapability>
