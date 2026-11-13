import { z } from 'zod'
import {
  EventCategory,
  createEvent,
  eventEmitterCapability,
  eventTypesOfVocabulary,
  findVocabularyEntry,
  plainEventVocabulary,
  type ConfigUISchemaWithValues,
  type DeviceContext,
  type EventEmitterStatus,
  type EventFire,
  type EventVocabularyEntry,
  type InferNativeProvider,
} from '@camstack/types'
import type { ValueChangedEvent } from 'nodehomematic'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { buttonEventsSection } from './hm-button-events-section.js'
import { publishKeyLinkStates, storedKeyLinkStates } from './hm-key-link-states.js'
import { HmChildDevice, hmChildSchema } from './hm-child-device.js'
import {
  HM_KEY_PRESS_DATAPOINTS,
  HM_KEY_PRESS_SET,
  channelIndexFromAddress,
  coldEventEmitter,
} from './hm-cold-start.js'
import { hmKeyChannels, hmKeyVocabulary } from './hm-key-vocabulary.js'

/** Shown on the Buttons child when none of its key channels has a central link. */
export const BUTTON_EVENTS_HINT =
  "The CCU does not send these presses — turn them on in this device's Button events section"

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
  /** Key channels that have delivered a press since this process started. */
  readonly #pressSeen = new Set<string>()
  /** True once we know a key channel lacks a central link. */
  #centralLinkMissing = false
  #eventSeq = 0
  #eventCount = 0
  /** Unsubscribe for the integration's state-change fan-out. */
  #snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    super(ctx, hmEventEmitterSchema)
    const persisted = this.config.values.eventTypes
    this.persistedEventTypes =
      persisted && persisted.length > 0 ? persisted : HM_KEY_PRESS_DATAPOINTS
    this.registerEventEmitterCap()
    this.attachValueChangedListener((event) => this.decodeKeyPress(event))
    // A child restored before its CCU enumerated the devices starts on the
    // persisted tokens. The session reports every state change (started,
    // connected) on this fan-out, so the buttons land the moment the CCU
    // answers, not at the first press.
    if (this.integrationId !== undefined) {
      this.#snapshotUnsub = homematicFacades.onSnapshot(this.integrationId, () => {
        this.refreshDeclaredVocabulary()
        void this.refreshCentralLinks()
      })
    }
    void this.refreshCentralLinks()
  }

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    return {
      sections: buttonEventsSection(
        this.integrationId,
        storedKeyLinkStates(this.integrationId, this.address),
      ),
    }
  }

  /**
   * Rewrite the slice with the buttons once the CCU's channel list carries
   * them. A no-op while it does not, and after the buttons were declared.
   */
  private refreshDeclaredVocabulary(): void {
    if (this.#declared !== null) return
    this.vocabulary()
    if (this.#declared === null) return
    const published = this.publishedVocabulary()
    const current = this.runtimeState.getCapState<EventEmitterStatus>('event-emitter')
    this.runtimeState.setCapState('event-emitter', {
      eventTypes: eventTypesOfVocabulary(published),
      vocabulary: [...published],
      lastEvent: current?.lastEvent ?? null,
      eventCountSinceStart: current?.eventCountSinceStart ?? 0,
    })
  }

  /** The live vocabulary, plus the central-link hint when the CCU sends nothing. */
  private publishedVocabulary(): readonly EventVocabularyEntry[] {
    const vocabulary = this.vocabulary()
    if (!this.#centralLinkMissing) return vocabulary
    return vocabulary.map((entry) => ({ ...entry, description: BUTTON_EVENTS_HINT }))
  }

  /**
   * Ask the facade whether each key channel has a central link. A read that
   * fails leaves the hint as it was: a failed read is not evidence the CCU is
   * silent.
   */
  private async refreshCentralLinks(): Promise<void> {
    const facade =
      this.integrationId === undefined ? null : homematicFacades.get(this.integrationId)
    const device = this.resolveHmDevice()
    if (facade === null || device === null || this.integrationId === undefined) return
    const loaded = await publishKeyLinkStates(this.integrationId, {
      facade,
      device,
      deviceAddress: this.address,
      deviceId: this.ctx.id,
      logger: this.ctx.logger,
    })
    // A failed read is not evidence the CCU is silent: the hint stays as it was.
    if (loaded === null || loaded.failed) return
    const states = storedKeyLinkStates(this.integrationId, this.address)
    const missing = states.some((state) => state.central === false)
    if (missing === this.#centralLinkMissing) return
    this.#centralLinkMissing = missing
    const current = this.runtimeState.getCapState<EventEmitterStatus>('event-emitter')
    const published = this.publishedVocabulary()
    this.runtimeState.setCapState('event-emitter', {
      eventTypes: eventTypesOfVocabulary(published),
      vocabulary: [...published],
      lastEvent: current?.lastEvent ?? null,
      eventCountSinceStart: current?.eventCountSinceStart ?? 0,
    })
  }

  override async removeDevice(): Promise<void> {
    this.#snapshotUnsub?.()
    this.#snapshotUnsub = null
    await super.removeDevice()
  }

  private registerEventEmitterCap(): void {
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>('event-emitter') ??
        coldEventEmitter(this.vocabulary()),
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
    this.runtimeState.setCapState('event-emitter', coldEventEmitter(this.publishedVocabulary()))
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

  private keyChannelAddresses(): ReadonlySet<string> {
    const device = this.resolveHmDevice()
    if (device === null) return new Set()
    return new Set(hmKeyChannels(device).map((channel) => channel.address))
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
    const isPress = HM_KEY_PRESS_SET.has(parameter)
    const isKey = isPress || this.keyChannelAddresses().has(channel)
    if (!isKey) return
    // A press is the datapoint asserting; the matching reset (value false) is
    // not a new press. One debug line per received PRESS_*. A key-channel
    // value that decodes to nothing is logged too (D391).
    const accepted = isPress && !(typeof value === 'boolean' && value === false)
    if (!accepted) {
      this.ctx.logger.debug('Homematic key channel value changed but decoded to no press', {
        tags: { deviceId: this.ctx.id },
        meta: { channel, parameter, ...(isPress ? { press: parameter } : {}) },
      })
      return
    }
    this.ctx.logger.debug('Homematic key press received', {
      tags: { deviceId: this.ctx.id },
      meta: { channel, press: parameter },
    })
    if (!this.#pressSeen.has(channel)) {
      this.#pressSeen.add(channel)
      this.ctx.logger.info('Homematic key channel delivered its first press since start', {
        tags: { deviceId: this.ctx.id },
        meta: { channel, press: parameter },
      })
    }

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

    const vocabulary = this.publishedVocabulary()
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
