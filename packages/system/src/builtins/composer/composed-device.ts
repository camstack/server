/**
 * A composed device: an ordinary `BaseDevice` whose caps are served by the
 * composer (D659). Every consumer (exporters, NC, UI, HomeKit) reads it
 * through its bindings, unchanged.
 *
 * It serves NO command method: slice 1 refuses any cap with one
 * (`has-commands`), and commands arrive with `forward` in slice 3. So each
 * composed cap is registered with an EMPTY native provider, and `getStatus`
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
import {
  BaseDevice,
  type CapabilityDefinition,
  type DeviceConstructor,
  type DeviceContext,
  type DeviceFeature,
  type DeviceType,
  errMsg,
  type IDevice,
  motionCapability,
} from '@camstack/types'
import { z } from 'zod'
import type { ComposedWriteTarget, WriteOutcome } from './composition-runtime.js'
import type { SlicePatch } from './slice-assembler.js'

const COMPOSED_DEVICE_CONFIG_SCHEMA: z.ZodObject<Record<string, never>> = z.object({})

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
}

export class ComposedDevice
  extends BaseDevice<typeof COMPOSED_DEVICE_CONFIG_SCHEMA>
  implements ComposedDeviceHandle
{
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext, type: DeviceType, caps: readonly CapabilityDefinition[]) {
    super(ctx, COMPOSED_DEVICE_CONFIG_SCHEMA, { type })
    // No command, and `getStatus` is the kernel default over the runtime slice (see the header).
    // Motion's `isDetected` is a slice answer (D944): the group reads `detected`.
    for (const cap of caps) {
      if (cap.name === motionCapability.name) {
        const read = (): unknown => this.runtimeState.getCapState(motionCapability.name)
        ctx.registerNativeCap(motionCapability, {
          isDetected: async () => sliceBoolean(read(), 'detected'),
        })
        continue
      }
      ctx.registerNativeCap(cap, {})
    }
    // NOT presumed reachable: available only once the runtime has seeded every cap.
    this.markOnline(false)
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
