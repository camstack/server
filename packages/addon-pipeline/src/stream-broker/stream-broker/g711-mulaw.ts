/**
 * G.711 µ-law encoder — converts 16-bit signed PCM samples to µ-law (ITU-T G.711).
 *
 * Used to bridge non-native audio codecs (AAC, Opus) into WebRTC's
 * PCMU negotiated track. The audio-codec cap decodes to linear PCM;
 * this module encodes the PCM to µ-law for the RTP payload.
 */

// µ-law compression bias
const MULAW_BIAS = 0x84
const MULAW_CLIP = 32635

/** Encode a single 16-bit signed PCM sample to µ-law byte. */
function linearToMulaw(sample: number): number {
  const sign = (sample >> 8) & 0x80
  if (sign !== 0) sample = -sample
  if (sample > MULAW_CLIP) sample = MULAW_CLIP
  sample = sample + MULAW_BIAS

  const exponent = MU_LAW_COMPRESS_TABLE[(sample >> 7) & 0xff]!
  const mantissa = (sample >> (exponent + 3)) & 0x0f
  const byte = ~(sign | (exponent << 4) | mantissa) & 0xff
  return byte
}

// Lookup table: maps (sample >> 7) to exponent (0-7)
const MU_LAW_COMPRESS_TABLE = new Uint8Array(256)
;(() => {
  for (let i = 0; i < 256; i++) {
    let val = i
    let exp = 0
    val >>= 1
    while (val > 0 && exp < 7) {
      val >>= 1
      exp++
    }
    MU_LAW_COMPRESS_TABLE[i] = exp
  }
})()

/** Convert an Int16Array of PCM samples to a Uint8Array of µ-law bytes. */
export function pcmToMulaw(pcm: Int16Array): Uint8Array {
  const result = new Uint8Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    result[i] = linearToMulaw(pcm[i]!)
  }
  return result
}

/** Decode a single µ-law byte back to a 16-bit signed PCM sample (ITU-T G.711). */
function mulawToLinear(uVal: number): number {
  const u = ~uVal & 0xff
  let t = ((u & 0x0f) << 3) + MULAW_BIAS
  t <<= (u & 0x70) >> 4
  return (u & 0x80) !== 0 ? MULAW_BIAS - t : t - MULAW_BIAS
}

/**
 * Decode µ-law bytes to 16-bit signed PCM. The inverse of {@link pcmToMulaw};
 * used by the WebRTC Opus egress to turn the broker's native/companded G.711
 * audio back into PCM for the Opus encoder (source→PCM→Opus).
 */
export function mulawToPcm(ulaw: Uint8Array): Int16Array {
  const out = new Int16Array(ulaw.length)
  for (let i = 0; i < ulaw.length; i++) out[i] = mulawToLinear(ulaw[i]!)
  return out
}

// A-law (ITU-T G.711) — the PCMA counterpart to µ-law, used by cameras that
// negotiate PCMA instead of PCMU. Decode-only here (the egress never A-law
// encodes).
function alawToLinear(aVal: number): number {
  let a = aVal ^ 0x55
  let t = (a & 0x0f) << 4
  const seg = (a & 0x70) >> 4
  if (seg === 0) {
    t += 8
  } else if (seg === 1) {
    t += 0x108
  } else {
    t += 0x108
    t <<= seg - 1
  }
  return (a & 0x80) !== 0 ? t : -t
}

/** Decode A-law (PCMA) bytes to 16-bit signed PCM. */
export function alawToPcm(alaw: Uint8Array): Int16Array {
  const out = new Int16Array(alaw.length)
  for (let i = 0; i < alaw.length; i++) out[i] = alawToLinear(alaw[i]!)
  return out
}

/**
 * Downsample µ-law by picking every Nth sample. Used when source
 * sample rate exceeds 8kHz (e.g. AAC at 16kHz → G.711 at 8kHz).
 * Simple decimation is acceptable for speech/ambient audio.
 */
export function downsampleUlaw(data: Uint8Array, ratio: number): Uint8Array {
  const outLen = Math.floor(data.length / ratio)
  const result = new Uint8Array(outLen)
  for (let i = 0; i < outLen; i++) {
    result[i] = data[i * ratio]!
  }
  return result
}
