/**
 * The ONE `FaceRecognizerDeps.onIdentityVerdict` closure (D681; D683 R3).
 * Sinks are read on EVERY call: the recognizer is built before the tape
 * recorder exists, and D683 adds the tracker as a second sink. Each sink is
 * isolated — an observer can never change recognition.
 */
import type { IScopedLogger } from '@camstack/types'
import type { FaceIdentityVerdict } from '../../face-recognizer.js'

export type IdentityVerdictSink = (verdict: FaceIdentityVerdict) => void

export function makeIdentityVerdictObserver(
  sinks: () => readonly IdentityVerdictSink[],
  logger: IScopedLogger,
): (verdict: FaceIdentityVerdict) => void {
  return (verdict) => {
    for (const sink of sinks()) {
      try {
        sink(verdict)
      } catch (err) {
        logger.warn('identity verdict observer failed', {
          tags: { deviceId: verdict.deviceId },
          meta: {
            trackId: verdict.trackId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }
}
