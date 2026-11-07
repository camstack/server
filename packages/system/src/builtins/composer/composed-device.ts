/**
 * A composed device: an ordinary `BaseDevice` whose caps are served by the
 * composer (D659). Every consumer (exporters, NC, UI, HomeKit) reads it
 * through its bindings, unchanged.
 *
 * A reading group serves no command. An actuator helper's `switch` (and, on
 * a light, `brightness` / `color` when every member binds them) fans the
 * call out through `actuatorDispatcher` (D944). `getStatus`
 * (R4) is the kernel's: `registerNativeCap` installs a default that reads the
 * device's runtime slice for any cap declaring both `status` and
 * `runtimeState` (`device-cap-proxy.ts`, "Default `getStatus`"), on the
 * registry path and the forked-runner (UDS) path alike. Every composable cap
 * qualifies: the validator refuses a cap with no `runtimeState`
 * (`validate-composition.ts`, `not-composable`). The default is correct only
 * because, for every composable cap, `status.schema` and `runtimeState` have
 * one shape — `composed-device.spec.ts` enumerates the real cap registry and
 * fails the day one breaks it (slice 3 lifting `has-commands` makes
 * `recording-signal` such a cap). `room-device.e2e.spec.ts` proves R4 through
 * the real registry. Its type comes from the declaration, not from
 * `deviceMeta`: a failed meta read builds a device as `generic`, and the
 * declaration is the authority for what this device is.
 */
import { actuatorDispatcher, type ActuatorDispatchInput } from './actuator-dispatch.js'
import {
  BaseDevice,
  brightnessCapability,
  type CapabilityDefinition,
  climateControlCapability,
  colorCapability,
  type ConsumableItem,
  ConsumableItemSchema,
  consumablesCapability,
  coverCapability,
  type DeviceConstructor,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  errMsg,
  fanControlCapability,
  groupCommandsCapability,
  GroupCommandResultSchema,
  type GroupCommandResult,
  type IDevice,
  lockControlCapability,
  mediaPlayerCapability,
  motionCapability,
  PET_FOUNTAIN_WATER_KEY,
  petFountainCapability,
  PetFountainStatusSchema,
  petFountainWaterItem,
  type ReadingQuantity,
  switchCapability,
  valveCapability,
} from '@camstack/types'
import { z } from 'zod'
import type { ComposedWriteTarget, WriteOutcome } from './composition-runtime.js'
import type { SlicePatch } from './slice-assembler.js'

/** Device types a helper actuator group can be: they keep the last fan-out per member. */
const GROUP_COMMAND_TYPES: ReadonlySet<DeviceType> = new Set([
  DeviceType.Switch,
  DeviceType.Light,
  DeviceType.Fan,
  DeviceType.Cover,
  DeviceType.Valve,
  DeviceType.Lock,
  DeviceType.MediaPlayer,
  DeviceType.Thermostat,
  DeviceType.Climate,
])

/** A call's arguments without the keys the caller left undefined. */
function present(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}

/** What the derived water item reads from the `pet-fountain` slice, and the clock it is stamped with. */
const TANK_READING = PetFountainStatusSchema.pick({
  waterLevel: true,
  empty: true,
  lastFetchedAt: true,
})
type TankReading = z.infer<typeof TANK_READING>

const COMPOSED_DEVICE_CONFIG_SCHEMA: z.ZodObject<Record<string, never>> = z.object({})

type CommandProvider = Readonly<Record<string, (input: unknown) => Promise<void>>>

/** What a command carries: the caller's input without `deviceId` (the composed device is the dispatch key). */
function commandInput(input: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(input)) return {}
  return present(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'deviceId')))
}

function priorResults(slice: unknown): readonly GroupCommandResult[] {
  if (!isRecord(slice) || !Array.isArray(slice.results)) return []
  return slice.results.flatMap((row) => {
    const parsed = GroupCommandResultSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unknown is a throw, never `false` (D393). */
function sliceBoolean(slice: unknown, field: string): boolean {
  if (isRecord(slice)) {
    const value = slice[field]
    if (typeof value === 'boolean') return value
  }
  throw new Error(`composed ${field} is unknown — not a stand-in value`)
}

export interface ComposedDeviceHandle extends ComposedWriteTarget {
  readonly name: string
  /** Copies a source reading's quantity onto this device (D944). Optional so test doubles stay small. */
  adoptQuantity?(quantity: ReadingQuantity): Promise<void>
  /** Publishes the features the device's bound caps stand for (`featuresOfBoundCaps`). Optional so test doubles stay small. */
  syncBoundFeatures?(features: readonly DeviceFeature[]): void
}

export class ComposedDevice
  extends BaseDevice<typeof COMPOSED_DEVICE_CONFIG_SCHEMA>
  implements ComposedDeviceHandle
{
  private sharedFeatures: readonly DeviceFeature[] = []
  /** Features of caps bound on the device by others (a wrapper): derived from its bindings, never listed here. */
  private boundFeatures: readonly DeviceFeature[] = []
  private extraCaps: ReadonlySet<string> = new Set()
  /** Whether this device's tank is also a `water` consumable (derived, never bound). */
  private readonly derivesWater: boolean
  /** The `consumables` items the composition last wrote — the derived water item is added to these. */
  private composedItems: readonly ConsumableItem[] = []

  get features(): readonly DeviceFeature[] {
    return [...new Set([...this.sharedFeatures, ...this.boundFeatures])]
  }

  syncBoundFeatures(features: readonly DeviceFeature[]): void {
    const same =
      features.length === this.boundFeatures.length &&
      features.every((feature) => this.boundFeatures.includes(feature))
    if (same) return
    this.boundFeatures = [...features]
    void this.refreshFeatures()
  }

  constructor(ctx: DeviceContext, type: DeviceType, caps: readonly CapabilityDefinition[]) {
    super(ctx, COMPOSED_DEVICE_CONFIG_SCHEMA, { type })
    this.derivesWater = type === DeviceType.PetFountain
    // Motion's `isDetected` is a slice answer (D944): the group reads `detected`.
    // Switch fans a command out. Every other composed cap stays an empty native;
    // `getStatus` is the kernel default over the runtime slice.
    for (const cap of caps) {
      if (cap.name === motionCapability.name) {
        const read = (): unknown => this.runtimeState.getCapState(motionCapability.name)
        ctx.registerNativeCap(motionCapability, {
          isDetected: async () => sliceBoolean(read(), 'detected'),
        })
        continue
      }
      if (cap.name === switchCapability.name) {
        ctx.registerNativeCap(switchCapability, {
          setState: async (input) => {
            await this.dispatch('switch', 'setState', { on: input.on })
          },
        })
        continue
      }
      ctx.registerNativeCap(cap, this.commandProvider(cap))
    }
    if (GROUP_COMMAND_TYPES.has(type)) ctx.registerNativeCap(groupCommandsCapability, {})
    // The tank is a consumable of every fountain, even one built without a
    // maintenance entity: the cap exists so the derived item has somewhere to live.
    if (this.derivesWater && !caps.some((cap) => cap.name === consumablesCapability.name)) {
      ctx.registerNativeCap(consumablesCapability, {
        reset: (input) => this.dispatch('consumables', 'reset', commandInput(input)),
      })
    }
    // NOT presumed reachable: available only once the runtime has seeded every cap.
    this.markOnline(false)
  }

  /**
   * The methods of a BUILT cap are commands (D967): each one is dispatched under
   * its own name and the composer's forwards decide what it calls. A method the
   * cap refuses for a composed device (`consumables.reset`) is served the same
   * way — an item's `reset` forward answers it. A cap with no such method stays
   * an empty native, `getStatus` being the kernel default over the slice.
   */
  private commandProvider(cap: CapabilityDefinition): CommandProvider {
    const forwarded = Object.entries(cap.methods)
      .filter(([name, method]) => {
        if (method.systemOnly === true) return false
        const answer = cap.composedMethods?.[name]
        return answer === undefined || answer.kind === 'refuse'
      })
      .map(([name]) => name)
    return Object.fromEntries(
      forwarded.map((name) => [
        name,
        (input: unknown): Promise<void> => this.dispatch(cap.name, name, commandInput(input)),
      ]),
    )
  }

  /**
   * Register or drop brightness and colour, and publish the shared colour
   * modes. Switch stays: it is the active state, registered with the device.
   */
  syncShared(caps: readonly string[], modes: readonly DeviceFeature[]): void {
    this.ensureExtra(brightnessCapability.name, caps.includes(brightnessCapability.name), () => {
      this.ctx.registerNativeCap(brightnessCapability, {
        setBrightness: async (input) => {
          await this.dispatch('brightness', 'setBrightness', { level: input.level })
        },
      })
    })
    this.ensureExtra(colorCapability.name, caps.includes(colorCapability.name), () => {
      this.ctx.registerNativeCap(colorCapability, {
        setColor: async (input) => {
          await this.dispatch('color', 'setColor', { color: input.color })
        },
      })
    })
    this.syncTypedCaps(caps)
    this.sharedFeatures = [...modes]
    void this.refreshFeatures()
  }

  /**
   * The type's own cap (a cover's `cover`, a lock's `lock-control`) is
   * registered only for a helper group, so a free composition of the same type
   * keeps serving nothing it did not before. Every method fans out; the group
   * refuses the ones its members do not all share.
   */
  private syncTypedCaps(caps: readonly string[]): void {
    const call = (cap: string, method: string, args: Readonly<Record<string, unknown>>) =>
      this.dispatch(cap, method, present(args))
    this.ensureExtra(fanControlCapability.name, caps.includes(fanControlCapability.name), () => {
      this.ctx.registerNativeCap(fanControlCapability, {
        setPercentage: (input) => call('fan-control', 'setPercentage', { speed: input.speed }),
        setPreset: (input) => call('fan-control', 'setPreset', { preset: input.preset }),
        setDirection: (input) =>
          call('fan-control', 'setDirection', { direction: input.direction }),
        setOscillating: (input) =>
          call('fan-control', 'setOscillating', { oscillating: input.oscillating }),
      })
    })
    this.ensureExtra(coverCapability.name, caps.includes(coverCapability.name), () => {
      this.ctx.registerNativeCap(coverCapability, {
        open: () => call('cover', 'open', {}),
        close: () => call('cover', 'close', {}),
        stop: () => call('cover', 'stop', {}),
        setPosition: (input) => call('cover', 'setPosition', { position: input.position }),
        setTiltPosition: (input) =>
          call('cover', 'setTiltPosition', { tiltPosition: input.tiltPosition }),
      })
    })
    this.ensureExtra(valveCapability.name, caps.includes(valveCapability.name), () => {
      this.ctx.registerNativeCap(valveCapability, {
        open: () => call('valve', 'open', {}),
        close: () => call('valve', 'close', {}),
        stop: () => call('valve', 'stop', {}),
        setPosition: (input) => call('valve', 'setPosition', { position: input.position }),
      })
    })
    this.ensureExtra(lockControlCapability.name, caps.includes(lockControlCapability.name), () => {
      this.ctx.registerNativeCap(lockControlCapability, {
        lock: (input) => call('lock-control', 'lock', { code: input.code }),
        unlock: (input) =>
          call('lock-control', 'unlock', { code: input.code, confirm: input.confirm }),
        open: () => call('lock-control', 'open', {}),
      })
    })
    this.ensureExtra(mediaPlayerCapability.name, caps.includes(mediaPlayerCapability.name), () => {
      this.ctx.registerNativeCap(mediaPlayerCapability, {
        play: () => call('media-player', 'play', {}),
        pause: () => call('media-player', 'pause', {}),
        setVolume: (input) => call('media-player', 'setVolume', { volumeLevel: input.volumeLevel }),
        // Not in the group's method table: the group refuses them by name.
        turnOn: () => call('media-player', 'turnOn', {}),
        turnOff: () => call('media-player', 'turnOff', {}),
        volumeUp: (input) => call('media-player', 'volumeUp', { steps: input.steps }),
        volumeDown: (input) => call('media-player', 'volumeDown', { steps: input.steps }),
        channelUp: (input) => call('media-player', 'channelUp', { steps: input.steps }),
        channelDown: (input) => call('media-player', 'channelDown', { steps: input.steps }),
        stop: () => call('media-player', 'stop', {}),
        next: () => call('media-player', 'next', {}),
        previous: () => call('media-player', 'previous', {}),
        seek: (input) => call('media-player', 'seek', { position: input.position }),
        setMute: (input) => call('media-player', 'setMute', { muted: input.muted }),
        setShuffle: (input) => call('media-player', 'setShuffle', { shuffle: input.shuffle }),
        setRepeat: (input) => call('media-player', 'setRepeat', { repeat: input.repeat }),
        selectSource: (input) => call('media-player', 'selectSource', { source: input.source }),
        playMedia: (input) =>
          call('media-player', 'playMedia', { mediaId: input.mediaId, mediaType: input.mediaType }),
      })
    })
    this.ensureExtra(
      climateControlCapability.name,
      caps.includes(climateControlCapability.name),
      () => {
        this.ctx.registerNativeCap(climateControlCapability, {
          setMode: (input) => call('climate-control', 'setMode', { mode: input.mode }),
          setTarget: (input) => call('climate-control', 'setTarget', { target: input.target }),
          setFanMode: (input) => call('climate-control', 'setFanMode', { fanMode: input.fanMode }),
          // Not in the group's method table: the group refuses them by name.
          setPreset: (input) => call('climate-control', 'setPreset', { preset: input.preset }),
          setTargetRange: (input) =>
            call('climate-control', 'setTargetRange', {
              targetLow: input.targetLow,
              targetHigh: input.targetHigh,
            }),
          setTargetHumidity: (input) =>
            call('climate-control', 'setTargetHumidity', { targetHumidity: input.targetHumidity }),
          setSwingVertical: (input) =>
            call('climate-control', 'setSwingVertical', { on: input.on }),
          setSwingHorizontal: (input) =>
            call('climate-control', 'setSwingHorizontal', { on: input.on }),
        })
      },
    )
  }

  /** Keep each member's latest attempt. A later command replaces that member only. */
  recordCommands(incoming: readonly GroupCommandResult[]): void {
    const prior = priorResults(this.runtimeState.getCapState(groupCommandsCapability.name))
    const byDevice = new Map<number, GroupCommandResult>(prior.map((row) => [row.deviceId, row]))
    for (const row of incoming) byDevice.set(row.deviceId, row)
    try {
      this.runtimeState.setCapState(groupCommandsCapability.name, {
        results: [...byDevice.values()],
      })
    } catch (err: unknown) {
      this.ctx.logger.error('actuator group could not store command results', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  private ensureExtra(capName: string, want: boolean, register: () => void): void {
    const has = this.extraCaps.has(capName)
    if (want && !has) {
      register()
      this.extraCaps = new Set([...this.extraCaps, capName])
      return
    }
    if (!want && has) {
      this.ctx.unregisterNativeCap?.(capName)
      this.extraCaps = new Set([...this.extraCaps].filter((name) => name !== capName))
    }
  }

  private async dispatch(
    cap: string,
    method: string,
    args: ActuatorDispatchInput['args'],
  ): Promise<void> {
    const run = actuatorDispatcher()
    if (run === null) {
      this.ctx.logger.warn('actuator group command was not sent — fan-out is not attached', {
        tags: { deviceId: this.id },
        meta: { cap, method },
      })
      throw new Error('actuator fan-out is not attached')
    }
    await run({ groupDeviceId: this.id, cap, method, args })
  }

  seed(capName: string, slice: SlicePatch): WriteOutcome {
    return this.writeSlice('seed', capName, slice)
  }

  patch(capName: string, patch: SlicePatch): WriteOutcome {
    return this.writeSlice('patch', capName, patch)
  }

  private writeSlice(op: 'seed' | 'patch', capName: string, slice: SlicePatch): WriteOutcome {
    const own = this.writeCap(
      op,
      capName,
      this.derivesWater ? this.withWater(capName, slice) : slice,
    )
    if (!own.ok || !this.derivesWater || capName !== petFountainCapability.name) return own
    return this.refreshWater()
  }

  private writeCap(op: 'seed' | 'patch', capName: string, slice: SlicePatch): WriteOutcome {
    try {
      if (op === 'seed') this.runtimeState.setCapState(capName, { ...slice })
      else this.runtimeState.patchCapState(capName, { ...slice })
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) }
    }
  }

  /**
   * The ONE place a fountain's tank becomes a consumable: the composition's own
   * `consumables` items plus a `water` item derived from the `pet-fountain` slice
   * (`petFountainWaterItem`). A composition that names its own `water` item keeps it.
   */
  private withWater(capName: string, slice: SlicePatch): SlicePatch {
    if (capName !== consumablesCapability.name) return slice
    const parsed = ConsumableItemSchema.array().safeParse(slice['items'])
    if (parsed.success) this.composedItems = parsed.data
    return { ...slice, items: this.itemsWithWater() }
  }

  private fountainTank(): TankReading | null {
    const tank = TANK_READING.safeParse(this.runtimeState.getCapState(petFountainCapability.name))
    return tank.success ? tank.data : null
  }

  private itemsWithWater(): readonly ConsumableItem[] {
    const tank = this.fountainTank()
    if (tank === null || this.composedItems.some((item) => item.key === PET_FOUNTAIN_WATER_KEY)) {
      return this.composedItems
    }
    return [...this.composedItems, petFountainWaterItem(tank)]
  }

  /** The fountain slice moved: re-publish the consumables with the new water item. */
  private refreshWater(): WriteOutcome {
    const tank = this.fountainTank()
    if (tank === null) return { ok: true }
    const known = this.runtimeState.getCapState(consumablesCapability.name)
    const items = this.itemsWithWater()
    if (known !== undefined && JSON.stringify(known['items']) === JSON.stringify(items)) {
      return { ok: true }
    }
    return this.writeCap(known === undefined ? 'seed' : 'patch', consumablesCapability.name, {
      items,
      lastChangedAt: tank.lastFetchedAt,
      lastFetchedAt: tank.lastFetchedAt,
    })
  }

  setAvailable(available: boolean): void {
    this.markOnline(available)
  }

  /** The chart unit of a statistic or a meter is the source reading's quantity (D944). */
  async adoptQuantity(quantity: ReadingQuantity): Promise<void> {
    if (this.sourceInfo.quantity === quantity) return
    await this.updateSourceInfo({ quantity })
  }
}

export function composedDeviceClass(
  type: DeviceType,
  caps: readonly CapabilityDefinition[],
): DeviceConstructor<ComposedDevice> {
  return class extends ComposedDevice {
    constructor(ctx: DeviceContext) {
      super(ctx, type, caps)
    }
  }
}

/**
 * A composed device kept alive by the withdrawal gate for a persisted row whose
 * block this process has not planned (yet): no caps, offline. Its type is the
 * ROW's (`deviceMeta.type`) — only ever adopted from an existing row, where the
 * row is canonical — because there is no plan to take one from.
 */
export class ComposedPlaceholderDevice extends ComposedDevice {
  constructor(ctx: DeviceContext) {
    super(ctx, ctx.deviceMeta.type, [])
  }
}

export function isComposedDevice(device: IDevice): device is ComposedDevice {
  return device instanceof ComposedDevice
}
