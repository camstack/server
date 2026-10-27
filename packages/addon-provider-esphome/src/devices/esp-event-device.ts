import {
  EventCategory,
  createEvent,
  eventEmitterCapability,
  type DeviceContext,
  type EventEmitterStatus,
  type EventFire,
  type InferNativeProvider,
} from '@camstack/types'
import type { EspState } from '../esphome-link.js'
import { EspChildDevice, type EspStateOrigin } from './esp-child-device.js'

/**
 * An ESPHome `event` entity (a button or remote that reports presses). The event
 * types are the board's own strings, verbatim. A replay of the last known state
 * after a reconnect is not a press and never fires.
 */
export class EspEventDevice extends EspChildDevice {
  private readonly eventTypes: readonly string[]
  #seq = 0
  #count = 0

  constructor(ctx: DeviceContext) {
    super(ctx)
    this.eventTypes = this.child.eventTypes ?? []
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>('event-emitter') ?? this.cold(),
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
    this.runtimeState.setCapState('event-emitter', this.cold())
    this.attach()
  }

  private cold(): EventEmitterStatus {
    return { eventTypes: [...this.eventTypes], lastEvent: null, eventCountSinceStart: 0 }
  }

  protected ownedEntityIds(): readonly string[] {
    return this.child.entityId === undefined ? [] : [this.child.entityId]
  }

  protected applyState(state: EspState, origin: EspStateOrigin): void {
    if (state.type !== 'event' || origin === 'seed') return
    const eventType = state.eventType
    if (eventType === undefined || eventType.length === 0) return
    const fire: EventFire = {
      deviceId: this.id,
      eventType,
      data: {},
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
    this.runtimeState.setCapState('event-emitter', {
      eventTypes: [...this.eventTypes],
      lastEvent: fire,
      eventCountSinceStart: ++this.#count,
    })
  }
}
