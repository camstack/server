/**
 * The audio chunk plane's byte format, and the ONE expansion from a coded
 * window to float samples (D455).
 *
 * ## Why a format at all
 *
 * D450 took the plane off its 8 → 16 kHz upsample: it carries the SOURCE
 * RATE, and the one consumer that needs 16 kHz resamples next to the model.
 * It left the FORMAT alone — the broker still turned each G.711 byte into a
 * 4-byte f32le sample before the bytes entered the transport, so every leg of
 * the plane carried four times the source. The plane crosses hub-main twice on
 * the way to the analyzer, and the fleet's G.711 cameras are ~79 % of it.
 *
 * So the plane carries the source BYTES too, and whoever needs floats expands
 * them where it needs them. That is the same argument D450 made for the rate,
 * one step further along the same wire.
 *
 * ## Why the expansion lives here
 *
 * Two packages need it and they must never disagree: `addon-pipeline`'s broker
 * (which still has to serve a subscriber that did NOT ask for coded bytes —
 * `AudioChunkPlane` expands per subscription) and
 * `addon-pipeline-orchestrator`'s `AudioWindowAccumulator` (which flushes an
 * f32le window to the analyzer cap, whose `AudioChunkInput` contract is
 * unchanged and stays f32le). Both bundle the bare `@camstack/types` entry
 * into their own dist (`self-contained` externals), so this travels with a
 * `camstack deploy` and needs no published server.
 *
 * A second μ-law table anywhere else is the defect this module exists to
 * prevent. (`stream-broker.ts`'s `mulawToPcm` / `alawToPcm` are the ENCODE
 * direction for the WebRTC egress — a different transform, not a copy.)
 *
 * ## Absent means f32le
 *
 * `format` is optional on the wire and its absence means `f32le` — today's
 * bytes, byte for byte. A peer that never heard of the field is served what it
 * has always been served, because the broker only emits a coded window to a
 * subscription that DECLARED it accepts one (`AudioSubscribeOptions.accept`).
 * That is the D448 `rawForward` negotiation, and it is what makes this
 * deployable one addon at a time across three nodes.
 */

/** Every byte format the audio chunk plane can carry. `f32le` is the default. */
export const AUDIO_CHUNK_FORMATS = ['f32le', 'pcmu', 'pcma'] as const

/**
 * The byte format of a decoded audio chunk's `data`.
 *
 * - `f32le` — 4 bytes per sample, normalised IEEE 754 float in [-1, 1].
 * - `pcmu` — ITU-T G.711 μ-law, 1 byte per sample.
 * - `pcma` — ITU-T G.711 A-law, 1 byte per sample.
 */
export type AudioChunkFormat = (typeof AUDIO_CHUNK_FORMATS)[number]

/** Type guard for a value that arrived over the wire as a format name. */
export function isAudioChunkFormat(value: unknown): value is AudioChunkFormat {
  return typeof value === 'string' && (AUDIO_CHUNK_FORMATS as readonly string[]).includes(value)
}

/**
 * Bytes one sample of `format` occupies. This is the number every duration
 * calculation over a chunk's `data` must use — a window accumulator that
 * hard-codes 4 reports a quarter of the audio it actually holds and flushes
 * four-second windows to a classifier expecting one.
 */
export function audioChunkBytesPerSample(format: AudioChunkFormat): number {
  return format === 'f32le' ? 4 : 1
}

/**
 * Expand a CODED audio window to freshly-owned f32le bytes, 4-byte aligned at
 * offset 0, so a caller can build a `Float32Array` view over them directly.
 * The input may be a msgpack subview at any offset; nothing here reads it as
 * anything but bytes.
 *
 * `f32le` is accepted and returns a copy, but a caller that already knows the
 * format is `f32le` should not call this at all — it has the bytes. Both
 * callers branch on the format first for exactly that reason, and the copy
 * here exists so the return type is always owned rather than sometimes
 * aliasing the argument.
 */
export function expandAudioChunkToF32le(
  data: Uint8Array,
  format: AudioChunkFormat,
): Uint8Array<ArrayBuffer> {
  if (format === 'f32le') {
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    return copy
  }
  const table = format === 'pcmu' ? ULAW_TABLE : ALAW_TABLE
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = table[data[i]!]!
  return new Uint8Array(out.buffer)
}

/**
 * Build the μ-law decode table (ITU-T G.711). Each of the 256 byte values maps
 * to a 16-bit PCM sample, normalised to [-1.0, 1.0] for f32le output.
 *
 * Moved here verbatim from `audio-rtp-decoder.ts`, which no longer decodes:
 * it buffers the coded bytes and the plane's consumers expand.
 */
function buildUlawTable(): Float32Array {
  const table = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const complemented = ~i & 0xff
    const sign = (complemented & 0x80) !== 0 ? -1 : 1
    const exponent = (complemented >> 4) & 0x07
    const mantissa = complemented & 0x0f
    const magnitude = ((8 * mantissa + 132) << exponent) - 132
    table[i] = (sign * magnitude) / 32768
  }
  return table
}

/** Build the A-law decode table (ITU-T G.711). */
function buildAlawTable(): Float32Array {
  const table = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const xored = i ^ 0x55
    // After `^ 0x55` bit 7 SET means POSITIVE in A-law — the
    // opposite of mu-law. The previous table used the mu-law convention:
    // the waveform was phase-inverted (D459).
    const sign = (xored & 0x80) !== 0 ? 1 : -1
    const exponent = (xored >> 4) & 0x07
    const mantissa = xored & 0x0f
    const magnitude = exponent === 0 ? 16 * mantissa + 8 : (16 * mantissa + 264) << (exponent - 1)
    table[i] = (sign * magnitude) / 32768
  }
  return table
}

const ULAW_TABLE = buildUlawTable()
const ALAW_TABLE = buildAlawTable()
