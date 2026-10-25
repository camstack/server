/**
 * What the operator reads when a frame could not be sent to training.
 *
 * Pure, so every refusal the hub can name has a sentence here and a test
 * that says so — a refusal rendered as its raw code reads like a crash.
 */

/** The refusal codes `addRetrainFrameFromRecording` answers with. */
export type TrainingFrameRefusal =
  | 'unknown-collection'
  | 'still-unavailable'
  | 'still-busy'
  | 'unreadable-image'
  | 'write-failed'

const REFUSAL_TEXT: Readonly<Record<TrainingFrameRefusal, string>> = {
  'unknown-collection': 'That collection no longer exists — pick another one.',
  'still-unavailable': 'No frame could be taken from the recording at that moment.',
  'still-busy': 'The recorder is busy decoding other frames. Try again in a moment.',
  'unreadable-image': 'The recorder returned something that is not a picture.',
  'write-failed': 'The frame could not be stored. Check the artifacts storage.',
}

/** One sentence for a refusal, with the hub's own detail appended. */
export function trainingRefusalText(reason: TrainingFrameRefusal, detail?: string): string {
  const base = REFUSAL_TEXT[reason]
  return detail !== undefined && detail !== '' ? `${base} (${detail})` : base
}
