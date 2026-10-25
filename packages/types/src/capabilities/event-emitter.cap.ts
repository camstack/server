import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Generic stateless event emitter. Installed on a `DeviceType.EventEmitter`
 * device. Carries the device's EXACT declared event vocabulary verbatim
 * (NO normalization). Two shapes:
 *  - structured source (HA `event.*` entity) → `eventTypes` is the fixed
 *    declared vocabulary (e.g. ['press_short','press_long',...]).
 *  - generic/legacy source (HA bus events, e.g. zha_event) → `eventTypes`
 *    is [] (open) and `lastEvent.data` carries the complex payload.
 * `seq` is monotonic so two identical events still produce distinct slice writes.
 */
export const EventFireSchema = z.object({
  deviceId: z.number(),
  eventType: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  timestamp: z.number(),
  seq: z.number(),
})
export type EventFire = z.infer<typeof EventFireSchema>

export const EventEmitterStatusSchema = z.object({
  eventTypes: z.array(z.string()),
  lastEvent: EventFireSchema.nullable(),
  eventCountSinceStart: z.number(),
})
export type EventEmitterStatus = z.infer<typeof EventEmitterStatusSchema>

export const eventEmitterCapability = {
  name: 'event-emitter',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.EventEmitter],
  methods: {},
  events: { onEvent: { data: EventFireSchema } },
  status: { schema: EventEmitterStatusSchema, kind: 'push' },
  runtimeState: EventEmitterStatusSchema,

  /**
   * Runtime-state durability: **session** — `eventCountSinceStart` names its own scope.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — `eventCountSinceStart` resets with the addon; events live in ledgers.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IEventEmitterProvider = InferProvider<typeof eventEmitterCapability>
