/**
 * Where a LIVE frame goes when the device its session was elected onto is not
 * usable (its pool died and the device sits in backoff, or its restart budget
 * is spent).
 *
 * Before this, nothing re-routed it: `refuseIfDeviceUnusable` threw for every
 * frame of every session bound to that device, for as long as each session
 * lasted — the orchestrator stops ELECTING an unhealthy device through the
 * health channel, but a session already on it kept losing its frames. A live
 * frame now re-elects onto the node's default pool, which every session's
 * structure can fall back to (it is the same fallback the capability gate
 * takes for a device whose format has no build — `resolveStepsForDispatch`).
 * When the default pool is the same device, or unusable too, there is no
 * alternative and the frame is refused as before.
 *
 * Live frames only: a replay or a bulk pass pins its model and REFUSES rather
 * than substitutes (D54).
 */
import type { InferenceDeviceUnhealthy } from './inference-device-liveness.js'

export interface LiveFrameDeviceInput {
  /** The deviceKey the session was elected onto; undefined = the default pool. */
  readonly requestedDeviceKey: string | undefined
  /** The deviceKey of the node's default pool. */
  readonly defaultDeviceKey: string
  readonly unusable: (deviceKey: string) => InferenceDeviceUnhealthy | null
}

export type LiveFrameDeviceRouting =
  | { readonly kind: 'as-elected'; readonly deviceKey: string | undefined }
  | {
      readonly kind: 're-elected'
      /** Dispatch with no deviceKey: the node default pool. */
      readonly deviceKey: undefined
      readonly from: InferenceDeviceUnhealthy
      readonly to: string
    }
  | {
      readonly kind: 'no-alternative'
      readonly deviceKey: string
      readonly from: InferenceDeviceUnhealthy
    }

export function routeLiveFrameDevice(input: LiveFrameDeviceInput): LiveFrameDeviceRouting {
  const requested = input.requestedDeviceKey
  if (requested === undefined) return { kind: 'as-elected', deviceKey: undefined }
  const from = input.unusable(requested)
  if (from === null) return { kind: 'as-elected', deviceKey: requested }
  if (requested === input.defaultDeviceKey || input.unusable(input.defaultDeviceKey) !== null) {
    return { kind: 'no-alternative', deviceKey: requested, from }
  }
  return { kind: 're-elected', deviceKey: undefined, from, to: input.defaultDeviceKey }
}

/** A change of routing worth one log line. */
export type FrameReelectionNote =
  | Extract<LiveFrameDeviceRouting, { kind: 're-elected' | 'no-alternative' }>
  | { readonly kind: 'restored'; readonly deviceKey: string }

/**
 * Per camera, the routing last said — so a 6 fps camera says "re-elected"
 * once, not six times a second, and says it again when it is back.
 */
export class FrameReelectionNotes {
  private readonly said = new Map<number, string>()

  note(deviceId: number, routing: LiveFrameDeviceRouting): FrameReelectionNote | null {
    const previous = this.said.get(deviceId)
    if (routing.kind === 'as-elected') {
      if (previous === undefined) return null
      this.said.delete(deviceId)
      return routing.deviceKey !== undefined
        ? { kind: 'restored', deviceKey: routing.deviceKey }
        : null
    }
    const state = `${routing.kind}|${routing.from.deviceKey}|${routing.from.state}`
    if (previous === state) return null
    this.said.set(deviceId, state)
    return routing
  }
}
