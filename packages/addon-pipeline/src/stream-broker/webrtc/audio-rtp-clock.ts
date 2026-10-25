/**
 * audio-rtp-clock — codec-agnostic audio RTP clock math for the WebRTC session.
 *
 * The live audio egress historically hard-coded PCMU's 8 kHz clock and 160-
 * sample (20 ms) frames as scattered constants inside `session.ts`. Opus egress
 * needs the SAME logic at 48 kHz / 960-sample frames. Rather than fork every
 * timestamp expression, this module names the two clocks and the pure functions
 * the session uses to (a) pick a clock from the negotiated codec, (b) turn a
 * source capture time into an RTP timestamp, and (c) compute the recorded→live
 * rebase offset. All pure + unit-tested so the 48 kHz path is provable without a
 * browser.
 *
 * The existing silence-pad planner (`planAudioSilencePadPackets` in session.ts)
 * is already parameterized by `rateHz` + `framesizeSamples`, so it needs no
 * change — the session just feeds it `clock.rateHz` / `clock.frameSamples`.
 */

/** RTP payload types this session offers for audio. PCMU is the RFC 3551
 *  static assignment (0); Opus uses a dynamic PT in the 96–127 range. */
export const AUDIO_PT_PCMU = 0
export const AUDIO_PT_OPUS = 111

/** A single audio codec's RTP clock + framing. */
export interface AudioRtpClock {
  /** Canonical codec tag. */
  readonly codec: 'pcmu' | 'opus'
  /** RTP clock rate in Hz (== the codec's sample rate on the wire). */
  readonly rateHz: number
  /** Samples per packet at the 20 ms ptime both codecs use here. */
  readonly frameSamples: number
  /** Default payload type offered for this codec. */
  readonly payloadType: number
}

/** PCMU: 8 kHz µ-law, 160 samples (20 ms), static PT 0. */
export const AUDIO_CLOCK_PCMU: AudioRtpClock = {
  codec: 'pcmu',
  rateHz: 8_000,
  frameSamples: 160,
  payloadType: AUDIO_PT_PCMU,
}

/** Opus: 48 kHz, 960 samples (20 ms), dynamic PT 111. */
export const AUDIO_CLOCK_OPUS: AudioRtpClock = {
  codec: 'opus',
  rateHz: 48_000,
  frameSamples: 960,
  payloadType: AUDIO_PT_OPUS,
}

/**
 * Select the audio clock for a negotiated sender mime type
 * (`audio/opus`, `audio/PCMU`, …). Anything not recognised as Opus falls back
 * to PCMU — the always-offered baseline codec — so an unexpected/absent mime
 * can never silently pick the wrong (48 kHz) clock for an 8 kHz track.
 */
export function selectAudioClock(mimeType: string | null | undefined): AudioRtpClock {
  if (mimeType && /opus/i.test(mimeType)) return AUDIO_CLOCK_OPUS
  return AUDIO_CLOCK_PCMU
}

/**
 * Convert a source capture time (microseconds) into an RTP timestamp for the
 * given clock. Mirrors the session's existing `(timestampMicros * rateHz) /
 * 1_000_000`; the caller applies `>>> 0` when it needs a wrapped 32-bit value.
 */
export function rtpTsFromMicros(timestampMicros: number, clock: AudioRtpClock): number {
  return (timestampMicros * clock.rateHz) / 1_000_000
}

/**
 * Compute the timestamp offset that makes a recorded audio stream continue
 * monotonically from the last live packet across a live→recorded switch.
 * Generalizes the PCMU-only `((lastSentTs ?? 0) + 160 − incomingTs) | 0` to any
 * clock: continue exactly one frame (`clock.frameSamples`) past the last sent
 * timestamp. `lastSentTs === null` (nothing sent yet) anchors the recorded
 * stream at its own zero.
 */
export function recordedAudioRebaseOffset(
  lastSentTs: number | null,
  incomingTs: number,
  clock: AudioRtpClock,
): number {
  return ((lastSentTs ?? 0) + clock.frameSamples - incomingTs) | 0
}
