/**
 * WHO an action step acts on (D983) — one target shape for every place that
 * performs an action (automation steps, Action entries, notification
 * sequences, scheduler points):
 *
 *  - `devices` — device ids the operator picked, frozen at save time;
 *  - `domain`  — every device that offers the step's VOCABULARY action,
 *    optionally narrowed to one device type and one room, resolved WHEN THE
 *    STEP RUNS (a device added later is included). The action always comes
 *    from the vocabulary (`cover.open`), never from a raw cap name, so a
 *    `domain` target needs an `actionId` (enforced on the step schema);
 *  - `var`     — a `$var` resolved from the run's scope.
 *
 * {@link ActionTargetResolver} turns a target into device ids. It is pure
 * (a {@link DeviceDirectory} is handed in) so the hub's core-blocks service and
 * a generated automation block share it.
 *
 * A room is the device's `location` label (`DeviceInfo.location`); two labels
 * name the same room when `locationIconKey` agrees (trimmed, lower-cased).
 */
import { z } from 'zod'
import { findVocabAction } from '../device/cap-vocabulary/action-index.js'
import { DeviceType } from '../device/device-type.js'
import { locationIconKey } from '../device/location-icon.js'
import { EventCategory } from '../enums/event-category.js'
import type { IScopedLogger } from '../interfaces/logging.js'

export const ActionTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('devices'),
    ids: z.array(z.number().int()).min(1),
  }),
  z.object({
    kind: z.literal('domain'),
    /** Narrow to one kind of device. */
    deviceType: z.enum(DeviceType).optional(),
    /** Narrow to one room: the `location` label devices carry. */
    roomId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('var'),
    name: z.string().min(1),
  }),
])
export type ActionTarget = z.infer<typeof ActionTargetSchema>

/** What a resolver needs to know about one device. */
export interface DirectoryDevice {
  readonly id: number
  readonly type: DeviceType
  /** The room label, `null` when unset. */
  readonly location: string | null
  readonly disabled: boolean
}

/**
 * The device registry as the resolver sees it. `listDeviceIdsByCaps` is the
 * per-binding walk (D12/D13) done where the bindings live; `listDevices`
 * reads the listed devices' type and room.
 */
export interface DeviceDirectory {
  listDeviceIdsByCaps(capNames: readonly string[]): Promise<readonly number[]>
  listDevices(deviceIds: readonly number[]): Promise<readonly DirectoryDevice[]>
}

/** The events after which a cached domain is stale. */
export const ACTION_TARGET_INVALIDATION_EVENTS: readonly EventCategory[] = [
  EventCategory.DeviceRegistered,
  EventCategory.DeviceUnregistered,
  EventCategory.DeviceUpdated,
  EventCategory.DeviceMetaChanged,
  EventCategory.DeviceBindingsChanged,
]

/** The result of resolving a target. */
export interface ResolvedTarget {
  readonly deviceIds: readonly number[]
  /** Set when nothing matched — the reason, for the trace. */
  readonly emptyReason?: string
}

/** Who asked, for the log line of an empty resolution. */
export interface ResolveOrigin {
  readonly actionId: string | undefined
  /** The automation / action / scheduler the step belongs to. */
  readonly owner: string | undefined
}

/** The bag `var` targets read from. */
export type TargetVars = Readonly<Record<string, unknown>>

function describeTarget(target: ActionTarget, actionId: string | undefined): string {
  if (target.kind === 'devices') return `devices ${target.ids.join(',')}`
  if (target.kind === 'var') return `var ${target.name}`
  const parts = [
    actionId ?? 'no action',
    ...(target.deviceType === undefined ? [] : [`type ${target.deviceType}`]),
    ...(target.roomId === undefined ? [] : [`room ${target.roomId}`]),
  ]
  return `domain (${parts.join(', ')})`
}

export class ActionTargetResolver {
  /** cap name → its devices, until a registry event says otherwise. */
  private readonly byCap = new Map<string, Promise<readonly DirectoryDevice[]>>()

  constructor(
    private readonly directory: DeviceDirectory,
    private readonly logger: IScopedLogger,
  ) {}

  /** Forget every cached domain (a device was added, removed, moved or re-bound). */
  invalidate(): void {
    this.byCap.clear()
  }

  private devicesOfCap(cap: string): Promise<readonly DirectoryDevice[]> {
    const cached = this.byCap.get(cap)
    if (cached !== undefined) return cached
    const read = (async (): Promise<readonly DirectoryDevice[]> => {
      const ids = await this.directory.listDeviceIdsByCaps([cap])
      return ids.length === 0 ? [] : await this.directory.listDevices(ids)
    })()
    this.byCap.set(cap, read)
    // A failed read is not cached. An invalidation that lands while a read is
    // in flight clears the entry, so that read's answer is never reused.
    read.catch(() => {
      if (this.byCap.get(cap) === read) this.byCap.delete(cap)
    })
    return read
  }

  /**
   * The devices `target` means for `actionId` right now. An EMPTY answer is
   * logged and carries its reason — the caller traces it; it is never silent.
   * Throws when the target cannot be resolved at all (an unknown action, a
   * `var` that is not a device id).
   */
  async resolve(
    target: ActionTarget,
    actionId: string | undefined,
    vars: TargetVars,
    origin: ResolveOrigin,
  ): Promise<ResolvedTarget> {
    if (target.kind === 'devices') return { deviceIds: target.ids }
    if (target.kind === 'var') {
      const raw = vars[target.name]
      if (typeof raw === 'number') return { deviceIds: [raw] }
      throw new Error(`action target var "${target.name}" is not a device id`)
    }
    if (actionId === undefined) {
      throw new Error('a domain target needs the vocabulary action it applies to')
    }
    const found = findVocabAction(actionId)
    if (found === undefined) throw new Error(`unknown vocabulary action "${actionId}"`)
    const room = target.roomId === undefined ? undefined : locationIconKey(target.roomId)
    const devices = await this.devicesOfCap(found.cap)
    const deviceIds = devices
      .filter(
        (d) =>
          !d.disabled &&
          (target.deviceType === undefined || d.type === target.deviceType) &&
          (room === undefined || (d.location !== null && locationIconKey(d.location) === room)),
      )
      .map((d) => d.id)
      .toSorted((a, b) => a - b)
    if (deviceIds.length > 0) return { deviceIds }
    const emptyReason = `${describeTarget(target, actionId)} matched no device`
    this.logger.warn(`action target resolved to no devices — ${emptyReason}`, {
      meta: {
        ...(origin.actionId === undefined ? {} : { actionId: origin.actionId }),
        ...(origin.owner === undefined ? {} : { owner: origin.owner }),
        vocabularyAction: actionId,
      },
    })
    return { deviceIds: [], emptyReason }
  }
}
