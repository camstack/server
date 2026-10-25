/**
 * Waking a BATTERY camera for a recording trigger.
 *
 * ## Why the recorder needs this at all
 *
 * A battery camera is asleep between events. Every other demand consumer in
 * this system already wakes it — the live/WebRTC path does, through
 * `battery.wakeForStream` (D173) — but the recorder did not, so an `events`
 * band pointed at a battery camera attached to a broker with no source and
 * produced nothing. Measured on camera 3629 (audit 2026-08-20): **48.9 % of its
 * episodes recorded zero footage.**
 *
 * A recording trigger IS demand, in exactly the sense D173 defines: something
 * the operator asked for is happening NOW and needs media. It therefore takes
 * the demand path — which bypasses the provider's proactive-wake cooldown while
 * still stamping it — and not the proactive path.
 *
 * ## What this module deliberately does NOT do
 *
 * - It does not re-derive presence. `deriveBatteryPresence` is THE derivation
 *   (D52); a caller writing `sleeping === true` has undone the third state that
 *   exists so a nap stops being rendered as breakage.
 * - It does not guess battery-operation. An UNKNOWN verdict never wakes (D49):
 *   a failed registry read must not look like a battery camera.
 * - It does not wait for the broker to settle. The recorder already has that
 *   machinery — a failed attach queues on the readiness-restore queue and is
 *   retried on the next broker-ready transition, with the periodic reconcile as
 *   backstop. Duplicating `battery-wake-on-play.ts`'s settle loop here would be
 *   a second implementation of a convergence this addon already owns.
 */
import { deriveBatteryPresence } from '@camstack/types'

/**
 * Bound on the wake itself, matched to the live path's
 * `WAKE_FOR_STREAM_TIMEOUT_MS`. Deliberately the same number: a battery camera
 * does not wake faster because a recorder asked instead of a viewer, and two
 * different bounds for one physical act is the kind of drift that makes a
 * timeout unattributable.
 */
export const WAKE_FOR_RECORDING_TIMEOUT_MS = 8_000

/** What a battery slice tells us, reduced to what presence needs. */
export interface BatteryFacts {
  readonly sleeping: boolean
  readonly lastContactAt: number | undefined
}

/** The wake RPC's answer. */
export interface WakeForStreamResult {
  readonly awoke: boolean
  readonly durationMs: number
}

/** Everything this policy touches, injected so it is testable without a hub. */
export interface RecordingWakeDeps {
  /** `null` when the registry could not answer — never guessed (D49). */
  readonly isBatteryDevice: (deviceId: number) => Promise<boolean | null>
  /** `null` when the device has no battery slice or it did not parse. */
  readonly readBatteryFacts: (deviceId: number) => Promise<BatteryFacts | null>
  readonly wakeForStream: (deviceId: number, timeoutMs: number) => Promise<WakeForStreamResult>
  readonly nowMs: () => number
}

/**
 * Why this device was, or was not, woken. Every branch is named because every
 * branch decides whether an episode records footage, and "nothing happened" and
 * "we refused" used to print identically: as nothing at all.
 */
export type RecordingWakeOutcome =
  | 'not-battery'
  | 'unknown'
  | 'already-awake'
  | 'unreachable'
  | 'woken'
  | 'did-not-wake'
  | 'wake-failed'

export interface RecordingWakeResult {
  readonly outcome: RecordingWakeOutcome
  /** How long the wake took, when one was attempted. */
  readonly durationMs?: number
  /** Message of the failure, for `wake-failed` only. */
  readonly error?: string
}

/**
 * Wake `deviceId` if it is a sleeping battery camera. Never throws — a wake
 * that fails must degrade to "attach anyway and let the existing retry
 * machinery converge", never to a rejection escaping into the trigger path
 * (that path is fire-and-forget and an escape prints a runner CRASH marker).
 */
export async function wakeForRecording(
  deviceId: number,
  deps: RecordingWakeDeps,
): Promise<RecordingWakeResult> {
  const isBattery = await deps.isBatteryDevice(deviceId).catch(() => null)
  if (isBattery === false) return { outcome: 'not-battery' }
  if (isBattery === null) return { outcome: 'unknown' }

  const facts = await deps.readBatteryFacts(deviceId).catch(() => null)
  const presence = deriveBatteryPresence({
    status:
      facts === null ? null : { sleeping: facts.sleeping, lastContactAt: facts.lastContactAt },
    nowMs: deps.nowMs(),
  })
  if (presence === 'awake') return { outcome: 'already-awake' }
  // D173: an unreachable camera is a FAULT, not a nap. Hammering a radio that
  // has been silent for six hours neither wakes it nor tells anyone anything.
  if (presence === 'unreachable') return { outcome: 'unreachable' }

  try {
    const wake = await deps.wakeForStream(deviceId, WAKE_FOR_RECORDING_TIMEOUT_MS)
    return {
      outcome: wake.awoke ? 'woken' : 'did-not-wake',
      durationMs: wake.durationMs,
    }
  } catch (err: unknown) {
    return { outcome: 'wake-failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Did this outcome leave the camera unable to produce footage for the episode
 * that asked? Those are the branches that DROP work, and the caller warns on
 * them — camera 3629 lost half its episodes without a single line saying so.
 */
export function wakeOutcomeLosesFootage(outcome: RecordingWakeOutcome): boolean {
  return outcome === 'unreachable' || outcome === 'did-not-wake' || outcome === 'wake-failed'
}
