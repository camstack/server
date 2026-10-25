import { z } from 'zod'
import {
  EventCategory,
  createEvent,
  eventEmitterCapability,
  type DeviceContext,
  type EventEmitterStatus,
  type EventFire,
  type InferNativeProvider,
} from '@camstack/types'
import type { ValueChangedEvent } from 'nodehomematic'
import { HmChildDevice, hmChildSchema } from './hm-child-device.js'
import {
  HM_KEY_PRESS_DATAPOINTS,
  HM_KEY_PRESS_SET,
  channelIndexFromAddress,
  coldEventEmitter,
} from './hm-cold-start.js'

/**
 * Event-emitter child config: the persisted native press vocabulary for the
 * device's key channels. Stored at adoption so the cap advertises the right
 * verbatim tokens before the first push; falls back to the standard HmIP set.
 */
export const hmEventEmitterSchema = hmChildSchema.extend({
  eventTypes: z.array(z.string()).optional(),
})

export type HmEventEmitterConfig = z.infer<typeof hmEventEmitterSchema>

/**
 * ONE Homematic event-emitter accessory child collapsing all of a device's key
 * channels (HmIP-WRC* wall switches / HmIP-RC* remotes / KEY channels). The
 * event vocabulary is the verbatim union of the channels' native `PRESS_*`
 * datapoints (persisted in config at adoption). Presses fire
 * `EventCategory.EventEmitted` with the button index (`:N` channel suffix) in
 * `data.channel` — lifted VERBATIM from the legacy flat device.
 */
export class HmEventEmitterDevice extends HmChildDevice<typeof hmEventEmitterSchema> {
  private readonly eventTypes: readonly string[]
  #eventSeq = 0
  #eventCount = 0

  constructor(ctx: DeviceContext) {
    super(ctx, hmEventEmitterSchema)
    const persisted = this.config.values.eventTypes
    this.eventTypes = persisted && persisted.length > 0 ? persisted : HM_KEY_PRESS_DATAPOINTS
    this.registerEventEmitterCap()
    this.attachValueChangedListener((event) => this.decodeKeyPress(event))
  }

  private registerEventEmitterCap(): void {
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>('event-emitter') ??
        coldEventEmitter(this.eventTypes),
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
    this.runtimeState.setCapState('event-emitter', coldEventEmitter(this.eventTypes))
  }

  /**
   * Translate a key-channel `PRESS_*` datapoint into an `EventFire`: emit
   * `EventCategory.EventEmitted` on the bus and write the `event-emitter`
   * slice. The `eventType` is the native datapoint name VERBATIM; the button
   * index (`:N` suffix of the channel address) travels in `data.channel`.
   * Non-key datapoints and value resets are ignored.
   */
  private decodeKeyPress(event: ValueChangedEvent): void {
    const now = event.ts || Date.now()
    const { parameter, value, channel } = event
    if (!HM_KEY_PRESS_SET.has(parameter)) return
    // A press is the datapoint asserting; the matching reset (value false) is
    // not a new press. ACTION-style key datapoints carry boolean true on press.
    if (typeof value === 'boolean' && value === false) return

    const channelIndex = channelIndexFromAddress(channel)
    const fire: EventFire = {
      deviceId: this.id,
      eventType: parameter, // native datapoint name — VERBATIM
      data: channelIndex !== null ? { channel: channelIndex } : {},
      timestamp: now,
      seq: ++this.#eventSeq,
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
      eventTypes: [...this.eventTypes],
      lastEvent: fire,
      eventCountSinceStart: ++this.#eventCount,
    }
    this.runtimeState.setCapState('event-emitter', slice)
  }
}
