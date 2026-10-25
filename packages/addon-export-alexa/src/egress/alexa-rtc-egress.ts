/**
 * Alexa's egress — acquired through THE ffmpeg primitive.
 *
 * ## What this used to be, and why it changed
 *
 * Alexa used to publish a derived stream of its own:
 * `publishCameraStream({ kind: 'derived', encodeProfile })`, under a camStreamId
 * with the encode profile's hash baked into it (`derived:alexa-<id>-<hash>`).
 * Three things were wrong with that, and they are the three D67 named:
 *
 *  1. **It was a publicly selectable camStream.** A browser viewer or the
 *     recorder could attach to it, and because a derived stream is a mutable
 *     shared object, one Alexa consumer's downgrade dragged every co-tenant
 *     with it — the co-tenant hazard the primitive's IMMUTABLE handle exists to
 *     end.
 *  2. **It had no lifecycle.** Nothing ever retracted it. One per
 *     (device, profile-hash), for the life of the hub.
 *  3. **It encoded audio nobody received.** See {@link ALEXA_EGRESS_PROFILE}
 *     below.
 *
 * It now calls `streamBroker.acquireEgressTranscode` — refcounted, deduplicated
 * on EXACT match, released on `SessionDisconnected`.
 *
 * **The derived mechanism itself is untouched.** `derived-feeder-controller.ts`,
 * the `derived:<name>` concept and its lifecycle wiring are all still there and
 * still used; only Alexa's use of it for its own egress is gone.
 *
 * ## How the stream reaches the session, and why not by url
 *
 * `webrtcSession.handleOffer` takes a `WebrtcStreamTarget`, and every variant of
 * it resolves to a BROKER — there is no "dial this url" target. The first
 * version of this file therefore published the acquired url as a
 * `kind: 'pull-rtsp'` stream. It worked in the sense that everything connected —
 * broker registered, RTP arriving, key frame arriving — and every Echo showed
 * BLACK, because dialling a url makes the stream an RTP SOURCE and routes the
 * session down the RTP-passthrough + repacketizer branch instead of the
 * push/deframe branch the derived mechanism had live hours on.
 *
 * So the acquire now asks for `publishLocally`, and the broker publishes a push
 * cam stream fed straight from the transcode's demuxed packets — the derived
 * mechanism's exact transport, with the primitive's ownership on top: one argv
 * builder, refcounted dedup on an exact sharing key, the decoder addon as the
 * hwaccel authority, and `autoEligible: false` so a private egress can never
 * become a camera's published stream.
 *
 * The url stays in the response and stays the contract for a transcode pinned
 * to another node. This only stops paying for it when the transcode runs on our
 * own node — which today is always, since nothing passes a pin yet.
 */

import type { EgressTranscode, IScopedLogger, StreamBrokerClient } from '@camstack/types'
import { errMsg } from '@camstack/types'

/**
 * The broker surface this module uses.
 *
 * Derived from the GENERATED cap client, never hand-written. An earlier version
 * of this file declared its own shape including `getProfileSlotsForDevice`; the
 * cap later replaced that with `listAllProfileSlots`, the build stayed green
 * because nothing connected the two, and every Alexa session went black — the
 * derived stream could not be spawned, the session fell back to a source Alexa
 * cannot render, and dropped after ~10 s. Typing against the generated client
 * makes that a build error.
 */
export type AlexaStreamBrokerApi = Pick<
  StreamBrokerClient,
  | 'acquireEgressTranscode'
  | 'releaseEgressTranscode'
  | 'publishCameraStream'
  | 'retractCameraStream'
>

export interface AlexaEgressApi {
  readonly streamBroker: AlexaStreamBrokerApi
}

export interface AcquireAlexaEgressInput {
  readonly api: AlexaEgressApi
  readonly deviceId: number
  readonly sourceProfile: 'high' | 'mid' | 'low'
  /** Attribution for the broker panel. NEVER part of the sharing key. */
  readonly sessionId: string
  readonly logger?: IScopedLogger
}

export interface AlexaEgressHandle {
  /** Pass to `webrtcSession.handleOffer` as `{ kind: 'cam-stream', camStreamId }`. */
  readonly camStreamId: string
  /** Pass to {@link releaseAlexaEgress} when the Echo disconnects. */
  readonly pipelineKey: string
  readonly transcode: EgressTranscode
}

/**
 * Acquire Alexa's encoded stream and make it dialable by a WebRTC session.
 *
 * The request carries NO raw ffmpeg flags — the primitive's schema has no
 * escape hatch, on purpose: an opaque `outputArgs` array would be both the
 * extensibility mechanism AND part of the sharing key, so one extra flag would
 * silently fork the shared child and two consumers meaning the same thing but
 * spelling it differently would never share.
 *
 * Placement note: the call is UNPINNED, so `classifyCapRoute` serves it
 * hub-in-process. Moving Alexa's transcode to another node is a `nodePin` here
 * plus a `hostname` this addon can dial — nothing else in this function
 * assumes hub-locality.
 */
export async function acquireAlexaEgress(
  input: AcquireAlexaEgressInput,
): Promise<AlexaEgressHandle> {
  const { api, deviceId, sourceProfile, sessionId } = input
  const transcode = await api.streamBroker.acquireEgressTranscode.mutate({
    deviceId,
    source: { kind: 'profile', profile: sourceProfile },
    encode: ALEXA_EGRESS_PROFILE,
    // TIGHT, and the line above used to say the opposite: "Echo tolerates a
    // keyframe spike borrowing from the next second". Measured on 2026-09-13,
    // it does not.
    //
    // `relaxed` is a 2-second VBV, which lets one frame spend up to 625 kB at
    // this bitrate. What came out, in steady state and not just at startup:
    // keyframes of 133, 153, 143 and 151 kB — about 125 RTP packets each, once
    // per second, and HALF the entire second's 312 kB budget in a single
    // frame. With `singleSlicePerFrame` those 125 packets are ONE slice: lose
    // any of them and the whole keyframe is undecodable, and the P-frames that
    // follow have no reference, so the picture stalls until the next IDR a
    // second later.
    //
    // That would be recoverable on a consumer that asks — a NACK retransmits,
    // a PLI re-sends the IDR. The Echo asks for nothing: measured across 1483
    // packets it sent no receiver report and no REMB, while a browser session
    // on the same hub reported both. So every keyframe is all-or-nothing, and
    // at 1 % packet loss a 125-packet frame arrives intact 28 % of the time.
    // The operator's word for the result was "va a singhiozzo".
    //
    // A 1-second VBV forces the keyframe to fit inside the second it belongs
    // to, which is the one lever that attacks the packet COUNT directly.
    rateControl: 'tight',
    // Attach to a LOCAL push stream instead of dialling the returned url.
    //
    // Dialling it costs an RTSP round trip that changes the transport
    // underneath us: a dialled stream is an RTP source, so the session takes
    // the RTP-passthrough + repacketizer branch. Measured on this hub — broker
    // registered, RTP arriving, key frame arriving, black screen — while the
    // push/deframe branch, which is what the derived mechanism used, renders.
    //
    // The url stays in the response and stays the contract for a transcode
    // pinned to another node; this only stops paying for it when the transcode
    // is on our own node, which today is always.
    publishLocally: true,
    tag: `alexa/${sessionId}`,
  })

  // The broker names and publishes the stream itself — a caller-supplied id
  // would be circular, since the sharing key is computed from the request that
  // would have to carry it. A null here means the broker declined to publish
  // and the url is the only way in.
  const camStreamId = transcode.camStreamId
  if (camStreamId === null) {
    await api.streamBroker.releaseEgressTranscode
      .mutate({ pipelineKey: transcode.pipelineKey })
      .catch(() => undefined)
    input.logger?.warn('alexa egress: broker did not publish locally — released the handle', {
      tags: { deviceId, sessionId },
      meta: { pipelineKey: transcode.pipelineKey },
    })
    throw new Error('alexa egress: broker declined to publish the transcode locally')
  }

  input.logger?.info('alexa egress: acquired through the ffmpeg primitive', {
    tags: { deviceId, sessionId },
    meta: {
      pipelineKey: transcode.pipelineKey,
      camStreamId,
      // WHICH slot was asked for. Every Alexa quality question starts here and
      // this line did not carry it: the published `camStreamId` is a hash of
      // the request, so the source it was transcoded FROM had to be
      // re-derived by hand from the broker's own logs, every time.
      sourceProfile: input.sourceProfile,
      encoder: transcode.encoder,
      // A software outcome on a hub with working vaapi is a flow bug, not a
      // capability limit — so the backend that actually ran is reported here
      // rather than assumed from the request.
      decodeHwAccel: transcode.decodeHwAccel ?? 'software',
    },
  })
  return { camStreamId, pipelineKey: transcode.pipelineKey, transcode }
}

export interface ReleaseAlexaEgressInput {
  readonly api: AlexaEgressApi
  readonly deviceId: number
  readonly pipelineKey: string
  readonly logger?: IScopedLogger
}

/**
 * Drop this session's reference, and retract the published stream once the LAST
 * holder has gone.
 *
 * Never throws. Alexa expects an `Alexa.Response` to `SessionDisconnected`, and
 * a stale handle after a broker respawn is a normal event — turning either into
 * an error envelope would make a clean teardown look like a fault.
 */
export async function releaseAlexaEgress(input: ReleaseAlexaEgressInput): Promise<void> {
  const { api, deviceId, pipelineKey } = input
  try {
    // Retraction is the BROKER's now: the push sink it created retracts the
    // stream when the last holder releases and the child stops. Retracting from
    // here as well would race the broker's own teardown and could pull a stream
    // another holder is still watching.
    await api.streamBroker.releaseEgressTranscode.mutate({ pipelineKey })
  } catch (err) {
    input.logger?.warn(
      'alexa egress: release failed — the handle may leak until the broker restarts',
      {
        tags: { deviceId },
        meta: { pipelineKey, error: errMsg(err) },
      },
    )
  }
}

/**
 * Alexa's encode profile.
 *
 * Re-exported from `@camstack/types` rather than declared here. The previous
 * copy was "intentionally duplicated so `addon-export-alexa` has no dependency
 * on any other addon's preset registry" — which was the right constraint and
 * the wrong conclusion: addons may never import each other, but they all import
 * `@camstack/types`, which is why every live-egress constant lives there now.
 * Five sets in four packages used to disagree, three of them about Opus channel
 * count alone.
 *
 * Two things about it differ from the profile Alexa's derived stream carried,
 * and both are fixes:
 *
 *  - **`level: '3.1'`.** Alexa's SDP advertises `profile-level-id=42e01f`,
 *    which IS Baseline 3.1, and the old encoder was unconstrained. A stream
 *    that does not match its own advertisement is the defect class that kept
 *    HomeKit black for a year.
 *  - **`audio: 'passthrough'`.** The old profile encoded Opus in-band. Opus in
 *    MPEG-TS is `stream_type 0x06`, and the broker's demuxer
 *    (`stream-broker/rtsp/mpegts-demux.ts`) maps only `0x0f` (aac), `0x03`/
 *    `0x04` (mp2) and `0x81` (ac3) — so **every Opus frame this path ever
 *    encoded was discarded at the demuxer**. It was pure CPU behind a comment
 *    describing it working. Alexa's audio rides the WebRTC session's own plane,
 *    out-of-band, exactly as the browser's does; removing the encode changes
 *    what the Echo hears not at all, and stops paying libopus per session.
 */
export { ALEXA_EGRESS_PROFILE } from '@camstack/types'

import { ALEXA_EGRESS_PROFILE } from '@camstack/types'
