import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Generic boolean sensor — last-resort fallback when no domain-
 * specific binary cap fits (Home Assistant `binary_sensor` without a
 * known `device_class`, or a domain we haven't typed yet). Pure
 * pass-through: just the bool + timestamp. Push-driven.
 *
 * Prefer the typed alternatives (`contact`, `flood`, `smoke`,
 * `carbon-monoxide`, `gas`, `tamper`, `vibration`, `connectivity`,
 * `motion`) when the semantics match — export adapters render those
 * with the right HomeKit / Alexa display category.
 */
export const BinaryStatusSchema = z.object({
  on: z.boolean().meta({ label: 'On' }),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type BinaryStatus = z.infer<typeof BinaryStatusSchema>

export const binaryCapability = {
  name: 'binary',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: BinaryStatusSchema,
    kind: 'push',
  },
  runtimeState: BinaryStatusSchema,

  /**
   * Runtime-state durability: **restored** — transition-driven sensor state; the restored value gives the boot comparison.
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
      on: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IBinaryProvider = InferProvider<typeof binaryCapability>
