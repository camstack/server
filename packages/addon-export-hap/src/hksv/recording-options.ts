/**
 * The HomeKit Secure Video ADVERTISEMENT — `CameraRecordingOptions`, derived
 * from what the fMP4 sink will actually produce for THIS camera.
 *
 * ## The rule this file exists to enforce
 *
 * Never advertise something we cannot serve. That is not a slogan here: it is
 * the diagnosis of [D50](../../../../docs/decisions/adr-0050.md) — an
 * advertised `recording` whose delegate yielded nothing put every motion-capable
 * camera into a ~12 s timeout loop every 20-60 s, all day. So every number below
 * is derived from the picked source (`recording-source.ts`) or from a measured
 * property of the sink, and none of them is a plausible-looking constant.
 *
 * ## The fragment length is the subtle one
 *
 * HKSV requires every media fragment to be **no longer** than the length the
 * controller selected. On the copy branch the fragment length is the SOURCE's
 * key-frame cadence ([D80](../../../../docs/decisions/adr-0080.md)) — we do not
 * get to choose it, we can only be honest about it. So:
 *
 *  - when the camera reports its GOP (`stream-params`), the advertised length is
 *    the smallest offered value that COVERS it;
 *  - when it does not, we advertise the 4000 ms every HKSV camera uses and the
 *    delegate warns at `warn` with `tags: { deviceId }` if the fragments that
 *    actually arrive are longer.
 *
 * A camera whose GOP exceeds the longest value we offer does not advertise
 * recording at all. See {@link deriveFragmentLengthMs}.
 */

import type { CameraRecordingOptions, Resolution } from '@homebridge/hap-nodejs'
import {
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  H264Level,
  H264Profile,
  MediaContainerType,
  VideoCodecType,
} from '@homebridge/hap-nodejs'

/**
 * The prebuffer we promise. HAP's floor is 4000 ms and its documented sensible
 * range is [4000, 8000]; the plane's ring is sized from this, so the two cannot
 * disagree. Asking for more than we retain would be the same lie in the other
 * direction.
 */
export const HKSV_PREBUFFER_MS = 4_000

/**
 * The fragment lengths we are willing to advertise, shortest first. 4000 ms is
 * what every shipping HKSV camera uses; 8000 exists for a camera whose GOP is
 * 8 s, which is common enough on this fleet's defaults to be worth covering
 * rather than refusing.
 */
export const HKSV_FRAGMENT_LENGTHS_MS: readonly number[] = [4_000, 8_000]

/**
 * AAC-LC at 24 kHz mono. Fixed rather than negotiated: an fMP4 fragment carries
 * its audio in-band, so unlike the live SRTP path there is no second plane on
 * which to answer a different sample rate, and D80 records that HKSV takes AAC
 * and nothing else.
 */
export const HKSV_AUDIO_SAMPLE_RATE_HZ = 24_000
export const HKSV_AUDIO_BITRATE_KBPS = 32

/**
 * The frame rates the advertised {@link Resolution} may carry, and the only
 * ones. See {@link normaliseAdvertisedFps} for why the measured rate does not
 * go in raw.
 */
export const HKSV_ADVERTISED_FRAME_RATES: readonly number[] = [15, 24, 30]

export interface RecordingOptionsInput {
  /** The slot the fragment child will pull, from `pickRecordingSource`. */
  readonly width: number
  readonly height: number
  /**
   * Frames per second of that slot, as the broker/provider reports it. Used for
   * the advertised {@link Resolution}, which is a `[w, h, fps]` triple.
   */
  readonly fps: number
  /** The advertised fragment length, from {@link deriveFragmentLengthMs}. */
  readonly fragmentLengthMs: number
  /** The source's video bitrate in kbps, when the camera reports it. */
  readonly bitrateKbps?: number
}

/**
 * The advertised fragment length for a camera whose key-frame cadence is
 * `sourceGopMs`, or `null` when no offered length covers it.
 *
 * `undefined` — the camera does not report a GOP — takes the shortest offered
 * length. That is a guess, and it is the RIGHT guess (4 s is the near-universal
 * default), but it is a guess: the delegate measures the arriving cadence and
 * says so when reality disagrees.
 */
export function deriveFragmentLengthMs(sourceGopMs: number | undefined): number | null {
  const shortest = HKSV_FRAGMENT_LENGTHS_MS[0]
  if (shortest === undefined) return null
  if (sourceGopMs === undefined || sourceGopMs <= 0) return shortest
  const covering = HKSV_FRAGMENT_LENGTHS_MS.find((ms) => ms >= sourceGopMs)
  return covering ?? null
}

/**
 * The frame rate to ADVERTISE for a slot that was measured at `measuredFps` —
 * the nearest member of {@link HKSV_ADVERTISED_FRAME_RATES}, ties going to the
 * lower rate.
 *
 * The measured rate does not go into the advertisement raw, for two reasons,
 * and the second one is the serious one.
 *
 * **It is the list the controller chooses from.** `[1280, 720, 10]` — 101's
 * measured 720p slot — is a frame rate no shipping HKSV camera offers, and the
 * controller has to find an acceptable configuration in what we advertise
 * before it will write one back.
 *
 * **A measurement makes the advertisement UNSTABLE, and hap-nodejs punishes
 * that by discarding the controller's selection.** `RecordingManagement`
 * hashes the supported-configuration TLVs and, on restore, keeps the persisted
 * `selectedConfiguration` only while the hash still matches — otherwise
 * `deserialize: discarding saved selectedConfiguration`, after which the
 * accessory answers every HDS `DATA_SEND OPEN` with `INVALID_CONFIGURATION`
 * and records nothing until the controller happens to re-select. The
 * advertised resolution is the one hashed input that came from a probe:
 * camera 104 measured 9 fps on one restart and 10 on the next, on
 * 2026-08-07/08, so this was a self-inflicted outage waiting on a reboot.
 * Quantising gives the probe a wide band to move inside without the
 * advertisement changing at all.
 */
export function normaliseAdvertisedFps(measuredFps: number): number {
  const fallback = HKSV_ADVERTISED_FRAME_RATES[0] ?? 15
  if (!Number.isFinite(measuredFps) || measuredFps <= 0) return fallback
  let best = fallback
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of HKSV_ADVERTISED_FRAME_RATES) {
    const distance = Math.abs(candidate - measuredFps)
    // Strictly less: a tie keeps the lower rate, because the list is ascending
    // and over-claiming a rate is the direction that lies about the source.
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Build the advertisement.
 *
 * ONE resolution is advertised — the one slot the recording child pulls. HAP's
 * documentation lists 1920×1080 and 1280×720 as "required to be supported", and
 * listing both when the source is only one of them is precisely the D50 failure
 * in miniature: iOS would select a configuration we then cannot deliver, on the
 * copy branch, with no encoder to resize with.
 */
export function buildRecordingOptions(input: RecordingOptionsInput): CameraRecordingOptions {
  const resolution: Resolution = [input.width, input.height, normaliseAdvertisedFps(input.fps)]
  return {
    prebufferLength: HKSV_PREBUFFER_MS,
    mediaContainerConfiguration: {
      type: MediaContainerType.FRAGMENTED_MP4,
      fragmentLength: input.fragmentLengthMs,
    },
    video: {
      type: VideoCodecType.H264,
      parameters: {
        // Every profile and level the SOURCE might already be encoded in: this
        // is a copy branch, so the accessory does not choose them — it reports
        // that it will pass through whatever the camera produces. Narrowing
        // this to the camera's current setting would withdraw recording every
        // time an operator changed the camera's encoder profile.
        profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
      },
      resolutions: [resolution],
    },
    audio: {
      codecs: [
        {
          type: AudioRecordingCodecType.AAC_LC,
          audioChannels: 1,
          bitrateMode: AudioBitrate.VARIABLE,
          samplerate: [AudioRecordingSamplerate.KHZ_24],
        },
      ],
    },
  }
}
