/**
 * `switch` is the one on/off control of a device (D-power-switch, #462 P1).
 *
 * A device whose own cap carries a `power` hint (`*.cap.ts`, D4) — a
 * humidifier's `on`, a media player's `state`, a climate unit's `mode` —
 * gets its `switch` from its OWNER addon through this one helper, never from
 * a kernel scan or a hand-written second provider:
 *
 *  - `switch.getStatus` is computed from the owner's slice at READ time
 *    (D224): the power fact is stored once, in the owner's slice.
 *  - The `switch` runtime slice is a projection of that same fact, written
 *    only here and only when the derived value changes, so the state mirror,
 *    the hero and the exporters read one shape for every powered device.
 *  - A value the owner has not reported is `null`, never `false` (D393).
 *  - Turning a `mode` device on restores its last non-off mode (the hub
 *    mirror keeps it, `last-active-mode.ts`); with none known it refuses
 *    `no-last-mode` instead of guessing one.
 *
 * Guard: `scripts/check-power-hint.ts`.
 */
import type {
  CapabilityDefinition,
  CapabilityPowerHint,
  InferNativeProvider,
} from '../capabilities/capability-definition.js'
import { switchCapability, type SwitchStatus } from '../capabilities/switch.cap.js'
import type { DeviceContext } from './device-context.js'
import type { IDeviceRuntimeState } from './device-runtime-state.js'
import type { IScopedLogger } from '../interfaces/logging.js'

export type PowerSwitchRefusal = 'no-last-mode' | 'owner-method-missing'

export class PowerSwitchRefusedError extends Error {
  readonly reason: PowerSwitchRefusal

  constructor(reason: PowerSwitchRefusal, message: string) {
    super(message)
    this.name = 'PowerSwitchRefusedError'
    this.reason = reason
  }
}

/** The owner cap's provider, seen only through the method names its hint
 *  declares. */
export type PowerSwitchOwner = object

export type PowerSwitchState = Pick<
  IDeviceRuntimeState,
  'getCapState' | 'setCapState' | 'subscribeCap'
>

export interface PowerSwitchHost {
  readonly deviceId: number
  readonly runtimeState: PowerSwitchState
  readonly registerNativeCap: DeviceContext['registerNativeCap']
  /** The hub mirror of a slice (`deviceState.getCapSlice`); `null` when it
   *  has none or the read failed. */
  readonly readHubSlice: (capName: string) => Promise<Readonly<Record<string, unknown>> | null>
}

/** The one hub read the switch needs: the mirror of the owner's slice. */
export interface PowerSwitchHubApi {
  readonly deviceState: {
    readonly getCapSlice: {
      query(input: { deviceId: number; capName: string }): Promise<Record<string, unknown> | null>
    }
  }
}

export interface PowerSwitchDevice {
  readonly ctx: Pick<DeviceContext, 'id' | 'registerNativeCap'> & {
    readonly api: PowerSwitchHubApi
    readonly logger: Pick<IScopedLogger, 'warn' | 'debug'>
  }
  readonly runtimeState: PowerSwitchState
}

export interface BuiltPowerSwitch {
  readonly provider: InferNativeProvider<typeof switchCapability>
  /** Stops the slice projection. */
  readonly dispose: () => void
}

type SliceRecord = Readonly<Record<string, unknown>> | undefined

/** `true` / `false` from the owner slice, `null` when the hinted field is
 *  absent or not of the hinted shape. */
export function powerOnFromSlice(hint: CapabilityPowerHint, slice: SliceRecord): boolean | null {
  const value = slice?.[hint.field]
  switch (hint.kind) {
    case 'field':
      return typeof value === 'boolean' ? value : null
    case 'methods':
      return typeof value === 'string' ? !hint.offValues.includes(value) : null
    case 'mode':
      return typeof value === 'string' ? value !== hint.offValue : null
  }
}

function ownerMethod(
  owner: PowerSwitchOwner,
  name: string,
  capName: string,
): (input: object) => Promise<unknown> {
  const fn: unknown = Reflect.get(owner, name)
  if (typeof fn !== 'function') {
    throw new PowerSwitchRefusedError(
      'owner-method-missing',
      `${capName} provider does not serve '${name}', which its power hint names`,
    )
  }
  return async (input: object) => fn.call(owner, input)
}

async function lastNonOffMode(
  host: PowerSwitchHost,
  capName: string,
  hint: Extract<CapabilityPowerHint, { kind: 'mode' }>,
): Promise<string | null> {
  const isMode = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v !== hint.offValue
  const hubSlice = await host.readHubSlice(capName).catch(() => null)
  const fromHub = hubSlice?.[hint.lastField]
  if (isMode(fromHub)) return fromHub
  const local = host.runtimeState.getCapState(capName)?.[hint.lastField]
  return isMode(local) ? local : null
}

async function applyPower(
  host: PowerSwitchHost,
  capName: string,
  hint: CapabilityPowerHint,
  owner: PowerSwitchOwner,
  on: boolean,
): Promise<void> {
  const deviceId = host.deviceId
  switch (hint.kind) {
    case 'field':
      await ownerMethod(owner, hint.set, capName)({ deviceId, on })
      return
    case 'methods':
      await ownerMethod(owner, on ? hint.on : hint.off, capName)({ deviceId })
      return
    case 'mode': {
      const set = ownerMethod(owner, hint.set, capName)
      if (!on) {
        await set({ deviceId, mode: hint.offValue })
        return
      }
      const mode = await lastNonOffMode(host, capName, hint)
      if (mode === null) {
        throw new PowerSwitchRefusedError(
          'no-last-mode',
          `device ${deviceId}: ${capName} has no last non-off mode to restore; pick a mode instead`,
        )
      }
      await set({ deviceId, mode })
      return
    }
  }
}

function hintedMethods(hint: CapabilityPowerHint): readonly string[] {
  return hint.kind === 'methods' ? [hint.on, hint.off] : [hint.set]
}

/** Whether `owner` serves every method its cap's power hint names. A media
 *  player whose `turnOn` / `turnOff` are not served has no power, so no switch. */
export function powerServedBy(
  hint: CapabilityPowerHint | undefined,
  owner: PowerSwitchOwner,
): boolean {
  if (hint === undefined) return false
  return hintedMethods(hint).every((name) => typeof Reflect.get(owner, name) === 'function')
}

/** Builds the `switch` provider and starts the slice projection. Exported
 *  for the specs; providers call `registerPowerSwitch`. */
export function buildPowerSwitch<TCap extends CapabilityDefinition>(
  host: PowerSwitchHost,
  cap: TCap,
  owner: PowerSwitchOwner,
): BuiltPowerSwitch {
  const hint = cap.power
  if (hint === undefined) {
    throw new Error(`capability '${cap.name}' has no power hint: it has no switch to project`)
  }
  const read = (): boolean | null => powerOnFromSlice(hint, host.runtimeState.getCapState(cap.name))

  const project = (): void => {
    const on = read()
    const current = host.runtimeState.getCapState(switchCapability.name)
    if (current !== undefined && current['on'] === on) return
    const next: SwitchStatus = { on, lastChangedAt: Date.now() }
    host.runtimeState.setCapState(switchCapability.name, next)
  }
  const stop = host.runtimeState.subscribeCap(cap.name, project)
  if (host.runtimeState.getCapState(cap.name) !== undefined) project()

  const provider: InferNativeProvider<typeof switchCapability> = {
    getStatus: async () => {
      const current = host.runtimeState.getCapState(switchCapability.name)
      const lastChangedAt =
        typeof current?.['lastChangedAt'] === 'number' ? current['lastChangedAt'] : 0
      return { on: read(), lastChangedAt }
    },
    setState: async ({ on }) => applyPower(host, cap.name, hint, owner, on),
  }
  return { provider, dispose: stop }
}

/**
 * Registers `switch` for a device whose `cap` carries a `power` hint, built
 * from `owner` (the provider the device registered for `cap`). Call it right
 * after `registerNativeCap(cap, owner)`.
 */
export function registerPowerSwitch<TCap extends CapabilityDefinition>(
  device: PowerSwitchDevice,
  cap: TCap,
  owner: InferNativeProvider<TCap>,
): () => void {
  const deviceId = device.ctx.id
  if (cap.power !== undefined && !powerServedBy(cap.power, owner)) {
    device.ctx.logger.debug('power switch: owner serves no power control, no switch registered', {
      tags: { deviceId },
      meta: { capName: cap.name },
    })
    return () => {}
  }
  const host: PowerSwitchHost = {
    deviceId,
    runtimeState: device.runtimeState,
    registerNativeCap: (c, p) => device.ctx.registerNativeCap(c, p),
    readHubSlice: async (capName) => {
      try {
        return await device.ctx.api.deviceState.getCapSlice.query({ deviceId, capName })
      } catch (err) {
        device.ctx.logger.warn('power switch: hub slice read failed', {
          tags: { deviceId },
          meta: { capName, error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }
    },
  }
  const built = buildPowerSwitch(host, cap, owner)
  host.registerNativeCap(switchCapability, built.provider)
  return built.dispose
}
