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
  colorCapability,
  type DeviceConstructor,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  errMsg,
  groupCommandsCapability,
  GroupCommandResultSchema,
  type GroupCommandResult,
  type IDevice,
  motionCapability,
  type ReadingQuantity,
  switchCapability,
} from '@camstack/types'
import { z } from 'zod'
import type { ComposedWriteTarget, WriteOutcome } from './composition-runtime.js'
import type { SlicePatch } from './slice-assembler.js'

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
    if (type === DeviceType.Switch || type === DeviceType.Light) {
      ctx.registerNativeCap(groupCommandsCapability, {})
    }
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
    this.sharedFeatures = [...modes]
    void this.refreshFeatures()
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
