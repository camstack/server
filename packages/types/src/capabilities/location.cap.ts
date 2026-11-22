import { z } from 'zod'
import { t } from '../device/cap-vocabulary/l10n.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import type { CapabilityDefinition, InferProvider } from './capability-definition.js'

/**
 * Where a device is — the raw WGS84 fix a source reports, for any device that
 * can know it (a vehicle now, a phone tracker or a GPS collar later). The cap
 * is generic on purpose, like `consumables`: it binds on every DeviceType.
 *
 * It is NOT `presence`. `presence.state` is a zone VERDICT (`home`, `not_home`,
 * a zone name) the source derived, typed to `DeviceType.Presence`; a car has
 * coordinates and no zone. `location` is the fix, `presence` the verdict.
 *
 * Unknown is `null`, never `0` (D393): both coordinates null means no fix is
 * known, and a provider builds its status through `locationFix` so one
 * coordinate is never written without the other.
 */
export const LocationStatusSchema = z.object({
  /** WGS84 decimal degrees. Null = no fix known; never 0. */
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .nullable()
    .meta(readingMeta('angle', { label: 'Latitude' })),
  /** WGS84 decimal degrees. Null = no fix known; never 0. */
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .nullable()
    .meta(readingMeta('angle', { label: 'Longitude' })),
  /** Radius of uncertainty, metres. Null = the source does not say. */
  accuracy: z
    .number()
    .nonnegative()
    .nullable()
    .meta(readingMeta('length', { label: 'Accuracy' })),
  /** Course over ground, degrees clockwise from north, 0..360. Null = unknown. */
  heading: z
    .number()
    .min(0)
    .max(360)
    .nullable()
    .meta(readingMeta('angle', { label: 'Heading' })),
  /** Ground speed, m/s. Null = unknown. */
  speed: z
    .number()
    .nonnegative()
    .nullable()
    .meta(readingMeta('speed', { label: 'Speed' })),
  /** Ms epoch the FIX was taken, as the source reports it. Null = unknown. */
  fixAt: z.number().nullable(),
  /** Ms epoch the status last changed. */
  lastChangedAt: z.number(),
})
export type LocationStatus = z.infer<typeof LocationStatusSchema>

/** Seed status: no fix known. */
export function emptyLocationStatus(now: number = 0): LocationStatus {
  return {
    latitude: null,
    longitude: null,
    accuracy: null,
    heading: null,
    speed: null,
    fixAt: null,
    lastChangedAt: now,
  }
}

/** What a provider knows about one fix. Every field but `now` may be absent. */
export interface LocationFixInput {
  readonly latitude?: number | null
  readonly longitude?: number | null
  readonly accuracy?: number | null
  readonly heading?: number | null
  readonly speed?: number | null
  readonly fixAt?: number | null
  readonly now: number
}

/**
 * Build a status from one fix. The pair is atomic: a missing or out-of-range
 * coordinate drops BOTH, so a reader never sees a latitude with no longitude.
 * Any other out-of-range field is dropped alone (it becomes null).
 */
export function locationFix(input: LocationFixInput): LocationStatus {
  const latitude = input.latitude ?? null
  const longitude = input.longitude ?? null
  const pairValid =
    latitude !== null &&
    longitude !== null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  const accuracy = input.accuracy ?? null
  const heading = input.heading ?? null
  const speed = input.speed ?? null
  return {
    latitude: pairValid ? latitude : null,
    longitude: pairValid ? longitude : null,
    accuracy: accuracy !== null && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
    heading:
      heading !== null && Number.isFinite(heading) && heading >= 0 && heading <= 360
        ? heading
        : null,
    speed: speed !== null && Number.isFinite(speed) && speed >= 0 ? speed : null,
    fixAt: input.fixAt ?? null,
    lastChangedAt: input.now,
  }
}

export const locationCapability = {
  name: 'location',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  // Device-agnostic (the `consumables` precedent): any device may know where it
  // is, so the cap binds on EVERY DeviceType and no future type drifts out.
  deviceTypes: Object.values(DeviceType),
  methods: {},
  status: {
    schema: LocationStatusSchema,
    kind: 'push',
    empty: emptyLocationStatus(),
  },
  runtimeState: LocationStatusSchema.extend({ lastFetchedAt: z.number() }),
  /**
   * Runtime-state durability: **restored** — the last fix is the only record of
   * where a parked vehicle is until its source next answers (D642). A restored
   * fix is the previous observation, not a claim about now; `fixAt` says when.
   */
  durability: 'restored',
  /**
   * History (D850): latitude and longitude are two change-only series; a reader
   * rebuilding a track step-holds each. 0.0002 degrees is about 22 m of latitude,
   * so a parked car's GPS jitter records nothing. `accuracy`, `heading` and
   * `fixAt` are not recorded, and there is no `primary` (a latitude trend on a
   * card means nothing). Recording follows the device-history default, with the
   * per-device opt-out.
   */
  history: {
    fields: {
      latitude: {
        group: 'position',
        kind: 'gauge',
        unit: '°',
        deadband: 0.0002,
        displayName: 'Latitude',
      },
      longitude: {
        group: 'position',
        kind: 'gauge',
        unit: '°',
        deadband: 0.0002,
        displayName: 'Longitude',
      },
      speed: { kind: 'gauge', unit: 'm/s', deadband: 0.5, displayName: 'Speed' },
    },
  },
  /** Clocks, not content: a re-read that moved nothing costs no commit. */
  volatileStateFields: ['fixAt', 'lastChangedAt', 'lastFetchedAt'],
  vocabulary: { noun: t('Location', 'Posizione'), order: 2180 },
} as const satisfies CapabilityDefinition

export type ILocationProvider = InferProvider<typeof locationCapability>
