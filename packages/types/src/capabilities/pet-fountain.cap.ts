import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * Pet water-fountain cap. Models the telemetry and the control surface of a
 * circulating drinking fountain: how much water is in the tank, how much the
 * pet drank, whether the pump runs and on what duty cycle.
 *
 * It has no native vendor provider of its own: a fountain reaches CamStack as
 * a container of loose entities (a pump switch, two number boxes, a "filter
 * changed" button), and an operator BUILDS the device from them — a composed
 * device of this type (D659, D967). Every method is therefore a forward to ONE
 * method of ONE source entity, and every reading is a field derived from a
 * source entity; the provider-shaped interface below exists so the composed
 * device and any future native provider answer the same contract.
 *
 * Quantities are stored in the base unit of their kind (D944): volumes in
 * LITRES, durations in SECONDS, the tank level in percent. A source that
 * reports millilitres or minutes is converted in the composition's expression,
 * never here. Every reading may be `null`: a source that is offline or does
 * not report is unknown, never zero.
 *
 * The filter is not a field of this cap: it is an item of the `consumables`
 * cap on the same device (kind `wear`), reset by the same forward mechanism.
 */

export const PetFountainStatusSchema = z.object({
  /** Water in the tank, 0..100 (%). Null while the source has not reported. */
  waterLevel: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Water in the tank, in litres. Null while the source has not reported. */
  waterVolume: z.number().min(0).nullable().meta(readingMeta('volume')),
  /** True when the tank is empty. Null while unknown. */
  empty: z.boolean().nullable(),
  /** True while the pump is running. Null while unknown. */
  pumpRunning: z.boolean().nullable(),
  /** True when the pump works on an on/off duty cycle rather than continuously. */
  pumpIntervalEnabled: z.boolean().nullable(),
  /** How long the pump runs per cycle, in seconds. */
  pumpOnTime: z.number().min(0).nullable().meta(readingMeta('duration')),
  /** How long the pump rests per cycle, in seconds. */
  pumpOffTime: z.number().min(0).nullable().meta(readingMeta('duration')),
  /** Water drunk in the last drink, in litres. */
  lastDrink: z.number().min(0).nullable().meta(readingMeta('volume')),
  /** Water drunk in the current hour, in litres. */
  currentHourDrink: z.number().min(0).nullable().meta(readingMeta('volume')),
  /** Water drunk over the last 24 hours (rolling), in litres. */
  last24hDrink: z.number().min(0).nullable().meta(readingMeta('volume')),
  /** Water drunk since local midnight, in litres. */
  todayDrink: z.number().min(0).nullable().meta(readingMeta('volume')),
  /** Decoded fault message. Null means healthy; a non-null string is an active fault. */
  error: z.string().nullable(),
  /** Ms epoch when the slice was last refreshed. */
  lastFetchedAt: z.number(),
})

export type PetFountainStatus = z.infer<typeof PetFountainStatusSchema>

const DeviceIdSchema = z.number().int().nonnegative()
const MinutesSchema = z.number().int().min(0)

export const petFountainCapability = {
  name: 'pet-fountain',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.PetFountain],
  methods: {
    /** Start or stop the pump. */
    setPump: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** Switch the on/off duty cycle on or off (off = the pump runs continuously). */
    setPumpInterval: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** Set how many minutes the pump runs per cycle. */
    setPumpOnMinutes: method(
      z.object({ deviceId: DeviceIdSchema, minutes: MinutesSchema }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Set how many minutes the pump rests per cycle. */
    setPumpOffMinutes: method(
      z.object({ deviceId: DeviceIdSchema, minutes: MinutesSchema }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Clear the rolling daily consumption counters on the device. */
    resetDailyConsumption: method(z.object({ deviceId: DeviceIdSchema }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
  },
  status: {
    schema: PetFountainStatusSchema,
    kind: 'push',
  },
  /** Runtime-state slice — mirrored by the kernel; the hero card reads it whole. */
  runtimeState: PetFountainStatusSchema,

  /**
   * Runtime-state durability: **session** — live appliance state re-published on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /** History (D850): recorded series. */
  history: {
    fields: {
      waterLevel: { kind: 'gauge', unit: '%', deadband: 1 },
      waterVolume: { kind: 'gauge', unit: 'L' },
      todayDrink: { kind: 'gauge', unit: 'L' },
      last24hDrink: { kind: 'gauge', unit: 'L' },
    },
  },
} as const satisfies CapabilityDefinition

export type IPetFountainProvider = InferProvider<typeof petFountainCapability>
