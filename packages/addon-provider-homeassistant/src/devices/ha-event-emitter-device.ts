import {
  eventEmitterCapability,
  createEvent,
  EventCategory,
  type DeviceContext,
  type InferNativeProvider,
  type EventEmitterStatus,
  type EventFire,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

/**
 * HA-backed CamStack event-emitter device. Materialised on adoption of
 * any HA `event.*` entity (one per button channel) — `mappedTo`
 * `capabilities` contains `event-emitter`.
 *
 * Case 1 (structured, 1:1): the entity declares a FIXED event
 * vocabulary in `attributes.event_types` and reports the most-recent
 * token in `attributes.event_type`. The entity `state` is the ISO
 * timestamp of the last fire, advancing on every press.
 *
 * DESIGN RULE — NO normalization. The device carries the EXACT
 * vocabulary the HA entity declares, and each fire reports the raw
 * `event_type` token verbatim.
 *
 * On every state push whose timestamp ADVANCED (a real fire) and that
 * carries an `event_type`, the device:
 *   - emits an `event-emitter.event` ({@link EventFire}) on the bus so
 *     subscribers (UI event stream, advanced-notifier) react without
 *     holding a cap reference; and
 *   - writes the `event-emitter` runtime-state slice with the new
 *     `lastEvent` + incremented `eventCountSinceStart`.
 *
 * `data` is always `null` for Case 1 (pure structured events); the
 * complex-payload Case 2 (HA bus events such as `zha_event`) is deferred.
 */
export class HaEventEmitterDevice extends HaBaseChildDevice {
  /**
   * Fixed event vocabulary the HA entity declares, captured VERBATIM.
   * Seeded from the persisted adoption config (`eventTypes`) and kept
   * current from each push's `attributes.event_types` — the live entity
   * is the authoritative source of its own vocabulary. NO normalization.
   */
  private eventTypes: readonly string[]

  /** Monotonic sequence — two identical events still produce distinct
   *  slice writes / bus emissions. */
  #seq = 0

  /** Count of real fires observed since this device instance started. */
  #count = 0

  /** ISO timestamp string of the last fire we acted on. A push whose
   *  state equals this is an attribute-only update (or a replay) — not a
   *  new fire — and is skipped. Null until the first fire. */
  #lastFireState: string | null = null

  /** False until the first push lands. The first push is the broker
   *  cache-replay (the entity's CURRENT state at subscribe time), not a
   *  live press — we establish the baseline timestamp + vocabulary from
   *  it but never emit a fire for it. */
  #baselineEstablished = false

  constructor(ctx: DeviceContext) {
    super(ctx)
    this.eventTypes = readEventTypes(ctx.persistedConfig)
  }

  override async onActivate(): Promise<void> {
    // registerNativeCap BEFORE setCapState so the cap's runtime-state
    // schema is installed before the seed write (the broker cache-replay
    // only fires later, in super.onActivate → subscribeBrokerEntity).
    this.registerEventEmitterCap()
    const seed: EventEmitterStatus = {
      eventTypes: [...this.eventTypes],
      lastEvent: null,
      eventCountSinceStart: 0,
    }
    this.runtimeState.setCapState('event-emitter', seed)
    await super.onActivate()
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return

    // Refresh the declared vocabulary from the live entity (the entity is
    // the authoritative source — verbatim, NO normalization). HA carries
    // `event_types` on every push's attribute bag.
    const declared = readEventTypesFromAttributes(state.attributes)
    if (declared !== null) this.eventTypes = declared

    // First push = broker cache-replay (entity's CURRENT state, not a live
    // press). Establish the baseline timestamp + refresh the seeded slice
    // with the now-known vocabulary, but never emit a fire for it.
    if (!this.#baselineEstablished) {
      this.#baselineEstablished = true
      this.#lastFireState = state.state
      if (declared !== null) {
        const refreshed: EventEmitterStatus = {
          eventTypes: [...this.eventTypes],
          lastEvent: null,
          eventCountSinceStart: this.#count,
        }
        this.runtimeState.setCapState('event-emitter', refreshed)
      }
      return
    }

    // Case 1 fire detection: `state` is the ISO timestamp of the last
    // fire. It only advances on a real press; an attribute-only update
    // leaves it unchanged → not a new fire.
    if (this.#lastFireState !== null && state.state === this.#lastFireState) return

    const eventType = readEventType(state.attributes)
    if (eventType === null) {
      // Timestamp advanced but no event_type token — record the new
      // baseline so a later genuine fire isn't mistaken for a repeat, but
      // emit nothing.
      this.#lastFireState = state.state
      return
    }

    this.#lastFireState = state.state

    const fire: EventFire = {
      deviceId: this.id,
      eventType, // VERBATIM — no mapping
      data: null,
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
      eventTypes: [...this.eventTypes],
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
        eventTypes: [...this.eventTypes],
        lastEvent: null,
        eventCountSinceStart: 0,
      }
    )
  }
}

/** Extract the verbatim `event_types` vocabulary from the persisted
 *  adoption config (captured from the HA entity's attributes at adopt
 *  time). Returns `[]` when absent. */
function readEventTypes(config: Record<string, unknown> | undefined): readonly string[] {
  if (!config) return []
  const raw = config['eventTypes']
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string')
}

/** Read the verbatim `event_type` token from a push's attribute bag, or
 *  null when absent / not a non-empty string. */
function readEventType(attributes: Record<string, unknown>): string | null {
  const raw = attributes['event_type']
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw
}

/** Read the verbatim `event_types` vocabulary array from a push's
 *  attribute bag, or null when absent / not an array. Returns the raw
 *  declared tokens (NO normalization). */
function readEventTypesFromAttributes(
  attributes: Record<string, unknown>,
): readonly string[] | null {
  const raw = attributes['event_types']
  if (!Array.isArray(raw)) return null
  return raw.filter((v): v is string => typeof v === 'string')
}
