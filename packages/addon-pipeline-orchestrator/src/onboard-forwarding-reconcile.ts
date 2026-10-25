/**
 * Keep the vendor's onboard-AI FORWARDING flag a mirror of the camera's pick.
 *
 * Whether a camera's own AI is its root detector is decided in exactly ONE
 * place: `detectionSources` on the orchestrator's per-device store — the
 * operator's pick, durable, resolved by `resolveDetectionSettings` and carried
 * to the runner. The vendor cap flag
 * (`nativeObjectDetection.getStatus().enabled`) is the MECHANISM that pick
 * drives: it arms the provider's forwarding gate and the boxed sub-stream.
 * D62 — the switch writes the authority that owns the function; it does not
 * become a second one.
 *
 * The mechanism, however, is device state, and device state is lost: the
 * Reolink provider re-seeds the `native-object-detection` slice with
 * `enabled: false` on every boot where its persisted slice does not reach the
 * device's `runtimeState` before the cap registers. Measured on the live hub
 * (2026-09-15): the provider process started at 23:19:36 the previous evening
 * and ALL SEVEN Reolink cameras carried a `lastFetchedAt` from 23:19:38–23:20:03
 * — a field the cap writes only in its cold-start seed. Device 106's stored
 * pick was `['onboard']`, the flag read `false`, and the hub log carried
 * "Reolink onboard AI detection dropped — forwarding is off for this camera"
 * once a minute. The pick was intact; the mechanism had been forgotten.
 *
 * So the write at save time is not enough — the flag has to be put back where
 * the pick says it belongs every time the camera is attached. In BOTH
 * directions: a camera whose pick lost `onboard` must have forwarding turned
 * OFF by the same pass, or this is a ratchet that quietly enables things.
 *
 * A repair is never silent (D391): it logs, with `tags: { deviceId }`, and so
 * does a read that failed — an unread flag on a camera picked as its own root
 * detector is the exact shape of a camera that produces nothing.
 *
 * A read that FAILED never causes a write (D49): the mechanism is only ever
 * moved when the current value is known. Unknown is not "off".
 */
import type { IScopedLogger } from '@camstack/types'

/** The `detectionSources` member that means "this camera's own firmware". */
export const ONBOARD_DETECTION_SOURCE = 'onboard'

/**
 * What an ABSENT `detectionSources` means. `CameraDetectionConfig` declares the
 * field optional and its own contract as "absent is `['pipeline']` all the way
 * down" — the resolver always fills it, so this only covers the hand-built
 * configs, and it reads them the same way the runner does.
 */
export const DETECTION_SOURCES_WHEN_ABSENT: readonly string[] = ['pipeline']

/**
 * What the pass did.
 *
 * - `no-cap` — the camera exposes no `native-object-detection` binding. There
 *   is no mechanism to mirror; nothing was dropped.
 * - `aligned` — the flag already agreed with the pick.
 * - `repaired` — the flag disagreed and was put back.
 * - `read-failed` — the flag could not be read; nothing was written.
 * - `write-failed` — the flag disagreed and the repair did not land.
 */
export type OnboardForwardingOutcomeKind =
  | 'no-cap'
  | 'aligned'
  | 'repaired'
  | 'read-failed'
  | 'write-failed'

export interface OnboardForwardingOutcome {
  readonly kind: OnboardForwardingOutcomeKind
  /** What the pick asks for — the value the mechanism must mirror. */
  readonly wantsOnboard: boolean
}

export interface OnboardForwardingReconcileDeps {
  /** Does this device carry a `native-object-detection` binding at all? */
  readonly hasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
  /** Current value of the vendor's forwarding flag. */
  readonly readForwardingEnabled: (deviceId: number) => Promise<boolean>
  /** Move the vendor's forwarding flag. */
  readonly writeForwardingEnabled: (deviceId: number, enabled: boolean) => Promise<void>
  readonly logger: IScopedLogger
}

export interface OnboardForwardingReconcileInput {
  readonly deviceId: number
  /** The camera's resolved pick — the authority. */
  readonly detectionSources: readonly string[]
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Put the vendor forwarding flag back where `detectionSources` says it belongs.
 * Never throws — a camera's attach is not failed by a mechanism that could not
 * be reached, it is reported.
 */
export async function reconcileOnboardForwarding(
  input: OnboardForwardingReconcileInput,
  deps: OnboardForwardingReconcileDeps,
): Promise<OnboardForwardingOutcome> {
  const { deviceId, detectionSources } = input
  const wantsOnboard = detectionSources.includes(ONBOARD_DETECTION_SOURCE)
  const log = deps.logger.withTags({ deviceId })

  let hasCap: boolean
  try {
    hasCap = await deps.hasNativeObjectDetectionCap(deviceId)
  } catch (err: unknown) {
    // The probe itself failed. On a camera the operator picked as its own root
    // detector that is a silence with no cause attached, so it is named.
    log.warn('onboard forwarding not reconciled — could not tell whether the camera has the cap', {
      meta: { wantsOnboard, detectionSources: [...detectionSources], error: errMsg(err) },
    })
    return { kind: 'read-failed', wantsOnboard }
  }
  if (!hasCap) return { kind: 'no-cap', wantsOnboard }

  let current: boolean
  try {
    current = await deps.readForwardingEnabled(deviceId)
  } catch (err: unknown) {
    // Unknown is NOT "off": a failed read never moves the mechanism.
    log.warn('onboard forwarding not reconciled — the vendor flag could not be read', {
      meta: { wantsOnboard, detectionSources: [...detectionSources], error: errMsg(err) },
    })
    return { kind: 'read-failed', wantsOnboard }
  }

  if (current === wantsOnboard) return { kind: 'aligned', wantsOnboard }

  try {
    await deps.writeForwardingEnabled(deviceId, wantsOnboard)
  } catch (err: unknown) {
    log.warn('onboard forwarding drifted and the repair failed', {
      meta: {
        was: current,
        wanted: wantsOnboard,
        detectionSources: [...detectionSources],
        error: errMsg(err),
      },
    })
    return { kind: 'write-failed', wantsOnboard }
  }

  log.info('onboard forwarding flag put back to match the camera pick', {
    meta: { was: current, now: wantsOnboard, detectionSources: [...detectionSources] },
  })
  return { kind: 'repaired', wantsOnboard }
}
