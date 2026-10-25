/**
 * "Does this stream carry audio?" — ONE reading of the broker's answer, shared
 * by the two places that ask.
 *
 * `BrokerStats.audio` is `null` for TWO different facts: the stream has no
 * audio track, and the broker has not observed one YET (idle, suspended, or
 * seconds into a dial). Collapsing them is not academic — both consumers get it
 * wrong in a way that has already shipped:
 *
 *  - the watchdog's audio stage arms only when the source is known to carry
 *    audio. Read at DISPATCH time, when a broker is normally cold, `audio` is
 *    `null` and the stage is never armed — so a camera that goes silent is
 *    never reported. That is why camera 108's derived stream could deliver zero
 *    audio chunks for four days without one warning line;
 *  - the audio subscription refuses a stream with no audio track (deliberate:
 *    there is no automatic fallback to another stream — the pipeline already
 *    has knobs to choose the audio profile). Refusing on a cold read would mute
 *    a working camera instead.
 *
 * So the classifier answers three ways, and only ever says `absent` on POSITIVE
 * evidence: a broker that has been streaming long enough to have parsed its SDP
 * (or been handed a push audio declaration) and still reports no track.
 */

/** The broker's verdict on one stream's audio track. */
export type AudioTrackProbe =
  | { readonly kind: 'present'; readonly codec: string }
  /** Positive evidence of NO audio track — a settled, streaming broker says so. */
  | { readonly kind: 'absent' }
  /** No usable evidence either way (cold broker, failed read, no api). */
  | { readonly kind: 'unknown'; readonly reason: string }

/**
 * How long a broker must have been streaming before "no audio track" counts as
 * evidence rather than a cold read. An RTSP source declares its audio in the
 * DESCRIBE it answers before the first packet; a push source declares it with
 * `pushAudioInfo`, which can legitimately trail the first VIDEO packet by a
 * moment. Ten seconds is far past both and far short of any consumer's
 * patience.
 */
export const AUDIO_PROBE_SETTLE_MS = 10_000

/** The `BrokerStats` subset this classifier reads. */
export interface AudioTrackProbeStats {
  readonly status: string
  readonly uptimeMs: number
  readonly audio?: { readonly codec: string } | null | undefined
}

/**
 * Classify one `getBrokerStats` answer. Pure.
 *
 * `null` and `undefined` are NOT the same answer here. Every broker in this
 * repo writes `audio: this.audioTrackInfo ?? null`, so `null` is a claim ("I
 * looked, there is no track") while a MISSING field is a producer that did not
 * answer the question at all — a version skew, or another implementation. The
 * missing field must never read as absence: it would refuse audio for the whole
 * fleet at once.
 */
export function classifyAudioTrackProbe(stats: AudioTrackProbeStats): AudioTrackProbe {
  const audio = stats.audio
  if (audio === undefined) return { kind: 'unknown', reason: 'no audio field reported' }
  if (audio !== null) return { kind: 'present', codec: audio.codec }
  if (stats.status !== 'streaming') return { kind: 'unknown', reason: `status=${stats.status}` }
  if (stats.uptimeMs < AUDIO_PROBE_SETTLE_MS) {
    return { kind: 'unknown', reason: `settling (${Math.round(stats.uptimeMs / 1000)}s)` }
  }
  return { kind: 'absent' }
}
