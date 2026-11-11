import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { EventVocabularyEntrySchema } from './event-vocabulary.js'

/**
 * Generic stateless event emitter. Installed on a `DeviceType.EventEmitter`
 * device. Carries the device's EXACT declared event vocabulary verbatim
 * (NO normalization). Two shapes:
 *  - structured source (HA `event.*` entity) → `vocabulary` is the fixed
 *    declared set (e.g. press_short, press_long, …).
 *  - generic/legacy source (HA bus events, e.g. zha_event) → `vocabulary`
 *    is [] (open) and `lastEvent.data` carries the complex payload.
 * `vocabulary` (D1044) names each event for a person and types it for a
 * rule; `eventTypes` is its list of native tokens, kept for older readers.
 * A fire names the part of the device it came from in `sourceId` when the
 * vocabulary declares sources (a remote's buttons).
 * `seq` is monotonic so two identical events still produce distinct slice writes.
 */
export const EventFireSchema = z.object({
  deviceId: z.number(),
  eventType: z.string(),
  sourceId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).nullable(),
  timestamp: z.number().meta(readingMeta('none')),
  seq: z.number().meta(readingMeta('count')),
})
export type EventFire = z.infer<typeof EventFireSchema>

export const EventEmitterStatusSchema = z.object({
  eventTypes: z.array(z.string()),
  /**
   * Required of a provider by the type. A status written before the field
   * existed still parses, as an empty vocabulary: read it through
   * `readEventVocabulary`, which then answers with the plain tokens.
   */
  vocabulary: z.array(EventVocabularyEntrySchema).default([]),
  lastEvent: EventFireSchema.nullable(),
  eventCountSinceStart: z.number().meta(readingMeta('count')),
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
