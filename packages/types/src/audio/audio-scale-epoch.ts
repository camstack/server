/**
 * The instant the audio amplitude scale changed, and by how much (D459).
 *
 * ## What happened
 *
 * Until this epoch the native RTP G.711 decoder that feeds the audio chunk
 * plane — `stream-broker/rtsp/audio-rtp-decoder.ts`, the PCM the audio
 * CLASSIFIER and the dBFS level meter read — decoded μ-law at exactly 1/4 of
 * its ITU-T G.711 value and A-law at exactly −1/8 (magnitude *and* sign). The
 * WebRTC/Opus egress decoded the same bytes correctly in `g711-mulaw.ts`, so
 * **the audio an operator HEARD was right and the audio the detector MEASURED
 * was 4–8× quieter**, which is why it survived so long.
 *
 * Non-G.711 sources — AAC and Opus, decoded through the `audio-codec` cap —
 * were always on the ITU-T scale and are NOT affected. Nothing here should
 * ever be applied to them.
 *
 * ## What this module is for, and what it is NOT for
 *
 * It is the ONE place the two numbers live, so no caller re-derives them and
 * no second constant can disagree. It exists for two readers:
 *
 *  - **A person re-calibrating a threshold.** Every absolute-dBFS gate
 *    authored before the epoch against a native G.711 camera is now that many
 *    dB too permissive: `NcAudioCondition.dbThreshold`,
 *    `RecordingTriggers.audioThresholdDbfs`, `audioMarkerMinDbfs`, and the
 *    viewer's per-grid `audioDb`.
 *  - **Anything drawing a level across the epoch.** A graph that spans it
 *    shows a step of 12.04 dB (PCMU) or 18.06 dB (PCMA) on the affected
 *    cameras. `audioScaleEraOf` is how a reader says which side a sample is
 *    on instead of leaving the step unexplained.
 *
 * **It is NOT a gain to apply to a sample.** Stored history is NOT rewritten
 * and live audio is NOT re-scaled: the decoder is correct now, and a second
 * authority that "fixes up" a number the decoder already got right is the
 * defect again with an extra place to argue with. Nor can history be
 * retro-corrected honestly — `DecodedAudioChunk` never carried the codec, so
 * a stored `AudioEvent.dbfs` does not say which of the two factors (or
 * neither) applied to it. Guessing per row is exactly the move that wrote the
 * original defect.
 */

/** Spelling of the epoch, so the millisecond constant is readable. */
export const AUDIO_SCALE_EPOCH_ISO = '2026-09-11T00:00:00.000Z'

/**
 * The instant, in epoch milliseconds. A reading at or after it is on the
 * ITU-T scale; a reading before it, from a native G.711 camera, is 12–18 dB
 * low.
 *
 * It is the DAY, not the deploy minute, and deliberately so: the correction
 * reaches each node when that node's `addon-pipeline` is redeployed, which is
 * neither simultaneous across the fleet nor knowable from here. A reader that
 * treats the boundary as fuzzy by a few hours is reading it correctly; one
 * that treats a sample 200 ms after it as authoritative is not.
 */
export const AUDIO_SCALE_EPOCH_MS = Date.parse(AUDIO_SCALE_EPOCH_ISO)

/**
 * How many dB a pre-epoch reading from a native G.711 camera was LOW, by law.
 *
 * Derived, not measured: the old tables were under-scaled by exactly 4 (μ-law)
 * and exactly 8 (A-law) on all 256 codes, and `20·log10` turns an amplitude
 * factor into dB. A-law's extra octave is its own separate defect — its
 * magnitudes were built on a 13-bit scale and never shifted to 16.
 *
 * To convert a threshold authored on the old scale to the same intent on the
 * ITU-T scale, ADD this (a −55 dBFS gate on a PCMU camera meant −42.96).
 */
export type G711Law = 'PCMU' | 'PCMA'

export const G711_SCALE_CORRECTION_DB: Readonly<Record<G711Law, number>> = {
  PCMU: 20 * Math.log10(4),
  PCMA: 20 * Math.log10(8),
}

/**
 * Restate a dBFS number that was MEASURED through the pre-epoch decoder as the
 * same intent on the ITU-T scale (D460).
 *
 * ## When this applies, and when it is the wrong thing to reach for
 *
 * An absolute-dBFS number in this repo is one of two things, and only one of
 * them converts:
 *
 *  - **A statement about the scale** — "-55 dBFS is near silence", "-25 dBFS
 *    is loud". It was true on the ITU-T scale before the epoch and it is true
 *    after. The defect was never in the number; it was that 19 of this hub's
 *    25 cameras did not obey it. Converting such a number takes something
 *    correct and makes it wrong, in order to preserve a bug.
 *  - **A measurement taken through the old decoder** — a value someone read
 *    off a meter that under-reported by exactly 4× (PCMU) or 8× (PCMA). It
 *    describes a sound that was really {@link G711_SCALE_CORRECTION_DB} dB
 *    louder. That is what this function is for.
 *
 * Telling the two apart is a question about PROVENANCE, not about arithmetic,
 * and it cannot be answered from the number. It is answered by the comment the
 * author left — which is why `scripts/check-dbfs-era.mts` makes leaving one
 * mandatory.
 *
 * ## Why a function and not a typed-in number
 *
 * `-55 + 12.04` written into a source file is, six months later, completely
 * indistinguishable from a threshold somebody simply preferred. Calling this
 * keeps the derivation, the law, and the original measurement all visible at
 * the call site, so a future reader can disagree with the *premise* instead of
 * having to reverse-engineer the sum.
 *
 * **This is not a runtime gain.** It converts an authored CONSTANT once, where
 * it is declared. It must never be applied to a live sample or a stored
 * `AudioEvent.dbfs`: the decoder is correct now, and a second authority
 * adjusting numbers the decoder already got right is the original defect with
 * an extra place to argue with (D459).
 */
export function ituDbfsFromPreEpoch(law: G711Law, authoredDbfs: number): number {
  return authoredDbfs + G711_SCALE_CORRECTION_DB[law]
}

/**
 * Which amplitude scale a dBFS reading taken at `timestampMs` is on.
 *
 * `unknown` is a real answer and never collapses into `itu`: a row with no
 * usable timestamp carries no claim about its scale, and calling it current
 * would make the oldest readings look freshly calibrated — the direction that
 * destroys the ability to explain the step at all (D393).
 */
export type AudioScaleEra = 'pre-itu' | 'itu' | 'unknown'

export function audioScaleEraOf(timestampMs: number): AudioScaleEra {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return 'unknown'
  return timestampMs >= AUDIO_SCALE_EPOCH_MS ? 'itu' : 'pre-itu'
}
