import { z } from 'zod'
import {
  BaseDevice,
  createEvent,
  DeviceType,
  EventCategory,
  eventEmitterCapability,
  type DeviceContext,
  type EventEmitterStatus,
  type EventFire,
  type InferNativeProvider,
} from '@camstack/types'
import { eventActive } from '../home-connect-domain-mapping.js'
import { homeConnectConnections, type HomeConnectWatchEvent } from '../home-connect-gateway.js'

export const homeConnectEventSchema = z.object({
  haId: z.string().min(1),
  brokerId: z.string().min(1),
  system: z.literal('home-connect').optional(),
  integrationId: z.string().optional(),
})

export type HomeConnectEventConfig = z.infer<typeof homeConnectEventSchema>

const EVENT_CAP = 'event-emitter'

/**
 * The appliance's events (`<event>` entities: salt low, rinse aid low, program finished,
 * aborted, …) as the generic event emitter: the vocabulary is the event feature keys of
 * the description, verbatim, and an event fires when it is RAISED.
 *
 * A value seen while the link is still being established (the handshake's initial values)
 * is the baseline, not a new event: a reconnect must not announce "program finished" again.
 */
export class HomeConnectEventDevice extends BaseDevice<typeof homeConnectEventSchema> {
  readonly features = [] as const

  readonly #haId: string
  readonly #brokerId: string
  /** Edge detector: was this event raised the last time we looked? Not part of any slice. */
  readonly #raised = new Map<string, boolean>()
  #seq = 0
  #unwatch: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = homeConnectEventSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeConnectEventSchema, { type: DeviceType.EventEmitter })
    this.#haId = persisted.haId
    this.#brokerId = persisted.brokerId
    void this.updateSourceInfo({ id: `${this.#haId}:events`, system: 'home-connect' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCap()
    this.publish(this.eventTypes(), this.runtimeState.getCapState<EventEmitterStatus>(EVENT_CAP))
    this.#unwatch = homeConnectConnections.watch(this.#brokerId, this.#haId, (e) =>
      this.onChange(e),
    )
  }

  override async removeDevice(): Promise<void> {
    this.#unwatch?.()
    this.#unwatch = null
    await super.removeDevice()
  }

  private eventTypes(): readonly string[] {
    const description = homeConnectConnections.getClient(this.#brokerId)?.getDescription(this.#haId)
    return (description?.entities() ?? []).filter((e) => e.kind === 'event').map((e) => e.name)
  }

  private publish(
    eventTypes: readonly string[],
    previous: EventEmitterStatus | null | undefined,
    lastEvent?: EventFire,
  ): void {
    this.runtimeState.setCapState(EVENT_CAP, {
      eventTypes: [...eventTypes],
      lastEvent: lastEvent ?? previous?.lastEvent ?? null,
      eventCountSinceStart:
        (previous?.eventCountSinceStart ?? 0) + (lastEvent !== undefined ? 1 : 0),
    } satisfies EventEmitterStatus)
  }

  private onChange(event: HomeConnectWatchEvent): void {
    const client = homeConnectConnections.getClient(this.#brokerId)
    const previous = this.runtimeState.getCapState<EventEmitterStatus>(EVENT_CAP)
    const types = this.eventTypes()
    const connected = client !== null && client.getLinkState(this.#haId) === 'connected'
    if (client !== null && !connected && event.kind === 'feature' && types.includes(event.key)) {
      // The handshake is still delivering the initial values: that is the baseline.
      const baseline = eventActive(client.getFeatures(this.#haId).get(event.key))
      if (baseline !== null) this.#raised.set(event.key, baseline)
      return
    }
    if (client === null || !connected) {
      this.#raised.clear()
      this.markOnline(false)
      return
    }
    this.markOnline(true)
    if (event.kind !== 'feature' || !types.includes(event.key)) {
      this.publish(types, previous)
      return
    }
    const value = client.getFeatures(this.#haId).get(event.key)
    const active = eventActive(value)
    const wasRaised = this.#raised.get(event.key) === true
    if (active !== null) this.#raised.set(event.key, active)
    if (active !== true || wasRaised) {
      this.publish(types, previous)
      return
    }
    const entity = client.getDescription(this.#haId)?.entityByName(event.key)
    const fire: EventFire = {
      deviceId: this.id,
      eventType: event.key,
      data: {
        value: typeof value === 'string' ? value : null,
        ...(entity?.level !== undefined ? { level: entity.level } : {}),
        ...(entity?.handling !== undefined ? { handling: entity.handling } : {}),
      },
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
    this.publish(types, previous, fire)
  }

  private registerCap(): void {
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>(EVENT_CAP) ?? {
          eventTypes: [],
          lastEvent: null,
          eventCountSinceStart: 0,
        },
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
  }
}
