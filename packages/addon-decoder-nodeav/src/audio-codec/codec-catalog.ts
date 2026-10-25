/**
 * Pure, side-effect-free codec catalogue + name resolution for the
 * `audio-codec-nodeav` addon. No `node-av` import lives here so the catalogue
 * is unit-testable without the native binding — the `AVCodecID` mapping is a
 * function of an injected constants object (the real `node-av/constants` at
 * runtime, a stub in tests).
 *
 * The matrix mirrors `audio-codec-ffmpeg`'s `CODEC_CATALOG` exactly so the two
 * providers of the `audio-codec` singleton advertise the same surface —
 * `listSupportedCodecs` / `canHandle` must agree regardless of which backend
 * wins the active slot.
 */

/** PCM sample formats the sessions read / write (matches `PcmSampleFormatSchema`). */
export type AudioPcmFormat = 's16le' | 'f32le'

/**
 * Normalise an SDP-reported codec name to the libav/ffmpeg name. Mirrors
 * `audio-codec-ffmpeg`'s `resolveAudioCodecAlias` so callers can pass the
 * SDP-reported value verbatim.
 */
export function resolveAudioCodecAlias(codec: string): string {
  const c = codec.toLowerCase()
  if (c === 'mpeg4-generic') return 'aac'
  if (c === 'l16') return 'pcm_s16be'
  return c
}

export interface AudioCodecCatalogEntry {
  readonly codec: string
  readonly canDecode: boolean
  readonly canEncode: boolean
  readonly label?: string
}

/**
 * Supported codec matrix. `aac_latm` / `mpeg4-generic` are decode-only (they
 * exist only as camera-side inbound streams; the intercom back-channel encodes
 * plain `aac`). Kept byte-for-byte in step with the ffmpeg addon's catalogue —
 * `scripts/check-audio-codec-catalog-parity.ts` refuses a commit that drifts
 * one without the other.
 *
 * `pcm_s16le` / `pcm_f32le` are LINEAR PCM, and they are here for exactly one
 * reason: a `{pcm_s16le, 22050 → 8000, s16le}` DECODE session is a pure
 * libswresample rate conversion, which is what an intercom provider needs when
 * a HomeKit / Alexa / TTS caller pushes raw PCM at a rate the camera does not
 * speak. Without them the provider had nothing to call and dropped the frame
 * (D281). They are ENCODE-capable too so the pairing stays symmetric: an
 * encode session whose codec is linear PCM is the same swr pass with the
 * codec stage as a no-op, and a half-populated matrix is how the two backends
 * come to disagree about what `canHandle` means.
 */
export const CODEC_CATALOG: ReadonlyArray<AudioCodecCatalogEntry> = [
  { codec: 'pcm_mulaw', canDecode: true, canEncode: true, label: 'PCM µ-law (G.711)' },
  { codec: 'pcm_alaw', canDecode: true, canEncode: true, label: 'PCM A-law (G.711)' },
  { codec: 'pcm_s16le', canDecode: true, canEncode: true, label: 'PCM signed 16-bit LE' },
  { codec: 'pcm_f32le', canDecode: true, canEncode: true, label: 'PCM float 32-bit LE' },
  { codec: 'g722', canDecode: true, canEncode: true, label: 'G.722' },
  { codec: 'aac', canDecode: true, canEncode: true, label: 'AAC' },
  { codec: 'aac_latm', canDecode: true, canEncode: false, label: 'AAC LATM' },
  { codec: 'mpeg4-generic', canDecode: true, canEncode: false, label: 'AAC (MPEG4-GENERIC)' },
  { codec: 'opus', canDecode: true, canEncode: true, label: 'Opus' },
]

/** Resolve the catalogue entry for a codec name (alias-normalised). */
export function catalogEntryFor(codec: string): AudioCodecCatalogEntry | null {
  const resolved = resolveAudioCodecAlias(codec)
  return CODEC_CATALOG.find((e) => resolveAudioCodecAlias(e.codec) === resolved) ?? null
}

/** Cheap predicate — is `(codec, kind)` in the catalogue? */
export function codecSupports(codec: string, kind: 'decode' | 'encode'): boolean {
  const entry = catalogEntryFor(codec)
  if (!entry) return false
  return kind === 'decode' ? entry.canDecode : entry.canEncode
}

/**
 * Canonical libav codec keys this addon can drive.
 *
 * `mpeg4-generic` is an alias and resolves to `aac`, so it is absent. `l16`
 * (`pcm_s16be`) is still absent and still deliberate: RTP L16 is BIG-endian,
 * nothing in this repo produces or consumes it, and adding it would mean a
 * byte-order claim nobody has tested against a camera. Little-endian linear
 * PCM — the format every intercom caller in this repo actually pushes — IS
 * here.
 */
export type AudioCodecKey =
  | 'aac'
  | 'aac_latm'
  | 'opus'
  | 'pcm_alaw'
  | 'pcm_mulaw'
  | 'pcm_s16le'
  | 'pcm_f32le'
  | 'g722'

/**
 * Resolve an (alias-normalised) codec name to its canonical libav key, or
 * `null` for names outside this addon's SDP audio matrix. Kept pure (string
 * only) — the branded `AVCodecID` lookup lives in `nodeav-av-types.ts` where
 * node-av's constants are in scope. G.722 maps to `AV_CODEC_ID_ADPCM_G722`.
 */
export function resolveCodecKey(codec: string): AudioCodecKey | null {
  switch (resolveAudioCodecAlias(codec)) {
    case 'aac':
      return 'aac'
    case 'aac_latm':
      return 'aac_latm'
    case 'opus':
      return 'opus'
    case 'pcm_alaw':
      return 'pcm_alaw'
    case 'pcm_mulaw':
      return 'pcm_mulaw'
    case 'pcm_s16le':
      return 'pcm_s16le'
    case 'pcm_f32le':
      return 'pcm_f32le'
    case 'g722':
      return 'g722'
    default:
      return null
  }
}
