/**
 * The one default for `switch.toggle` (D393).
 *
 * Every native provider is registered in `registerNativeCap`. A switch
 * provider that did not write `toggle` gets this body there — never a copy
 * in each addon. It reads the device's `switch` slice and calls that
 * provider's `setState` with the opposite `on`. A missing slice, or a slice
 * whose `on` is not a boolean (`null` is "never reported"), is unknown:
 * the call refuses and logs the device. It does not guess off.
 */
import type { IScopedLogger } from '@camstack/types'

/** Why a toggle will not act. Both are unknown; neither is off. */
export type SwitchToggleRefusal = 'no-slice' | 'stale'

export type SwitchOn =
  | { readonly known: true; readonly on: boolean }
  | { readonly known: false; readonly reason: SwitchToggleRefusal }

const REFUSAL_TEXT: Readonly<Record<SwitchToggleRefusal, string>> = {
  'no-slice': 'switch has no state slice',
  stale: 'switch state is unknown',
}

export class SwitchToggleRefusedError extends Error {
  readonly reason: SwitchToggleRefusal
  readonly deviceId: number

  constructor(reason: SwitchToggleRefusal, deviceId: number) {
    super(`device ${deviceId}: ${REFUSAL_TEXT[reason]}; refusing to guess on or off`)
    this.name = 'SwitchToggleRefusedError'
    this.reason = reason
    this.deviceId = deviceId
  }
}

/** `on` when the slice states it, otherwise the reason the toggle must refuse. */
export function classifySwitchOn(slice: unknown): SwitchOn {
  if (slice === undefined || slice === null) return { known: false, reason: 'no-slice' }
  if (typeof slice !== 'object' || Array.isArray(slice)) return { known: false, reason: 'stale' }
  const on: unknown = Reflect.get(slice, 'on')
  if (typeof on !== 'boolean') return { known: false, reason: 'stale' }
  return { known: true, on }
}

export interface SwitchToggleInput {
  readonly deviceId?: number
}

/** What the default needs from the device it was registered on. */
export interface SwitchToggleRead {
  readonly deviceId: number
  readSlice(): unknown
  readonly logger: Pick<IScopedLogger, 'warn'>
}

interface SetState {
  (input: { readonly deviceId: number; readonly on: boolean }): Promise<unknown>
}

function isSetState(fn: unknown): fn is SetState {
  return typeof fn === 'function'
}

function refuse(read: SwitchToggleRead, deviceId: number, reason: SwitchToggleRefusal): never {
  read.logger.warn(`switch.toggle refused: ${REFUSAL_TEXT[reason]}`, {
    tags: { deviceId },
    meta: { reason },
  })
  throw new SwitchToggleRefusedError(reason, deviceId)
}

async function runToggle(
  provider: object,
  setState: SetState,
  read: SwitchToggleRead,
  input: SwitchToggleInput | undefined,
): Promise<void> {
  const deviceId = typeof input?.deviceId === 'number' ? input.deviceId : read.deviceId
  const slice = deviceId === read.deviceId ? read.readSlice() : undefined
  const state = classifySwitchOn(slice)
  if (!state.known) refuse(read, deviceId, state.reason)
  await setState.call(provider, { deviceId, on: !state.on })
}

/**
 * `provider`, plus `toggle` when `capName` is `switch` and the provider did
 * not write one. Any other cap is returned as the same object.
 */
export function withDefaultSwitchToggle<P extends object>(
  capName: string,
  provider: P,
  read: SwitchToggleRead,
): P {
  if (capName !== 'switch') return provider
  if (typeof Reflect.get(provider, 'toggle') === 'function') return provider
  const setState: unknown = Reflect.get(provider, 'setState')
  if (!isSetState(setState)) return provider
  const toggle = (input: SwitchToggleInput | undefined): Promise<void> =>
    runToggle(provider, setState, read, input)
  return { ...provider, toggle }
}
