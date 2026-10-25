/**
 * What pipeline-analytics carries forward about whether the analyzer's model
 * RAN on an audio window (D660).
 *
 * Until D660 a window the analyzer's busy gate discarded arrived with empty
 * `detections` and nothing else, which is the exact shape of a window that was
 * classified and heard nothing above the floor — so the Notification Center
 * and the stored level-path rows could not tell "silence" from "nobody
 * listened" (D393). The analyzer now stamps `classifyOutcome` on every frame;
 * `ncAudioSampleFromFrame` carries it into the NC matcher's sample. An absent
 * outcome (a frame from an analyzer older than D660) stays ABSENT — unknown,
 * never defaulted to "classified".
 */
import type { AudioResult } from '@camstack/types'
import type { AudioSample } from '../notification-center/audio-rule-matcher.js'

/** The per-device floor the router and the NC feed share. */
export interface AudioLabelFloor {
  readonly classificationMinScore: number
  readonly audioAllowedClasses: readonly string[]
}

/**
 * The Notification Center's audio sample for one analyzer frame: its level,
 * the labels that clear the SAME per-device floor the router uses (so a rule
 * and the event log never disagree about what was heard), and whether the
 * model ran at all.
 */
export function ncAudioSampleFromFrame(
  frame: AudioResult,
  timestampMs: number,
  floor: AudioLabelFloor,
): AudioSample {
  const dbfs = frame.level?.dbfs
  return {
    timestampMs,
    ...(dbfs !== undefined ? { dbfs } : {}),
    // The frame comes off the event bus unvalidated — keep the guard.
    labels: (frame.detections ?? [])
      .filter((d) => d.score >= floor.classificationMinScore)
      .map((d) => d.macroClass)
      .filter(
        (macroClass) =>
          floor.audioAllowedClasses.length === 0 || floor.audioAllowedClasses.includes(macroClass),
      ),
    ...(frame.classifyOutcome !== undefined ? { classifyOutcome: frame.classifyOutcome } : {}),
  }
}
