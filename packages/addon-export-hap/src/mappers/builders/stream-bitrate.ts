/**
 * Send a stream that FITS the rate HomeKit negotiated. (R5)
 *
 * The controller's own Receiver Reports, read on the live hub on 2026-08-06,
 * closed a year of guessing: one 19.27 s session on `101/mid` forwarded 737
 * video packets at `mtu=1378` — roughly **421 kbps** — against a negotiated
 * `max_bit_rate` of **299**, and iOS reported losing **450 of those 737
 * packets (61 %)**, worst fraction lost 51.2 %, peak jitter 3.03 s. Under
 * `-c:v copy` the accessory has no lever at all: it forwards whatever the
 * camera's encoder produces, at whatever cadence it produces it.
 *
 * So the fix has two halves, and this module owns both:
 *
 *   1. **Choose a slot that fits.** Among the slots that can be passed through
 *      (H.264) and whose rate is known to be within budget, the existing
 *      resolution-closest picker decides — so the "which slot serves which
 *      resolution" opinion stays single, exactly as D51 requires.
 *   2. **Transcode only when none does**, with a real cap
 *      (`-b:v` / `-maxrate` / `-bufsize`) at the negotiated rate.
 *
 * ## Where the authoritative rate comes from, and why it is NOT the obvious one
 *
 * `webrtcSession.listStreams` reports a `bitrateKbps` per slot and it is a
 * **measured flow rate**, which is meaningless for a slot nobody is consuming.
 * Live on 2026-08-06 it reported `mid = 9 kbps` for the very slot that had just
 * delivered ~421 kbps, `low = 5 kbps`, and `high = 5441 kbps` (high was being
 * consumed, hence plausible). Selecting on that reading would admit every slot.
 *
 * The authority is therefore the camera's **configured** encoder rate, from
 * `streamParams.getStatus` — `main` / `sub` / `ext`, each carrying the
 * `bitrate` the operator (or the vendor default) set. On 101 that is
 * `main 8192`, `sub 2048`, `ext 2048` kbps. It is mapped onto a profile slot
 * through the slot's assigned cam-stream, matched on resolution and frame
 * rate; an ambiguous or absent match is reported as **unknown**, never as a
 * number.
 *
 * This inverts D51's ordering — there, `measured` outranks `published` — and
 * the inversion is deliberate:
 *
 *   - a frame rate is a stable property of the source and a measurement of it
 *     is the *best* evidence;
 *   - a bitrate under VBR is an envelope. A measurement is a **lower bound**
 *     on it, and a lower bound can prove a slot does NOT fit but can never
 *     prove that it does.
 *
 * So `measured` is kept, and used only in the direction it is sound in.
 * Everything here is pure; the cap reads live in `stream-bitrate-probe.ts`.
 */
import { type ConnectionClass, slotForConnection } from './stream-connection.js'
import { averageBitrateKbpsFor } from '../../multi-tier/tiers-for-sensor.js'

import type {
  CameraStream,
  CamProfile,
  FfmpegVideoPlan,
  PickedStream,
  ProfileRtspEntry,
  ProfileSlot,
  StreamParamsStatus,
  WebrtcStreamChoice,
} from '@camstack/types'
import {
  HAP_KEYFRAME_INTERVAL_SEC,
  pickPreferredRtspEntry,
  RATE_CONTROL_TIGHT,
} from '@camstack/types'

/**
 * Fraction of the negotiated ceiling we actually aim the encoder at.
 *
 * `max_bit_rate` is what the controller budgeted for the stream; what crosses
 * the wire is the encoded payload PLUS its packetisation. At `mtu = 1378` each
 * packet carries a 12-byte RTP header and a 10-byte SRTP auth tag, and the
 * datagram adds 8 (UDP) + 20 (IPv4) — 50 bytes on ~1378, i.e. **3.6 %**. The
 * remaining ~6 % is margin for a VBV overshoot inside the buffer window.
 * Reserving it is the difference between "at the ceiling" and "over it".
 */
export const BITRATE_HEADROOM = 0.9

/**
 * Below this, a measured flow reading carries no information about the
 * stream's rate — it means the slot is idle.
 *
 * The lowest rate HomeKit itself considers a video stream is 180 kbps (240p,
 * per the HKSV compatibility guide's normative table). A reading an order of
 * magnitude under that cannot be a live H.264 stream at any resolution we
 * serve; it is the broker reporting an unconsumed slot. Set well below the
 * normative floor so a genuinely frugal camera is still believed.
 */
export const MIN_PLAUSIBLE_MEASURED_KBPS = 64

/** Encoder slots a `stream-params` provider exposes, in the cap's own order. */
const ENCODER_PROFILE_KEYS = ['main', 'sub', 'ext'] as const
type EncoderProfileKey = (typeof ENCODER_PROFILE_KEYS)[number]

/** What we know about one profile slot's rate. `null` means "not known". */
export interface ProfileBitrateEvidence {
  readonly profile: CamProfile
  /** Camera's CONFIGURED encoder ceiling, kbps. Authoritative both ways. */
  readonly publishedKbps: number | null
  /** Broker's MEASURED flow, kbps — a lower bound, and only when plausible. */
  readonly measuredKbps: number | null
}

export type ProfileBitrateMap = ReadonlyMap<CamProfile, ProfileBitrateEvidence>

export interface ResolveProfileBitratesInput {
  /** `cameraStreams.getBrokerStreams` — maps a profile to its source. */
  readonly slots: readonly ProfileSlot[]
  /** `cameraStreams.getCameraStreams` — the source's resolution and fps. */
  readonly camStreams: readonly CameraStream[]
  /** `streamParams.getStatus` — the camera's configured encoder rates. */
  readonly streamParams: StreamParamsStatus | null
  /** `webrtcSession.listStreams` — the broker's measured flow. */
  readonly choices: readonly WebrtcStreamChoice[]
}

/** Whether a slot's rate is known to fit the budget. */
export type BitrateFitVerdict = 'fits' | 'over-budget' | 'unknown'

/** One candidate slot's verdict, carried into the log so it can say WHY. */
export interface ProfileFitNote {
  readonly profile: CamProfile
  readonly verdict: BitrateFitVerdict
  readonly publishedKbps: number | null
  readonly measuredKbps: number | null
}

export type CopyReason = 'source-fits-budget' | 'no-negotiated-budget' | 'over-budget-tolerated'
export type TranscodeReason = 'over-budget' | 'unknown-bitrate' | 'source-codec' | 'over-resolution'

interface StreamFitBase {
  readonly picked: PickedStream
  readonly profile: CamProfile | null
  /**
   * The rate the encoder is aimed at when transcoding. `null` when the
   * controller negotiated no usable ceiling — then nothing is capped, because
   * `-maxrate 0k` caps nothing while looking like it does.
   */
  readonly budgetKbps: number | null
  readonly notes: readonly ProfileFitNote[]
}

export interface StreamCopyDecision extends StreamFitBase {
  readonly kind: 'copy'
  readonly reason: CopyReason
}

export interface StreamTranscodeDecision extends StreamFitBase {
  readonly kind: 'transcode'
  readonly reason: TranscodeReason
}

export type StreamFitDecision = StreamCopyDecision | StreamTranscodeDecision

export interface SelectStreamForBudgetInput {
  /** `cameraStreams.getProfileRtspEntries`, codec-enriched via {@link withSlotCodecs}. */
  readonly entries: readonly ProfileRtspEntry[]
  readonly deviceId: number
  /** Operator's `streamPreference` — `'auto'` or a pinned profile. */
  readonly pref: 'auto' | string
  /** The resolution the controller negotiated. */
  readonly targetResolution: { readonly width: number; readonly height: number }
  /**
   * How this controller is connected, from {@link classifyConnection}. With
   * `pref === 'auto'` this — NOT the negotiated resolution — decides the slot,
   * because resolution proximity is what kept selecting 101's 10 fps `mid`.
   */
  readonly connection: ConnectionClass
  /** `request.video.max_bit_rate`, kbps. */
  readonly negotiatedMaxBitrateKbps: number
  readonly bitrates: ProfileBitrateMap
  /**
   * Whether an H.265 source may be passed through untouched.
   *
   * True only for a session negotiated on Apple's multi-tier RTP service,
   * which advertises `VideoCodecType 2 = H.265` in its tiers. The classic HAP
   * SRTP path renders H.264 only, and HEVC there is a black picture with no
   * error — so absent means false, which is what every existing caller means.
   */
  readonly allowHevcPassthrough?: boolean | undefined
}

/**
 * Resolve every profile slot's rate from the camera's configuration, with the
 * broker's flow reading kept alongside it as a lower bound.
 *
 * A slot with neither simply carries two nulls — absence is never rendered as
 * a number, because a wrong number here silently re-creates the overshoot this
 * module exists to end.
 */
export function resolveProfileBitrates(input: ResolveProfileBitratesInput): ProfileBitrateMap {
  const camStreamById = new Map<string, CameraStream>()
  for (const stream of input.camStreams) camStreamById.set(stream.camStreamId, stream)

  const measuredByProfile = new Map<CamProfile, number>()
  for (const choice of input.choices) {
    if (choice.target.kind !== 'profile') continue
    const plausible = plausibleMeasured(choice.bitrateKbps)
    if (plausible !== null) measuredByProfile.set(choice.target.profile, plausible)
  }

  const out = new Map<CamProfile, ProfileBitrateEvidence>()
  for (const slot of input.slots) {
    const source =
      slot.sourceCamStreamId === null ? undefined : camStreamById.get(slot.sourceCamStreamId)
    out.set(slot.profile, {
      profile: slot.profile,
      publishedKbps: publishedRateFor(slot, source, input.streamParams),
      measuredKbps: measuredByProfile.get(slot.profile) ?? null,
    })
  }

  // A slot the broker did not list can still have been measured; record the
  // reading rather than dropping the slot from the map entirely.
  for (const [profile, measured] of measuredByProfile) {
    if (out.has(profile)) continue
    out.set(profile, { profile, publishedKbps: null, measuredKbps: measured })
  }

  return out
}

/**
 * The rate the encoder may actually use, or `null` when the controller
 * negotiated no usable ceiling.
 */
export function budgetForNegotiatedRate(negotiatedMaxBitrateKbps: number): number | null {
  if (!Number.isFinite(negotiatedMaxBitrateKbps) || negotiatedMaxBitrateKbps <= 0) return null
  const budget = Math.floor(negotiatedMaxBitrateKbps * BITRATE_HEADROOM)
  return budget > 0 ? budget : null
}

/**
 * The rate a TRANSCODE may actually aim at.
 *
 * Measured on the hub, 2026-09-17: two cameras on the same link, both with a
 * negotiated ceiling of 299 kbps. The H.264 one was passed through at **8192
 * kbps** under `over-budget-tolerated`; the H.265 one, which must be
 * re-encoded, was held to **269**. Thirty times less, decided entirely by
 * which branch the camera fell into.
 *
 * That asymmetry contradicts the rule this module already adopted for copy:
 * *"the negotiated ceiling is a budget the controller copes with being
 * exceeded, not a contract that must be met"*, evidenced by a reference NVR
 * doing exactly that. The copy path stopped treating it as a contract and the
 * transcode path did not.
 *
 * So the negotiated budget becomes a FLOOR and the guide's own normative
 * average for the DELIVERED resolution becomes the target (§ 2: 1080p30 →
 * 1700, 720p30 → 768, 360p → 180). Two properties matter:
 *
 *  - it never LOWERS a budget the controller was willing to grant — a
 *    controller asking for more gets more;
 *  - it changes nothing for a relayed session, which negotiates 360p, where
 *    the guide asks less than the controller already granted. Spending an
 *    Apple relay's bandwidth for no picture gain is not an improvement.
 *
 * `null` stays `null`: it means "pass no `-maxrate` at all", and inventing a
 * number here would cap a stream that was deliberately uncapped.
 */
export function encodeBudgetKbps(input: {
  readonly negotiatedBudgetKbps: number | null
  /** The width we will DELIVER, not the sensor's. */
  readonly width: number
}): number | null {
  if (input.negotiatedBudgetKbps === null) return null
  return Math.max(input.negotiatedBudgetKbps, averageBitrateKbpsFor(input.width))
}

/**
 * Does this slot fit?
 *
 * Only the CONFIGURED rate can answer yes. The measured rate is a lower bound,
 * so it is allowed to answer no — including against an optimistic publication.
 */
export function classifyBitrateFit(
  evidence: ProfileBitrateEvidence | undefined,
  budgetKbps: number,
): BitrateFitVerdict {
  if (evidence === undefined) return 'unknown'
  const { publishedKbps, measuredKbps } = evidence
  if (measuredKbps !== null && measuredKbps > budgetKbps) return 'over-budget'
  if (publishedKbps === null) return 'unknown'
  return publishedKbps <= budgetKbps ? 'fits' : 'over-budget'
}

/**
 * Pick the stream to serve, and decide whether it can be passed through.
 *
 * The selection runs the SAME `pickPreferredRtspEntry` the advertisement is
 * derived from (D51) — only the candidate set narrows. When at least one
 * pass-through-capable slot fits the budget, the picker resolves the target
 * resolution among those and we copy. Otherwise the picker resolves among ALL
 * entries — so the transcode decodes the slot closest to the negotiated
 * resolution rather than the largest one on the camera — and we re-encode.
 *
 * A pinned `streamPreference` is never overridden by the budget: the pinned
 * slot is transcoded rather than swapped for a cheaper one.
 *
 * Returns `null` when nothing is publishable at all.
 */
export function selectStreamForBudget(input: SelectStreamForBudgetInput): StreamFitDecision | null {
  const budgetKbps = budgetForNegotiatedRate(input.negotiatedMaxBitrateKbps)
  const notes = fitNotes(input.entries, input.bitrates, budgetKbps)
  const allowHevc = input.allowHevcPassthrough === true

  // An operator pin always wins. Otherwise the CONNECTION names the slot, and
  // the negotiated resolution keeps only its tie-breaking job inside whatever
  // that leaves. `targetResolution` still travels because a slot named here
  // may not exist on a given camera, and then proximity is the sane fallback.
  const effectivePref = input.pref === 'auto' ? slotForConnection(input.connection) : input.pref

  const fallback = pickPreferredRtspEntry(input.entries, effectivePref, input.deviceId, {
    targetResolution: input.targetResolution,
  })
  if (fallback === null) return null
  const fallbackProfile = toCamProfile(fallback.profileId)

  // No ceiling to fit against: behave exactly as the pre-R5 path did, except
  // that a source we cannot pass through is still transcoded.
  if (budgetKbps === null) {
    const base = { picked: fallback, profile: fallbackProfile, budgetKbps: null, notes }
    if (!canPassThrough(fallback.codec, allowHevc)) {
      return { kind: 'transcode', reason: 'source-codec', ...base }
    }
    if (!fitsRequestedResolution(fallback, input.targetResolution)) {
      return { kind: 'transcode', reason: 'over-resolution', ...base }
    }
    return { kind: 'copy', reason: 'no-negotiated-budget', ...base }
  }

  // A PINNED preference is an operator instruction about which slot to serve,
  // and the budget is a consumer constraint about how much of it to send. They
  // are not in competition: an over-budget pinned slot is transcoded, never
  // silently swapped for a cheaper one. Only `auto` lets the budget change
  // which slot wins.
  const pinned = input.pref !== 'auto' && fallbackProfile === input.pref
  const candidates = pinned
    ? input.entries.filter((entry) => entry.profile === fallbackProfile)
    : input.entries

  const affordable = candidates.filter((entry) => {
    if (!canPassThrough(entry.codec, allowHevc)) return false
    if (!fitsRequestedResolution(entry, input.targetResolution)) return false
    return classifyBitrateFit(input.bitrates.get(entry.profile), budgetKbps) === 'fits'
  })
  if (affordable.length > 0) {
    const picked = pickPreferredRtspEntry(affordable, effectivePref, input.deviceId, {
      targetResolution: input.targetResolution,
    })
    if (picked !== null) {
      return {
        kind: 'copy',
        reason: 'source-fits-budget',
        picked,
        profile: toCamProfile(picked.profileId),
        budgetKbps,
        notes,
      }
    }
  }

  // NOTHING FITS — and that is not, on its own, a reason to transcode.
  //
  // R5 assumed it was: the controller negotiated 299 kbps, every slot on the
  // fleet is configured at 2048 or more, so every session transcoded. Then the
  // operator supplied the datum that settles it — a mature reference NVR serves
  // this same camera, over the same protocol, with pass-through, and the
  // picture appears immediately. So the negotiated ceiling is a budget the
  // controller copes with being exceeded, not a contract that must be met.
  //
  // The reference's rule is the one adopted here: **transcode only when the
  // source cannot be passed through at all** — a codec the controller does not
  // speak. The bitrate evidence keeps its job of PREFERRING a slot that fits
  // (above), it simply no longer forces a re-encode when none does.
  //
  // What this gives up, said plainly: a genuinely constrained link now receives
  // more than it asked for. That was already true for the reference, and it was
  // already true here before R5. The measured loss that made over-budget look
  // guilty was the unpaced join burst, fixed separately — a 20x instantaneous
  // overshoot at connect, not the steady rate.
  if (
    canPassThrough(fallback.codec, allowHevc) &&
    fitsRequestedResolution(fallback, input.targetResolution)
  ) {
    return {
      kind: 'copy',
      reason: 'over-budget-tolerated',
      picked: fallback,
      profile: fallbackProfile,
      budgetKbps,
      notes,
    }
  }

  return {
    kind: 'transcode',
    reason: transcodeReason(
      fallback,
      fallbackProfile,
      input.bitrates,
      budgetKbps,
      allowHevc,
      input.targetResolution,
    ),
    picked: fallback,
    profile: fallbackProfile,
    budgetKbps,
    notes,
  }
}

/**
 * Fill in a codec the profile restream entry did not carry, from its broker
 * slot. `getProfileRtspEntries` has historically omitted it for legacy
 * entries, and a slot whose codec is unknown must not be mistaken for H.264.
 */
export function withSlotCodecs(
  entries: readonly ProfileRtspEntry[],
  slots: readonly ProfileSlot[],
): readonly ProfileRtspEntry[] {
  const codecByProfile = new Map<CamProfile, string>()
  for (const slot of slots) {
    if (slot.codec !== undefined) codecByProfile.set(slot.profile, slot.codec)
  }
  return entries.map((entry) => {
    if (entry.codec !== undefined) return entry
    const codec = codecByProfile.get(entry.profile)
    return codec === undefined ? entry : { ...entry, codec }
  })
}

export interface VideoEncodeArgsInput {
  readonly transcode: boolean
  readonly width: number
  readonly height: number
  /** Already resolved through {@link deliverableFps}. */
  readonly fps: number
  readonly budgetKbps: number | null
  /** The H.264 profile the CONTROLLER selected. Absent keeps the pre-existing
   *  constant, so callers that never carried it are unchanged. */
  readonly profile?: 'baseline' | 'main' | 'high'
  readonly level?: '3.1' | '3.2' | '4.0'
}

/**
 * The video half of the ffmpeg plan, in the SHARED vocabulary
 * (`@camstack/types` `ffmpeg/invocation.ts`). This function used to emit
 * arguments; it now describes them, and `buildFfmpegArgs` emits every one — the
 * repo keeps exactly one argv builder, and HomeKit stopped being an exception
 * to that (D67, `scripts/check-ffmpeg-primitive.ts` Rule 1).
 *
 * Nothing about the RESULT changed except the rescale spelling: `-s WxH` became
 * `-vf scale=W:H`. Equivalent for a plain rescale, and worth knowing because
 * the two are NOT interchangeable once another `-vf` is in play.
 *
 * Pass-through carries `-bsf:v dump_extra` so every IDR inlines its own
 * SPS/PPS — sources that publish parameter sets only in the RTSP SDP hand iOS
 * a keyframe it cannot decode otherwise.
 *
 * The transcode's cap is three flags, not one: `-b:v` is an average and on its
 * own permits exactly the burst that was measured. `-maxrate` plus a
 * **one-second** `-bufsize` bounds any one-second window at the negotiated
 * rate, which is also the only lever available on the 3.03 s peak jitter — the
 * VBV window is what forces x264 to size a key frame to fit rather than
 * emitting it as one tight burst. That window is {@link RATE_CONTROL_TIGHT},
 * the shared constant whose whole reason to exist is HomeKit's per-second
 * budget; the browser and Echo use the relaxed two-second one.
 *
 * **The encoder stays `libx264`, deliberately.** `h264_vaapi` / `h264_qsv`
 * carry their own rate-control model, do not accept `-profile:v baseline`, and
 * emit parameter sets on their own schedule rather than x264's — which puts the
 * two load-bearing flags below back in play, with no hardware here to prove
 * they still hold. Hardware DECODE is where the measured cost is.
 */
/**
 * The least this encoder can be given per pixel and still produce a picture a
 * decoder will lock onto.
 *
 * Not a quality target — a DECODABILITY one. The encode is pinned to
 * `ultrafast` + `zerolatency` + `baseline`, the three settings that trade
 * compression efficiency away for latency, so it needs more bits than a
 * default encoder would, not fewer.
 *
 * `0.03` is not invented: it is what the 269 kbps / 720p fixture this module
 * was tuned against works out to AT 10 FPS, which is the rate that fixture
 * dials and the rate the earlier overshoot fix was measured at.
 */
const MIN_BITS_PER_PIXEL = 0.03

/**
 * The highest frame rate this budget can carry at this picture size.
 *
 * ## Why the FPS gives and not the bitrate
 *
 * The obvious move is to lift the bitrate until the picture is decodable. This
 * module already refused that once, for a reason recorded in its tests: an
 * encoder overshooting its ceiling (421 kbps against 299 negotiated) produced
 * three seconds of jitter, and the one-second VBV window is the only lever
 * there is on it. Raising the ceiling would buy a decodable picture and pay
 * for it in the exact currency that incident was about.
 *
 * So the ceiling holds and the frame rate gives way. A stream at 10 fps that
 * DECODES beats one at 30 fps that does not — and the controller never asked
 * for 30 in particular; it asked for a ceiling and a maximum rate.
 *
 * ## The measurement behind it
 *
 * Operator, 2026-09-16: the one H.265 camera shows a loader in the Home app,
 * the three H.264 ones are fine. H.264 is pass-through, H.265 is transcode.
 * Same controller, same 299 kbps ceiling: pass-through delivered 714 video
 * packets/s and worked; the transcode delivered 66 and produced a loader with
 * a `decode-suspect` verdict, three sessions running. It was encoding 1280x720
 * at 30 fps into 269 kbps — about 0.01 bits per pixel, a third of what the
 * fixture this was tuned on gets.
 */
export function fpsForBudget(
  budgetKbps: number,
  width: number,
  height: number,
  requestedFps: number,
): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  // ROUNDED, not floored: we are picking the nearest rate the budget carries,
  // not the largest strictly-affordable one. Flooring costs the calibration
  // point itself a frame — 269 kbps at 720p works out to 9.7 fps, and the
  // configuration this module was tuned on dials 10.
  const affordableFps = Math.round((budgetKbps * 1000) / (pixels * MIN_BITS_PER_PIXEL))
  // Never below 1: a zero-fps encode is not a slower stream, it is no stream,
  // and a budget too small even for one frame a second is a case to be seen in
  // the logs rather than silently turned into nothing.
  return Math.max(1, Math.min(requestedFps, affordableFps))
}

export function buildVideoPlan(input: VideoEncodeArgsInput): FfmpegVideoPlan {
  // The SAME reason the encode branch carries it, for a different mechanism:
  // a source that publishes its parameter sets only in the RTSP SDP hands iOS
  // a keyframe it has nothing to decode with.
  if (!input.transcode) return { kind: 'copy', bitstreamFilter: 'dump_extra' }
  // LOWERED when the budget cannot carry the asked-for rate at this size —
  // see `fpsForBudget`. The ceiling is what the controller enforces on
  // itself; the frame rate is ours to give. Resolved ONCE, because both `-r`
  // and `-g` below must speak about the same rate.
  const deliveredFps =
    input.budgetKbps === null
      ? input.fps
      : fpsForBudget(input.budgetKbps, input.width, input.height, input.fps)
  return {
    kind: 'encode',
    encoder: 'libx264',
    scale: { mode: 'exact', width: input.width, height: input.height },
    preset: 'ultrafast',
    tune: 'zerolatency',
    // ONE slice per access unit. (D515)
    //
    // `-tune zerolatency` turns on x264's sliced threads, and on this hub
    // (20 cores) a 720p access unit left the encoder as ELEVEN slices —
    // eleven NAL units sharing one RTP timestamp and one marker bit.
    // Captured on the live hub 2026-09-16 with the exact argv this plan
    // emits. The pass-through cameras, captured the same way, deliver one
    // slice per access unit, and those are the cameras that work; the
    // transcode was the only path handing the controller a fragmented
    // access unit, and the only one it refused to draw. The Echo had already
    // failed on the same shape three days earlier (`ALEXA_EGRESS_PROFILE`).
    //
    // The tune STAYS: it is the lookahead and the B-frames we want gone.
    singleSlicePerFrame: true,
    // WHAT THE CONTROLLER SELECTED, not what we felt like.
    //
    // We advertise baseline, main and high — and then encoded baseline 3.1
    // whatever the answer, which is an advertisement we never honoured.
    // Pass-through never had the problem: it forwards the camera's own
    // stream, at whatever profile that is, and those cameras work.
    //
    // Falls back to the old constants when the caller does not know, so the
    // paths that never carried the selection behave exactly as before.
    //
    // Known limit, measured: x264 writes the profile_idc from the features it
    // USES, and `ultrafast` disables CABAC, 8x8 DCT and B-frames — so the
    // bitstream is Constrained Baseline whatever `-profile:v` says (ffprobe
    // on the live capture: `profile="Constrained Baseline"`, `level=40`).
    // The flag only ever RESTRICTS; honouring the selection here is about the
    // level and about not lying in the log, not about the profile bits.
    profile: input.profile ?? 'baseline',
    level: input.level ?? '3.1',
    pixelFormat: 'yuv420p',
    fps: deliveredFps,
    // FORCED, because x264's own default is 250 frames and nothing here would
    // have overridden it: at the 10 fps we dial for a 720p slot that is ONE
    // IDR EVERY 25 SECONDS. A controller joining mid-GOP then receives every
    // packet intact and has nothing to start decoding from — measured on the
    // live hub as 63 receiver reports, 0% loss, 1 packet lost across the whole
    // session, a loader on screen, and a teardown at 31.5 s.
    //
    // Four seconds of spacing at the rate we ACTUALLY deliver — `deliveredFps`,
    // AFTER the budget has lowered it, which is what the reference
    // implementation dials too. Deriving it from the REQUESTED rate put the
    // IDR twelve seconds apart the moment the budget lowered 30 fps to 10
    // (`maxKeyframeGapMs=12040` on the live hub, and `VBV underflow (frame
    // 121)` from x264 on the IDR that then had to fit).
    gopFrames: Math.max(1, Math.round(deliveredFps * HAP_KEYFRAME_INTERVAL_SEC)),
    ...(input.budgetKbps === null
      ? {}
      : {
          bitrateKbps: input.budgetKbps,
          rateControl: RATE_CONTROL_TIGHT,
        }),
    // ffmpeg's RTP muxer declares `AVFMT_GLOBALHEADER`, so libx264 is asked for
    // a global header: SPS/PPS land in extradata and are NOT emitted before
    // each IDR. They would then travel only in an SDP — which HAP does not
    // carry, because it negotiates its own. The controller receives key frames
    // it has no parameter sets for, decodes nothing, and reports no loss while
    // doing it. Measured: 65 receiver reports, 5 packets lost across 1,272, a
    // loader on screen for the full 32.6 s.
    //
    // `dump_extra` re-inlines them ahead of every IDR, so each key frame is
    // self-contained — which is also what makes a mid-GOP join decodable at
    // all, and therefore what the `-g` above is worth anything for.
    bitstreamFilter: 'dump_extra',
  }
}

/** Compact `mid=2048pub/9meas:over-budget` rendering for a single log field. */
export function formatFitNotes(notes: readonly ProfileFitNote[]): readonly string[] {
  return notes.map(
    (n) => `${n.profile}=${n.publishedKbps ?? '?'}pub/${n.measuredKbps ?? '?'}meas:${n.verdict}`,
  )
}

function fitNotes(
  entries: readonly ProfileRtspEntry[],
  bitrates: ProfileBitrateMap,
  budgetKbps: number | null,
): readonly ProfileFitNote[] {
  return entries.map((entry) => {
    const evidence = bitrates.get(entry.profile)
    return {
      profile: entry.profile,
      verdict: budgetKbps === null ? 'unknown' : classifyBitrateFit(evidence, budgetKbps),
      publishedKbps: evidence?.publishedKbps ?? null,
      measuredKbps: evidence?.measuredKbps ?? null,
    }
  })
}

function transcodeReason(
  picked: PickedStream,
  profile: CamProfile | null,
  bitrates: ProfileBitrateMap,
  budgetKbps: number,
  allowHevc: boolean,
  target: { readonly width: number; readonly height: number },
): TranscodeReason {
  if (!canPassThrough(picked.codec, allowHevc)) return 'source-codec'
  if (!fitsRequestedResolution(picked, target)) return 'over-resolution'
  if (profile === null) return 'unknown-bitrate'
  const verdict = classifyBitrateFit(bitrates.get(profile), budgetKbps)
  return verdict === 'over-budget' ? 'over-budget' : 'unknown-bitrate'
}

/**
 * Which source codecs may go on the wire untouched.
 *
 * H.264 always. H.265 only when the SESSION was negotiated on Apple's
 * multi-tier RTP service, which advertises `VideoCodecType 2 = H.265` in its
 * tiers — the classic HAP SRTP path renders H.264 only, and sending HEVC there
 * is a black picture with no error.
 *
 * The permission belongs to the session rather than to the camera because the
 * same camera serves both services: which one negotiated decides what may be
 * copied. Refusing HEVC on the new service transcodes 4K HEVC down to H.264
 * for a controller that explicitly asked for the HEVC, which is the entire cost
 * that service exists to remove.
 *
 * An UNKNOWN codec is refused on BOTH. Guessing H.264 is how a camera that
 * changed its encoder ends up shipping bytes no controller can decode, and the
 * new service's permission is for H.265 specifically — not for "whatever this
 * turns out to be".
 */
function canPassThrough(codec: string | undefined, allowHevc: boolean): boolean {
  if (codec === undefined) return false
  const lower = codec.toLowerCase()
  if (lower.includes('h265') || lower.includes('hevc')) return allowHevc
  return lower.includes('h264') || lower.includes('avc')
}

/**
 * May this slot be forwarded UNTOUCHED at the resolution the controller asked
 * for?
 *
 * Measured on the hub, 2026-09-17, from iOS's own Receiver Reports: two
 * cameras forwarding a 3840x2160 slot to a controller that had negotiated
 * 1280x720, and the busier of the two reported losing **52.7 %** of packets in
 * its worst window, 102 packets cumulative, jitter 54 618. The third camera,
 * transcoded to 720p because its source is HEVC, lost one packet. The operator
 * saw this as "the H.264 cameras are slower to load than the H.265 one" — and
 * they were, because a 4K key frame spans hundreds of packets and losing any
 * one of them makes the picture wait for the next key frame, up to 3.5 s away.
 *
 * `over-budget-tolerated` is unchanged and still right: a RATE overshoot is
 * something a controller copes with. A RESOLUTION overshoot is a different
 * thing — it hands the controller a picture it never asked to decode.
 *
 * Smaller than asked for is fine and is copied: we cannot add detail, and an
 * encoder run that only enlarges pixels spends CPU to make the picture no
 * better and the stream bigger.
 */
function fitsRequestedResolution(
  entry: { readonly resolution?: { readonly width: number; readonly height: number } | undefined },
  target: { readonly width: number; readonly height: number },
): boolean {
  const width = entry.resolution?.width
  const height = entry.resolution?.height
  // An entry whose size we do not know is not evidence that it is too big.
  // Refusing here would transcode every camera whose publisher omits the
  // resolution, which is a cost with no measurement behind it.
  if (width === undefined || height === undefined) return true
  return width <= target.width && height <= target.height
}

function plausibleMeasured(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return value >= MIN_PLAUSIBLE_MEASURED_KBPS ? value : null
}

/**
 * Map a profile slot onto the camera encoder feeding it, and read that
 * encoder's configured bitrate.
 *
 * The link is the slot's assigned cam-stream: its resolution (and frame rate,
 * when two encoders share a resolution) identifies which of `main`/`sub`/`ext`
 * produces it. Vendor-neutral on purpose — the cam-stream ids (`native:main`,
 * `native:slot-3`, …) are provider strings and matching on them would work for
 * exactly one provider. An ambiguous match returns `null`.
 */
function publishedRateFor(
  slot: ProfileSlot,
  source: CameraStream | undefined,
  streamParams: StreamParamsStatus | null,
): number | null {
  if (streamParams === null) return null
  const resolution = source?.resolution ?? slot.resolution
  if (resolution === undefined) return null

  const byResolution = ENCODER_PROFILE_KEYS.map((key) => encoderConfig(streamParams, key)).filter(
    (cfg) => cfg !== null && cfg.width === resolution.width && cfg.height === resolution.height,
  )
  if (byResolution.length === 1) return positiveOrNull(byResolution[0]?.bitrate)

  const fps = source?.fps
  if (fps === undefined) return null
  const byFps = byResolution.filter(
    (cfg) => cfg !== null && Math.floor(cfg.framerate) === Math.floor(fps),
  )
  return byFps.length === 1 ? positiveOrNull(byFps[0]?.bitrate) : null
}

type EncoderConfig = NonNullable<StreamParamsStatus['main']>

function encoderConfig(status: StreamParamsStatus, key: EncoderProfileKey): EncoderConfig | null {
  return status[key] ?? null
}

function positiveOrNull(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null
  return value
}

const CAM_PROFILES: readonly CamProfile[] = ['high', 'mid', 'low']

/**
 * `PickedStream.profileId` is the brokerId suffix, which for a profile-keyed
 * entry IS the profile name. Anything else addresses a raw cam-stream and must
 * not be coerced into a profile.
 */
function toCamProfile(profileId: string): CamProfile | null {
  return CAM_PROFILES.find((p) => p === profileId) ?? null
}
