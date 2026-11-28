/**
 * The sharing key for `streamBroker.acquireEgressTranscode`.
 *
 * **Two requesters asking for exactly the same argument set reach the same
 * process.** Exact match, never fuzzy: a quantised ladder that merged
 * NEARLY-identical requests would make the stream a consumer receives depend
 * on who else is watching and in what order they arrived — unpredictable in
 * precisely the way a debugging session cannot tolerate. Same arguments ⇒ same
 * process. Different arguments ⇒ different process, and that is fine; the
 * operator accepted the cost ("it's fine to have several processes").
 *
 * Derived from the STRUCTURED plan, not from a flag array. `pipelineKeyFor`
 * (`transcode-pipeline.ts`) folds `getStreamWithCodec`'s raw `outputArgs` into
 * its key, so that method's extensibility hatch and its sharing key are the
 * same field — a consumer needing one extra flag silently forks the child, and
 * two consumers that want the same thing but spell it differently never share.
 * Here every knob is a named field, and defaults are APPLIED before hashing so
 * an omitted field and its explicit default land on the same key.
 */
import type { EgressTranscodeRequest } from '../capabilities/stream-broker.cap.js'

/**
 * The fields that describe WHAT IS ENCODED. Everything outside this shape is
 * excluded on purpose:
 *
 * - `hostname` only rewrites the DIAL address of a restreamer that is the same
 *   object either way (`substituteRtspHost`), so folding it in would fork the
 *   child once per consuming node;
 * - `tag` is attribution for the broker panel.
 *
 * `publishLocally` is INSIDE the shape, and it is not a delivery detail like
 * `hostname`. A push child emits MPEG-TS and its demuxed packets go straight
 * into a published cam stream; a dial child emits an elementary Annex-B
 * bytestream into a restreamer a consumer dials. Same encode parameters,
 * completely different transports — so with it excluded, whoever acquired
 * FIRST decided the transport for every later sharer, and the loser received a
 * handle whose transport its consumer cannot use.
 */
/**
 * How the encoded bytes REACH the consumer. Three transports, three containers,
 * three delivery mechanisms — and a child can serve exactly one of them, which
 * is why this is in the key and `hostname` is not.
 *
 * - `dial` — elementary Annex-B into a restreamer the consumer dials.
 * - `push` — MPEG-TS demuxed straight into a locally published cam stream.
 * - `fragments` — a fragmented-MP4 byte stream split into an initialisation
 *   segment plus `moof`+`mdat` units, delivered IN-PROCESS on a subscribable
 *   plane. No url and no cam stream: the consumer holds an object, not an
 *   address. Not reachable from `EgressTranscodeRequest` today — see
 *   {@link egressTransportFromRequest}.
 */
export type EgressTransport = 'dial' | 'push' | 'fragments'

/**
 * Everything about DELIVERY that decides which child a request lands on.
 *
 * It is a second argument rather than fields on `EgressTranscodeRequest`
 * because the `fragments` transport has no cap surface yet: HKSV's delegate and
 * the clip source that will share its fragmenter are both in-process consumers,
 * and putting `fragmentMs` on the request schema now would mean a codegen run
 * and a `@dominevo/server/system` train for a field nothing off-node can call. When
 * that changes, {@link egressTransportFromRequest} is the ONE place that learns
 * to read it, and every sharing decision follows automatically.
 */
export interface EgressTransportPlan {
  readonly transport: EgressTransport
  /**
   * Negotiated fragment length, `fragments` only. In the key: two consumers
   * that negotiated different fragment lengths are asking for differently-cut
   * media out of differently-configured muxers, so they cannot share a child.
   */
  readonly fragmentMs?: number
}

/**
 * The transport a CAP request describes. `fragments` is deliberately
 * unreachable from here — the request schema has no way to ask for it, so the
 * cap path can never be handed a fragment child by accident.
 */
export function egressTransportFromRequest(request: EgressTranscodeRequest): EgressTransportPlan {
  // Defaulted like every other optional: an omitted `publishLocally` and an
  // explicit `false` describe the same child and must share it.
  return { transport: request.publishLocally === true ? 'push' : 'dial' }
}

interface CanonicalEgressPlan {
  readonly deviceId: number
  readonly source: string
  /** See {@link EgressTransport}. */
  readonly transport: EgressTransport
  /** The negotiated fragment length, or `-1` for a transport without one. */
  readonly fragmentMs: number
  readonly video: Readonly<Record<string, string | number>>
  readonly audio: Readonly<Record<string, string | number>>
  readonly rateControl: string
  readonly bitstreamFilter: string
  readonly pixelFormat: string
  readonly decodeHwAccel: string
}

/** Absent optional ⇒ this sentinel, so `undefined` and "not set" agree. */
const UNSET = '\u0000unset'

function canonicalVideo(
  video: EgressTranscodeRequest['encode']['video'],
): Readonly<Record<string, string | number>> {
  return {
    codec: video.codec,
    profile: video.profile ?? UNSET,
    level: video.level ?? UNSET,
    width: video.width ?? -1,
    height: video.height ?? -1,
    fps: video.fps ?? -1,
    bitrateKbps: video.bitrateKbps ?? -1,
    gopFrames: video.gopFrames ?? -1,
    bf: video.bf ?? -1,
    preset: video.preset ?? UNSET,
    tune: video.tune ?? UNSET,
    // Absent is not `false`: "whatever the encoder does" and "one slice, on
    // purpose" are two different asks even when today's encoder answers both
    // the same way.
    singleSlicePerFrame:
      video.singleSlicePerFrame === undefined ? UNSET : String(video.singleSlicePerFrame),
  }
}

function canonicalAudio(
  audio: EgressTranscodeRequest['encode']['audio'],
): Readonly<Record<string, string | number>> {
  if (audio === 'passthrough') return { codec: 'passthrough' }
  return {
    codec: audio.codec,
    bitrateKbps: audio.bitrateKbps ?? -1,
    sampleRateHz: audio.sampleRateHz ?? -1,
    channels: audio.channels ?? -1,
  }
}

/**
 * The normalised plan a key is computed from. Exported so a test — and a
 * future operator-facing "why are these two not sharing?" surface — can diff
 * two requests without reversing a hash.
 */
export function canonicalEgressPlan(
  request: EgressTranscodeRequest,
  delivery: EgressTransportPlan = egressTransportFromRequest(request),
): CanonicalEgressPlan {
  return {
    deviceId: request.deviceId,
    source:
      request.source.kind === 'profile'
        ? `profile:${request.source.profile}`
        : `cam-stream:${request.source.camStreamId}`,
    transport: delivery.transport,
    fragmentMs: delivery.fragmentMs ?? -1,
    video: canonicalVideo(request.encode.video),
    audio: canonicalAudio(request.encode.audio),
    // Defaults applied HERE, before hashing — an omitted `rateControl` and an
    // explicit `'relaxed'` describe the same child and must share it.
    rateControl: request.rateControl ?? 'relaxed',
    bitstreamFilter: request.bitstreamFilter ?? UNSET,
    pixelFormat: request.pixelFormat ?? UNSET,
    // An absent `decodeHwAccel` means "resolve from the decoder addon", which
    // is deterministic per node — so it shares with another absent request,
    // and is distinct from any explicit pin.
    decodeHwAccel: request.decodeHwAccel ?? UNSET,
  }
}
