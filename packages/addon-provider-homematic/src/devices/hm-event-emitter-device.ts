import { z } from 'zod'
import {
  EventCategory,
  createEvent,
  eventEmitterCapability,
  eventTypesOfVocabulary,
  findVocabularyEntry,
  plainEventVocabulary,
  type DeviceContext,
  type EventEmitterStatus,
  type EventFire,
  type EventVocabularyEntry,
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
import { hmKeyVocabulary } from './hm-key-vocabulary.js'

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
 * event vocabulary is one source per key channel with that channel's native
 * `PRESS_*` datapoints, verbatim (`hm-key-vocabulary.ts`). Presses fire
 * `EventCategory.EventEmitted` with the button index (`:N` channel suffix)
 * as `sourceId`.
 */
export class HmEventEmitterDevice extends HmChildDevice<typeof hmEventEmitterSchema> {
  /** The tokens persisted at adoption: the vocabulary of last resort. */
  private readonly persistedEventTypes: readonly string[]
  /** The vocabulary read from the CCU's channel list, once it answered. */
  #declared: readonly EventVocabularyEntry[] | null = null
  /** Fires already reported as outside the vocabulary, as `source:token`. */
  readonly #undeclaredLogged = new Set<string>()
  #eventSeq = 0
  #eventCount = 0

  constructor(ctx: DeviceContext) {
    super(ctx, hmEventEmitterSchema)
    const persisted = this.config.values.eventTypes
    this.persistedEventTypes =
      persisted && persisted.length > 0 ? persisted : HM_KEY_PRESS_DATAPOINTS
    this.registerEventEmitterCap()
    this.attachValueChangedListener((event) => this.decodeKeyPress(event))
  }

  private registerEventEmitterCap(): void {
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>('event-emitter') ??
        coldEventEmitter(this.vocabulary()),
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
    this.runtimeState.setCapState('event-emitter', coldEventEmitter(this.vocabulary()))
  }

  /**
   * The buttons and their presses, read LIVE from the CCU's channel list.
   *
   * Not from the child's config: that is written once, at adoption, so a
   * remote adopted before the vocabulary existed would never get its
   * buttons. While the CCU has not answered, the persisted tokens stand in,
   * with no button; the next write after it answers carries the buttons.
   */
  private vocabulary(): readonly EventVocabularyEntry[] {
    if (this.#declared !== null) return this.#declared
    const device = this.resolveHmDevice()
    const live = device === null ? [] : hmKeyVocabulary(device)
    if (live.length === 0) return plainEventVocabulary(this.persistedEventTypes)
    this.#declared = live
    return live
  }

  /** A press the vocabulary does not declare is delivered, and said once. */
  private noteUndeclared(
    vocabulary: readonly EventVocabularyEntry[],
    eventType: string,
    sourceId: string | null,
  ): void {
    if (this.#declared === null) return
    if (findVocabularyEntry(vocabulary, eventType, sourceId ?? undefined) !== undefined) return
    const key = `${sourceId ?? ''}:${eventType}`
    if (this.#undeclaredLogged.has(key)) return
    this.#undeclaredLogged.add(key)
    this.ctx.logger.warn('Homematic press is not in the declared event vocabulary', {
      tags: { deviceId: this.ctx.id },
      meta: { address: this.address, eventType, sourceId },
    })
  }

  /**
   * Translate a key-channel `PRESS_*` datapoint into an `EventFire`: emit
   * `EventCategory.EventEmitted` on the bus and write the `event-emitter`
   * slice. The `eventType` is the native datapoint name VERBATIM; the button
   * index (`:N` suffix of the channel address) is the fire's `sourceId`, and
   * stays in `data.channel` for readers older than the vocabulary.
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
      ...(channelIndex !== null ? { sourceId: channelIndex } : {}),
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

    const vocabulary = this.vocabulary()
    this.noteUndeclared(vocabulary, parameter, channelIndex)
    const slice: EventEmitterStatus = {
      eventTypes: eventTypesOfVocabulary(vocabulary),
      vocabulary: [...vocabulary],
      lastEvent: fire,
      eventCountSinceStart: ++this.#eventCount,
    }
    this.runtimeState.setCapState('event-emitter', slice)
  }
}
