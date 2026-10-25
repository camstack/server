import { z } from 'zod'
import {
  BaseDevice,
  eventEmitterCapability,
  createEvent,
  EventCategory,
  type DeviceContext,
  type DeviceFeature,
  type InferNativeProvider,
  type EventEmitterStatus,
  type EventFire,
} from '@camstack/types'

/**
 * Persisted config for the per-broker HA bus-event aggregator. It is NOT
 * entity-backed (no `entityId`), so it does NOT extend the HA child base
 * device — it is a thin standalone `BaseDevice` subclass.
 */
export const haEventBusDeviceSchema = z.object({
  system: z.literal('homeassistant'),
  brokerId: z.string(),
  kind: z.literal('event-bus'),
})

export type HaEventBusDeviceConfig = z.infer<typeof haEventBusDeviceSchema>

/** A single HA bus event routed onto the aggregator — eventType + verbatim
 *  data payload, NO normalization. */
export interface HaBusEvent {
  readonly eventType: string
  readonly data: Record<string, unknown> | null
}

/**
 * Case 2 — generic per-broker HA bus-event aggregator.
 *
 * Home Assistant fires arbitrary events on its bus (e.g. ZHA remotes fire
 * `zha_event` with complex `{device_ieee, command, args, ...}` payloads).
 * These have NO entity and NO declared vocabulary. Rather than synthesise
 * one device per emitter, every curated bus event for a broker is
 * aggregated onto a SINGLE generic `EventEmitter` device with an OPEN
 * vocabulary (`eventTypes: []`).
 *
 * DESIGN RULE — NO normalization. The complex payload is carried verbatim
 * in `lastEvent.data`; the `eventType` is the raw HA bus event type token
 * (e.g. `'zha_event'`).
 *
 * Unlike the Case-1 `HaEventEmitterDevice`, this device is NOT driven by
 * `broker.message` entity pushes — the addon routes bus events to it
 * directly via {@link handleBusEvent} (the integration manager subscribes
 * to the curated bus event types and threads each fire through the addon).
 */
export class HaEventBusDevice extends BaseDevice<typeof haEventBusDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  /** Monotonic sequence — two identical events still produce distinct slice
   *  writes / bus emissions. */
  #seq = 0

  /** Count of bus events observed since this device instance started. */
  #count = 0

  constructor(ctx: DeviceContext) {
    super(ctx, haEventBusDeviceSchema, { type: ctx.deviceMeta.type })
    this.online = true
    void this.updateSourceInfo({ id: this.stableId, system: 'homeassistant' })
  }

  override async onActivate(): Promise<void> {
    // registerNativeCap BEFORE setCapState so the cap's runtime-state
    // schema is installed before the seed write.
    this.registerEventEmitterCap()
    const seed: EventEmitterStatus = {
      eventTypes: [], // OPEN vocabulary — bus events have no declared set.
      lastEvent: null,
      eventCountSinceStart: 0,
    }
    this.runtimeState.setCapState('event-emitter', seed)
    await super.onActivate()
  }

  /**
   * Route one curated HA bus event onto this aggregator. Builds an
   * {@link EventFire} (eventType + verbatim data), emits it on the bus so
   * subscribers (UI event stream, advanced-notifier) react without holding a
   * cap reference, and writes the `event-emitter` runtime-state slice with the
   * new `lastEvent` + incremented `eventCountSinceStart`. Vocabulary stays `[]`.
   */
  handleBusEvent(event: HaBusEvent): void {
    const fire: EventFire = {
      deviceId: this.id,
      eventType: event.eventType, // VERBATIM — raw HA bus event type
      data: event.data, // VERBATIM — complex payload, NO normalization
      timestamp: Date.now(),
      seq: ++this.#seq,
    }

    this.ctx.eventBus.emit(
      createEvent(
        EventCategory.EventEmitted,
        {
          type: 'device',
          id: this.stableId,
          deviceId: this.id,
          addonId: this.ctx.deviceMeta.addonId,
        },
        fire,
      ),
    )

    const slice: EventEmitterStatus = {
      eventTypes: [], // OPEN vocabulary — never narrows.
      lastEvent: fire,
      eventCountSinceStart: ++this.#count,
    }
    this.runtimeState.setCapState('event-emitter', slice)
  }

  private registerEventEmitterCap(): void {
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () => this.readSlice(),
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
  }

  private readSlice(): EventEmitterStatus {
    return (
      this.runtimeState.getCapState<EventEmitterStatus>('event-emitter') ?? {
        eventTypes: [],
        lastEvent: null,
        eventCountSinceStart: 0,
      }
    )
  }
}
