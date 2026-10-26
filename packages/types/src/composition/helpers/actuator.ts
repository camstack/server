/**
 * Actuator groups (D944 phase 1b). The active boolean is the binary reducer
 * with unknown members left out. A command is one call per member that binds
 * the cap, including members that are offline. One failure does not cancel
 * the others.
 */
import { DeviceFeature } from '../../device/device-type.js'
import type { ActiveCriterion, BinaryAggregate } from './spec.js'

/** Caps a light group may expose, in display order. Switch is the active state. */
export const LIGHT_SHARED_CAPS = ['switch', 'brightness', 'color'] as const
export type LightSharedCap = (typeof LIGHT_SHARED_CAPS)[number]

const COLOR_MODE_FEATURES = [
  DeviceFeature.LightColorRgb,
  DeviceFeature.LightColorHsv,
  DeviceFeature.LightColorMired,
] as const

/** How many member calls run at once. The rest wait; none are dropped. */
export const FAN_OUT_CONCURRENCY: number = 4

export interface FanOutMember {
  readonly deviceId: number
  readonly caps: readonly string[]
  /** Offline members are still commanded — they may wake. Not a reason to skip. */
  readonly online: boolean
}

export interface FanOutCall {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface FanOutOk {
  readonly deviceId: number
  readonly ok: true
}
export interface FanOutFailed {
  readonly deviceId: number
  readonly ok: false
  readonly error: string
}
export type FanOutMemberResult = FanOutOk | FanOutFailed

/** `at-least-one` is any included member on; `all` is every included member on. */
export function reducerForActive(active: ActiveCriterion): BinaryAggregate {
  return active === 'all' ? 'all' : 'any'
}

export function activeForReducer(reducer: BinaryAggregate): ActiveCriterion {
  return reducer === 'all' ? 'all' : 'at-least-one'
}

/**
 * Caps every member binds, from {@link LIGHT_SHARED_CAPS}. An empty member
 * list shares nothing. A member that lacks colour drops colour from the group.
 */
export function sharedLightCaps(memberCaps: readonly (readonly string[])[]): readonly string[] {
  if (memberCaps.length === 0) return []
  return LIGHT_SHARED_CAPS.filter((cap) => memberCaps.every((bound) => bound.includes(cap)))
}

/**
 * Colour modes every member advertises. Offline does not remove a mode:
 * the caller passes device features, not liveness. No members → no mode.
 */
export function sharedColorModes(
  memberFeatures: readonly (readonly string[])[],
): readonly DeviceFeature[] {
  if (memberFeatures.length === 0) return []
  return COLOR_MODE_FEATURES.filter((mode) =>
    memberFeatures.every((features) => features.includes(mode)),
  )
}

/**
 * One call per member that binds `cap`. Offline members stay in the list.
 * A member without the cap is not called — the command cannot reach it.
 */
export function fanOutTargets(
  members: readonly FanOutMember[],
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
): readonly FanOutCall[] {
  return members.flatMap((member) =>
    member.caps.includes(cap)
      ? [{ deviceId: member.deviceId, cap, method, args: { ...args } }]
      : [],
  )
}

/**
 * Run every call. A throw is that member's result; the other calls still run.
 * At most {@link FAN_OUT_CONCURRENCY} are in flight.
 */
export async function runFanOut(
  calls: readonly FanOutCall[],
  invoke: (call: FanOutCall) => Promise<void>,
): Promise<readonly FanOutMemberResult[]> {
  const results: FanOutMemberResult[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const call = calls[index]
      if (call === undefined) return
      try {
        await invoke(call)
        results[index] = { deviceId: call.deviceId, ok: true }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err)
        results[index] = { deviceId: call.deviceId, ok: false, error }
      }
    }
  }
  const width = Math.min(FAN_OUT_CONCURRENCY, calls.length)
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}
