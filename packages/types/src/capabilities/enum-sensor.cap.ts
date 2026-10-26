import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Enum-state sensor — a string value picked from a finite option set.
 * Drives HA `sensor` entries with `state_class: enum` (HVAC action
 * states, weather conditions, contact-source channels, mode strings).
 * The option set is stable across observations; it is persisted in the
 * device config blob (via the control slice at adoption) and is NOT
 * stored in `sourceInfo`.
 */
/** Locale-render shape for an ISO `value` carried by a `DateTimeSensor`-role
 *  enum sensor: `date` (date-only), `time` (time-only), `datetime` (both). */
export const EnumSensorDateTimeFormatSchema = z.enum(['date', 'time', 'datetime'])

export type EnumSensorDateTimeFormat = z.infer<typeof EnumSensorDateTimeFormatSchema>

export const EnumSensorStatusSchema = z.object({
  value: z.string(),
  /**
   * Set when `value` is a timestamp rather than an enum state, so history
   * does not learn ISO strings as states. The display shape (date / time /
   * datetime) lives on `SourceInfo.dateTimeShape`, written once at adopt.
   */
  timestamp: z.boolean().optional(),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})

export type EnumSensorStatus = z.infer<typeof EnumSensorStatusSchema>

export const enumSensorCapability = {
  name: 'enum-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: EnumSensorStatusSchema,
    kind: 'push',
  },
  runtimeState: EnumSensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor`; 80 devices.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): the value as an `enum` series (an appliance's program or
   * operation state, an HVAC action). The option set is per device, so the
   * value list is LEARNED as values are first seen (bounded). A sensor with a
   * `timestamp` carries a clock, not a state, and is not recorded.
   */
  history: { fields: { value: { kind: 'enum', skipWhenSet: 'timestamp' } } },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IEnumSensorProvider = InferProvider<typeof enumSensorCapability>
