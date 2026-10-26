import { registerUnraidAdminLink } from '../unraid-admin-link.js'
import { z } from 'zod'
import {
  BaseDevice,
  binaryCapability,
  type BinaryStatus,
  buttonCapability,
  createEvent,
  type DeviceContext,
  type DeviceFeature,
  enumSensorCapability,
  type EnumSensorStatus,
  errMsg,
  EventCategory,
  eventEmitterCapability,
  type EventEmitterStatus,
  type EventFire,
  type InferNativeProvider,
  numericSensorCapability,
  type NumericSensorStatus,
  type SwitchStatus,
  switchCapability,
  temperatureSensorCapability,
  type TemperatureSensorStatus,
} from '@camstack/types'
import type { UnraidClientLike, UnraidSnapshot } from '../unraid-client-contract.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import {
  type UnraidButtonAction,
  UnraidButtonActionSchema,
  buildEntityDescriptors,
  type UnraidEntityDescriptor,
  UnraidEntityKindSchema,
  findDescriptor,
} from '../unraid-mapping.js'

/**
 * Persisted config every Unraid entity child carries. `instanceId` selects the
 * parent instance's live client (the Hub `stableId`); `entityKey` matches the
 * descriptor produced by {@link buildEntityDescriptors}; `kind` + `capName`
 * decide which cap the child registers. `containerId` routes docker switches;
 * `action` routes buttons.
 */
export const unraidEntitySchema = z.object({
  instanceId: z.string().min(1).describe('Parent instance Hub stableId'),
  entityKey: z.string().min(1).describe('Stable entity key (matches the mapping)'),
  kind: UnraidEntityKindSchema,
  capName: z.string().min(1),
  containerId: z.string().optional(),
  action: UnraidButtonActionSchema.optional(),
  system: z.literal('unraid').optional(),
})

export type UnraidEntityConfig = z.infer<typeof unraidEntitySchema>

const EVENT_TYPE_NOTIFICATION_CREATED = 'notification_created'

const COLD_NUMERIC: NumericSensorStatus = { value: 0, lastFetchedAt: 0 }
const COLD_TEMPERATURE: TemperatureSensorStatus = { celsius: 0, lastFetchedAt: 0 }
const COLD_ENUM: EnumSensorStatus = { value: '', lastFetchedAt: 0 }
const COLD_BINARY: BinaryStatus = { on: false, lastChangedAt: 0 }
const COLD_SWITCH: SwitchStatus = { on: false, lastChangedAt: 0 }
const COLD_EVENT: EventEmitterStatus = {
  eventTypes: [EVENT_TYPE_NOTIFICATION_CREATED],
  lastEvent: null,
  eventCountSinceStart: 0,
}

/**
 * One Unraid entity as a CamStack accessory child. A CHILD of the instance
 * Container (standalone mode). A single generic class keyed by a discriminated
 * `kind` (numeric | temperature | enum | binary | switch | button | event) so
 * the whole surface stays compact + compiling. It registers EXACTLY ONE cap
 * (chosen from `kind`) and, on every instance poll tick, re-runs the pure
 * mapping over the live snapshot and writes its matching descriptor into the cap
 * slice. Docker switches + array/parity/restart buttons resolve the live client
 * from {@link unraidInstances}.
 */
export class UnraidEntityDevice extends BaseDevice<typeof unraidEntitySchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly instanceId: string
  private readonly entityKey: string
  private readonly kind: UnraidEntityConfig['kind']
  private readonly containerId: string | undefined
  private readonly action: UnraidButtonAction | undefined

  private snapshotUnsub: (() => void) | null = null
  private eventSeq = 0
  private eventCount = 0
  private lastFiredNotificationId: string | null = null

  constructor(ctx: DeviceContext) {
    const cfg = unraidEntitySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unraidEntitySchema, { type: ctx.deviceMeta.type })
    this.instanceId = cfg.instanceId
    this.entityKey = cfg.entityKey
    this.kind = cfg.kind
    this.containerId = cfg.containerId
    this.action = cfg.action
    this.online = unraidInstances.getSnapshot(this.instanceId) !== null
    void this.updateSourceInfo({ id: `${this.instanceId}:${this.entityKey}`, system: 'unraid' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCap()
    // device-admin-link — an entity child (array status, a Docker switch, a
    // share) is configured in the same WebGUI as its server.
    registerUnraidAdminLink(this.ctx, this.id, { kind: 'instance', instanceId: this.instanceId })
    this.attachSnapshotListener()
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
    if (this.snapshotUnsub) {
      try {
        this.snapshotUnsub()
      } catch {
        // best-effort
      }
      this.snapshotUnsub = null
    }
    await super.removeDevice()
  }

  /** Subscribe to per-instance poll ticks. No-ops on a missing snapshot and
   *  replays once the Hub pumps the first snapshot. */
  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('unraid entity: snapshot handler error', {
          meta: { entityKey: this.entityKey, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = unraidInstances.onSnapshot(this.instanceId, onSnapshot)
  }

  private resolveClient(): UnraidClientLike {
    const client = unraidInstances.getManager(this.instanceId)?.client ?? null
    if (client === null) {
      throw new Error(
        `unraid entity ${this.entityKey}: instance ${this.instanceId} client is not available`,
      )
    }
    return client
  }

  private currentDescriptor(snapshot: UnraidSnapshot): UnraidEntityDescriptor | null {
    return findDescriptor(buildEntityDescriptors(snapshot), this.entityKey)
  }

  // ── Slice recompute ─────────────────────────────────────────────────────

  /** Recompute + write this entity's cap slice from the live snapshot. */
  private recomputeSlice(): void {
    const snapshot = unraidInstances.getSnapshot(this.instanceId)
    if (snapshot === null) return
    if (!this.online) this.markOnline(true)

    if (this.kind === 'event') {
      this.recomputeEvent(snapshot)
      return
    }

    const descriptor = this.currentDescriptor(snapshot)
    if (descriptor === null) return
    const now = Date.now()

    switch (this.kind) {
      case 'numeric': {
        const numeric = descriptor.numeric
        if (numeric === undefined) return
        const slice: NumericSensorStatus = { value: numeric.value, lastFetchedAt: now }
        if (this.sourceInfo.quantity !== numeric.quantity) {
          void this.updateSourceInfo({ quantity: numeric.quantity })
        }
        this.runtimeState.setCapState(numericSensorCapability.name, slice)
        return
      }
      case 'temperature': {
        if (descriptor.celsius === undefined) return
        const slice: TemperatureSensorStatus = { celsius: descriptor.celsius, lastFetchedAt: now }
        this.runtimeState.setCapState(temperatureSensorCapability.name, slice)
        return
      }
      case 'enum': {
        if (descriptor.enumValue === undefined) return
        const slice: EnumSensorStatus = { value: descriptor.enumValue, lastFetchedAt: now }
        this.runtimeState.setCapState(enumSensorCapability.name, slice)
        return
      }
      case 'binary': {
        if (descriptor.binary === undefined) return
        const slice: BinaryStatus = { on: descriptor.binary, lastChangedAt: now }
        this.runtimeState.setCapState(binaryCapability.name, slice)
        return
      }
      case 'switch': {
        if (descriptor.switchOn === undefined) return
        const slice: SwitchStatus = { on: descriptor.switchOn, lastChangedAt: now }
        this.runtimeState.setCapState(switchCapability.name, slice)
        return
      }
      case 'button':
        // Fire-only — no slice.
        return
    }
  }

  /** Fire a `notification_created` event when the latest notification changes. */
  private recomputeEvent(snapshot: UnraidSnapshot): void {
    const latest = snapshot.notifications.latest
    if (latest === null || latest.id === this.lastFiredNotificationId) return
    this.lastFiredNotificationId = latest.id
    const now = Date.now()
    const fire: EventFire = {
      deviceId: this.id,
      eventType: EVENT_TYPE_NOTIFICATION_CREATED,
      data: {
        id: latest.id,
        title: latest.title,
        subject: latest.subject,
        description: latest.description,
        importance: latest.importance,
      },
      timestamp: now,
      seq: ++this.eventSeq,
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
      eventTypes: [EVENT_TYPE_NOTIFICATION_CREATED],
      lastEvent: fire,
      eventCountSinceStart: ++this.eventCount,
    }
    this.runtimeState.setCapState(eventEmitterCapability.name, slice)
  }

  // ── Cap registration ────────────────────────────────────────────────────

  private registerCap(): void {
    switch (this.kind) {
      case 'numeric':
        this.registerNumericCap()
        return
      case 'temperature':
        this.registerTemperatureCap()
        return
      case 'enum':
        this.registerEnumCap()
        return
      case 'binary':
        this.registerBinaryCap()
        return
      case 'switch':
        this.registerSwitchCap()
        return
      case 'button':
        this.registerButtonCap()
        return
      case 'event':
        this.registerEventCap()
        return
    }
  }

  private registerNumericCap(): void {
    const provider: InferNativeProvider<typeof numericSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<NumericSensorStatus>(numericSensorCapability.name) ??
        COLD_NUMERIC,
    }
    this.ctx.registerNativeCap(numericSensorCapability, provider)
    this.runtimeState.setCapState(numericSensorCapability.name, COLD_NUMERIC)
  }

  private registerTemperatureCap(): void {
    const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<TemperatureSensorStatus>(temperatureSensorCapability.name) ??
        COLD_TEMPERATURE,
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, provider)
    this.runtimeState.setCapState(temperatureSensorCapability.name, COLD_TEMPERATURE)
  }

  private registerEnumCap(): void {
    const provider: InferNativeProvider<typeof enumSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EnumSensorStatus>(enumSensorCapability.name) ?? COLD_ENUM,
    }
    this.ctx.registerNativeCap(enumSensorCapability, provider)
    this.runtimeState.setCapState(enumSensorCapability.name, COLD_ENUM)
  }

  private registerBinaryCap(): void {
    const provider: InferNativeProvider<typeof binaryCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<BinaryStatus>(binaryCapability.name) ?? COLD_BINARY,
    }
    this.ctx.registerNativeCap(binaryCapability, provider)
    this.runtimeState.setCapState(binaryCapability.name, COLD_BINARY)
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(switchCapability.name) ?? COLD_SWITCH,
      setState: async ({ on }) => {
        const containerId = this.containerId
        if (containerId === undefined) {
          throw new Error(`unraid switch ${this.entityKey}: no container id bound`)
        }
        const client = this.resolveClient()
        if (on) await client.docker.start(containerId)
        else await client.docker.stop(containerId)
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState(switchCapability.name, COLD_SWITCH)
  }

  private registerButtonCap(): void {
    const provider: InferNativeProvider<typeof buttonCapability> = {
      press: async () => {
        await this.dispatchButton()
      },
    }
    this.ctx.registerNativeCap(buttonCapability, provider)
  }

  private registerEventCap(): void {
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>(eventEmitterCapability.name) ??
        COLD_EVENT,
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
    this.runtimeState.setCapState(eventEmitterCapability.name, COLD_EVENT)
  }

  /** Resolve the live client and run the persisted button action. */
  private async dispatchButton(): Promise<void> {
    const action = this.action
    if (action === undefined) {
      throw new Error(`unraid button ${this.entityKey}: no action bound`)
    }
    const client = this.resolveClient()
    switch (action.type) {
      case 'start-array':
        await client.array.setState('START')
        return
      case 'stop-array':
        await client.array.setState('STOP')
        return
      case 'start-parity':
        await client.array.parity.start(false)
        return
      case 'stop-parity':
        await client.array.parity.cancel()
        return
      case 'restart-container':
        // The Unraid API has no atomic restart — stop then start (mirrors reality).
        await client.docker.stop(action.containerId)
        await client.docker.start(action.containerId)
        return
    }
  }
}
