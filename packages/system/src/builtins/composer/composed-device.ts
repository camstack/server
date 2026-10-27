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

const COMPOSED_DEVICE_CONFIG_SCHEMA: z.ZodObject<Record<string, never>> = z.object({})

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
}

export class ComposedDevice
  extends BaseDevice<typeof COMPOSED_DEVICE_CONFIG_SCHEMA>
  implements ComposedDeviceHandle
{
  private sharedFeatures: readonly DeviceFeature[] = []
  private extraCaps: ReadonlySet<string> = new Set()

  get features(): readonly DeviceFeature[] {
    return this.sharedFeatures
  }

  constructor(ctx: DeviceContext, type: DeviceType, caps: readonly CapabilityDefinition[]) {
    super(ctx, COMPOSED_DEVICE_CONFIG_SCHEMA, { type })
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
      ctx.registerNativeCap(cap, {})
    }
    if (GROUP_COMMAND_TYPES.has(type)) ctx.registerNativeCap(groupCommandsCapability, {})
    // NOT presumed reachable: available only once the runtime has seeded every cap.
    this.markOnline(false)
  }

  /**
   * Register or drop brightness and colour, and publish the shared colour
   * modes. Switch stays: it is the active state, registered with the device.
   */
  syncShared(caps: readonly string[], modes: readonly DeviceFeature[]): void {
    this.ensureExtra(brightnessCapability.name, caps.includes(brightnessCapability.name), () => {
      this.ctx.registerNativeCap(brightnessCapability, {
        setBrightness: async (input) => {
          await this.dispatch('brightness', 'setBrightness', { percentage: input.percentage })
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
        setPercentage: (input) =>
          call('fan-control', 'setPercentage', { percentage: input.percentage }),
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
        stop: () => call('media-player', 'stop', {}),
        next: () => call('media-player', 'next', {}),
        previous: () => call('media-player', 'previous', {}),
        seek: (input) => call('media-player', 'seek', { positionMs: input.positionMs }),
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
    try {
      this.runtimeState.setCapState(capName, { ...slice })
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) }
    }
  }

  patch(capName: string, patch: SlicePatch): WriteOutcome {
    try {
      this.runtimeState.patchCapState(capName, { ...patch })
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) }
    }
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
