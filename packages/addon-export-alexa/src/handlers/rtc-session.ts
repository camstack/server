/**
 * `Alexa.RTCSessionController` handler.
 *
 * Alexa's flow is "client (Echo / Alexa Cloud) sends the SDP offer →
 * skill returns the answer", the dual of our default `createSession`
 * flow (server offers first). The `webrtc-session` device cap exposes
 * `handleOffer({ deviceId, sdpOffer, sessionId? })` for exactly this
 * direction; this dispatcher just translates Alexa's directive
 * envelope to/from the cap call.
 *
 * Echo / Alexa Cloud will send `InitiateSessionWithOffer` when an
 * RTSP fallback isn't preferred (Show 10/15, voice "show me"
 * commands). On disconnect, Alexa sends `SessionDisconnected` and we
 * tear the session down via `closeSession` so the broker stops
 * forwarding frames.
 */

import type { HeldEgressHandle } from '../egress/egress-handle-reaper.js'
import { resolveAlexaSourceProfile } from '../egress/alexa-source-profile.js'
import type { AddonApi, AddonContext, IScopedLogger, WebrtcStreamTarget } from '@camstack/types'
import { z } from 'zod'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { acquireAlexaEgress, releaseAlexaEgress } from '../egress/alexa-rtc-egress.js'
import type { ExposedDeviceEntry } from '../types.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import {
  type DirectiveHeader,
  EndpointRefSchema,
  InitiateSessionWithOfferPayloadSchema,
  SessionDisconnectedPayloadSchema,
} from './types.js'

const InitiateSessionWithOfferDirectiveSchema = z.object({
  endpoint: EndpointRefSchema,
  payload: InitiateSessionWithOfferPayloadSchema,
})

const SessionDisconnectedDirectiveSchema = z.object({
  endpoint: EndpointRefSchema,
  payload: SessionDisconnectedPayloadSchema,
})

export interface RtcSessionContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /**
   * Returns the operator's exposed-device list — used to honor
   * `ExportDeviceSettings.streamPreference` when picking the broker
   * stream id for `webrtcSession.handleOffer`.
   */
  readonly listExposed: () => readonly ExposedDeviceEntry[]
}

/**
 * Live egress handles, keyed by `<deviceId>/<sessionId>`.
 *
 * The primitive's refcount has no lease TTL: a holder that vanishes without
 * releasing leaks a child until the broker restarts (D67). This handler is a
 * holder, so it keeps the one piece of state that lets it not be that holder —
 * the `pipelineKey` its `SessionDisconnected` has to release.
 *
 * A module-level map is right here because the directive handlers are free
 * functions called per directive; the entry is written on a successful acquire
 * and deleted on the release path, both of which are the same tick as the
 * directive that owns it.
 */
const EGRESS_HANDLES = new Map<string, string>()

function egressHandleKey(deviceId: number, sessionId: string): string {
  return `${deviceId}/${sessionId}`
}

/** Every handle currently held, for the sweep. */
export function heldEgressHandles(): readonly HeldEgressHandle[] {
  const held: HeldEgressHandle[] = []
  for (const [key, pipelineKey] of EGRESS_HANDLES) {
    const slash = key.indexOf('/')
    if (slash <= 0) continue
    const deviceId = Number.parseInt(key.slice(0, slash), 10)
    if (!Number.isFinite(deviceId)) continue
    held.push({ deviceId, sessionId: key.slice(slash + 1), pipelineKey })
  }
  return held
}

/** Drop a handle the sweep reclaimed, so it is not reaped twice. */
export function forgetEgressHandle(handle: HeldEgressHandle): void {
  EGRESS_HANDLES.delete(egressHandleKey(handle.deviceId, handle.sessionId))
}

const WEBRTC_PROFILE_NAMES = ['high', 'mid', 'low'] as const
type WebrtcProfileName = (typeof WEBRTC_PROFILE_NAMES)[number]

function resolveWebrtcTarget(pref: 'auto' | string): WebrtcStreamTarget | undefined {
  if (pref === 'auto') return undefined
  if ((WEBRTC_PROFILE_NAMES as readonly string[]).includes(pref)) {
    return { kind: 'profile', profile: pref as WebrtcProfileName }
  }
  // Treat any non-profile value as a cam-stream id (e.g. `native:main`).
  return { kind: 'cam-stream', camStreamId: pref }
}

/** What the router decided about this caller before the handler runs. */
export interface RtcSessionGrant {
  /**
   * The linked user may CONTROL this camera (S1). Talk-back drives the
   * camera's speaker, so it is offered only then — and only on a camera with
   * the `intercom` cap (D771).
   */
  readonly mayTalk: boolean
}

/** The cap whose push-talk triple receives the Echo's microphone. */
const CAP_INTERCOM = 'intercom'

async function deviceHasIntercom(api: AddonApi, deviceId: number): Promise<boolean> {
  const bindings = await api.deviceManager.getBindings.query({ deviceId })
  return bindings.entries.some((e) => e.capName === CAP_INTERCOM)
}

export async function handleInitiateSessionWithOffer(
  header: DirectiveHeader,
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: RtcSessionContext,
  // Identity is verified upstream in the directive router; the session handler
  // no longer reads it (attribution carries only kind + sessionId).
  _callerIdentity: VerifiedDirectiveIdentity,
  grant: RtcSessionGrant = { mayTalk: false },
): Promise<unknown> {
  const parsed = InitiateSessionWithOfferDirectiveSchema.safeParse({
    endpoint: endpointRaw,
    payload: payloadRaw ?? {},
  })
  if (!parsed.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `payload validation failed: ${parsed.error.message}`,
    )
  }
  const endpoint = parsed.data.endpoint
  const payload = parsed.data.payload

  // Token is already verified by the centralized entry check in
  // handleDirective (http-server.ts). No per-handler re-verification needed.

  const parsedId = parseCameraEndpointId(endpoint.endpointId)
  if (parsedId.kind !== 'camera') {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `endpointId ${endpoint.endpointId} is not a camera`,
    )
  }
  const deviceId = parsedId.deviceId
  const sessionId = payload.sessionId
  // Bind a child logger so every entry in this session carries
  // deviceId + sessionId in the QUERYABLE `tags` column (greppable),
  // not just inline free-form `meta`.
  const log = deps.logger.withTags({ deviceId, sessionId })
  const sdpOffer = payload.offer.value
  if (sdpOffer.length === 0) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'offer.value is empty')
  }

  const api: AddonApi = deps.ctx.api
  const exposedEntry = deps.listExposed().find((e) => e.deviceId === deviceId)
  const sourceProfile = await resolveAlexaSourceProfile({
    api,
    deviceId,
    exposedEntry,
    logger: log,
  })
  // Battery pre-wake USED to live here, behind `const hasBatteryCap = false`.
  // It was a leftover of the worst kind: forty lines describing the right
  // design — pre-wake a sleeping camera so the Echo does not render black —
  // guarded by a constant that made sure it never ran. Reading this file, the
  // wake looked handled. It was not handled anywhere: this was the only
  // `battery.wakeForStream` caller in the repo, so no consumer, including the
  // viewer's own play button, could wake a sleeping camera (D173).
  //
  // The wake now belongs to the broker, one layer down and shared by every
  // consumer: `WebrtcSessionProvider.ensureBrokerAvailable` →
  // `StreamBrokerManager.wakeBatteryDeviceOnPlay`, which runs on the
  // `handleOffer` this handler is about to issue. That also removes the
  // per-directive `battery.getStatus` round-trip whose Moleculer fallback used
  // to stall the SDP-offer directive by ~30 s under Echo burst: the broker
  // asks only when it has no broker to answer with, which for a mains camera
  // is never.

  // FAST PATH: when the source profile is H.265 but the
  // device exposes a sibling H.264 stream (Reolink battery cams ship
  // `native:main` HEVC + `native:sub` H.264 by design), point Alexa at the
  // H.264 stream directly. Echo only decodes H.264 anyway, so the derived
  // broker would otherwise spin up an `ffmpeg -c:v hevc → libx264` pipeline
  // — that pipeline waits for the first source keyframe before emitting,
  // which on a sleeping battery cam means 3-6s of black screen post-wake.
  // By dialing the H.264 sub-stream the broker forwards source RTP straight
  // through the repacketizer with zero transcode latency, Echo sees the
  // first frame the instant the cam wakes up. Resolution drops from 4K to
  // ~896×512 but Echo Show downscales 1080p anyway, so the visual delta is
  // imperceptible while the responsiveness gain is dramatic.
  let derivedTarget: WebrtcStreamTarget | undefined
  /**
   * The primitive's release handle, when this session acquired one. Recorded so
   * `SessionDisconnected` can release it: a refcount whose holder disappears is
   * the one gap D67 leaves open, and the least this handler can do is not BE
   * that holder.
   */
  let egressPipelineKey: string | null = null
  const picked = await api.cameraStreams.pickStream
    .query({
      deviceId,
      requirements: {
        acceptCodecs: ['h264'],
        minHeight: 480,
        excludeDerived: true,
        // Bypass only when the natural path WOULD have transcoded.
        requireSiblingCodec: ['h265', 'hevc'],
      },
    })
    .catch((err: unknown) => {
      log.warn('alexa rtc-session: cameraStreams.pickStream threw — falling back to transcode', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    })
  if (picked) {
    log.info('alexa rtc-session: bypassing transcode via cameraStreams.pickStream', {
      meta: {
        sourceProfile,
        selectedCamStreamId: picked.camStreamId,
        reason: picked.reason,
      },
    })
    derivedTarget = { kind: 'cam-stream', camStreamId: picked.camStreamId }
  } else {
    // Route the session through THE ffmpeg primitive
    // (`streamBroker.acquireEgressTranscode`, D67) so Alexa's encode — H.264
    // Baseline 3.1 — comes from the one argv builder, decodes in hardware from
    // the decoder addon's per-node probe, and is refcounted rather than left
    // behind as a permanent `derived:alexa-<id>-<hash>` camStream that a
    // browser viewer could attach to and drag down.
    //
    // Falls back to the legacy streamPreference target if the acquire fails
    // (e.g. the source is not dialed yet while the provider warms up at boot) —
    // Alexa receiving SOME stream beats failing completely.
    try {
      const acquired = await acquireAlexaEgress({
        api,
        deviceId,
        sourceProfile,
        sessionId,
        logger: log,
      })
      egressPipelineKey = acquired.pipelineKey
      EGRESS_HANDLES.set(egressHandleKey(deviceId, sessionId), acquired.pipelineKey)
      derivedTarget = { kind: 'cam-stream', camStreamId: acquired.camStreamId }
    } catch (err) {
      log.warn(
        'alexa rtc-session: egress acquire failed, falling back to streamPreference target',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      const pref = exposedEntry?.settings?.streamPreference ?? 'auto'
      derivedTarget = resolveWebrtcTarget(pref)
    }
  }

  // Talk-back (D771): the Echo's microphone reaches the camera speaker only on
  // a camera with `intercom` and for a user who may control it. A failed
  // bindings read means one-way audio, not a failed session.
  const talkback =
    grant.mayTalk &&
    (await deviceHasIntercom(api, deviceId).catch((err: unknown) => {
      log.warn('alexa rtc-session: intercom lookup failed — this session is one-way audio', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }))
  log.info('alexa rtc-session: talk-back decision', {
    meta: { talkback, mayTalk: grant.mayTalk },
  })

  try {
    const result = await api.webrtcSession.handleOffer.mutate({
      deviceId,
      sdpOffer,
      sessionId,
      target: derivedTarget,
      talkback,
      // Alexa's RTCSessionController peer is AWS-hosted with public host
      // candidates; force-relay-only suppresses the direct path Echo needs.
      relayOnly: false,
      // Alexa does NOT support trickle ICE — it never polls getIceCandidates
      // nor trickles back via addIceCandidate. Force a non-trickle answer so
      // the server's gathered candidates are embedded in the answer SDP;
      // otherwise Alexa's ICE agent stalls (no nominated pair → DTLS never
      // connects → Echo shows black → SessionDisconnected ~28s).
      nonTrickle: true,
      // Strip TURN from the per-session iceConfig — the answer carries only
      // host + srflx candidates, no relay. Skipping the TURN allocation also
      // shaves ~1s off the Lambda response time (CRITICAL: Alexa
      // Smart Home directives have ~5-8s end-to-end budget; Cloudflare
      // tunnel + warm-up already eat 3-4s, anything more is wasted budget).
      disableTurn: true,
      // Suppress IPv6 host candidates. Amazon documents `Alexa.RTCSessionController`
      // as IPv4-only ("For ICE candidates, you can use either UDP or TCP but
      // you must use IPv4"); Echo's media gateway ignores IPv6 candidates AND
      // counts them against its documented 6-second SDP processing budget.
      // Without this, every answer carried 5 IPv6 host candidates (4 native
      // GUA + 1 Tailscale fd7a::) per m-section that the gateway could not
      // use — wasted candidate budget and ICE-checking time.
      disableIpv6: true,
      // Subscriber attribution: `kind` drives the ALEXA badge and `sessionId`
      // drives the "sess <short>" chip in the broker panel. Per the
      // BrokerConsumerAttribution contract the `label` must NOT repeat the
      // kind / cam / sessionId (those have dedicated fields) — so we set no
      // `label` and no `userId`: a session identifier alone is enough to tell
      // two concurrent Alexa subscribers apart.
      consumerAttribution: {
        kind: 'alexa',
        sessionId,
      },
    })
    log.info('alexa rtc-session: AnswerGenerated', {
      meta: {
        returnedSessionId: result.sessionId,
        sdpAnswerLen: result.sdpAnswer.length,
      },
    })
    return {
      event: {
        header: {
          namespace: 'Alexa.RTCSessionController',
          name: 'AnswerGeneratedForSession',
          messageId: header.messageId,
          correlationToken: header.correlationToken,
          payloadVersion: '3',
        },
        endpoint: { endpointId: endpoint.endpointId },
        payload: {
          answer: {
            format: payload.offer.format ?? 'SDP',
            value: result.sdpAnswer,
          },
        },
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Echo's offer SDP varies — different codec sets, m-section orderings,
    // and direction values. werift sometimes throws on a specific shape
    // ("Failed to set remote video description send parameters for
    // m-section with mid='N'") and without the actual SDP we can't tell
    // which m-section / codec / direction triggers it. Dump the offer
    // shape so the next failure leaves a reproducer in the log.
    const mSectionSummary = (() => {
      const lines = sdpOffer.split(/\r?\n/)
      const sections: Array<{
        mid: string | null
        kind: string
        direction: string | null
        codecs: string[]
      }> = []
      let current: {
        mid: string | null
        kind: string
        direction: string | null
        codecs: string[]
      } | null = null
      for (const raw of lines) {
        const line = raw.trim()
        if (line.startsWith('m=')) {
          if (current) sections.push(current)
          const kind = line.split(' ')[0]?.slice(2) ?? 'unknown'
          current = { mid: null, kind, direction: null, codecs: [] }
        } else if (current) {
          if (line.startsWith('a=mid:')) current.mid = line.slice('a=mid:'.length)
          else if (/^a=(sendonly|recvonly|sendrecv|inactive)$/.test(line))
            current.direction = line.slice(2)
          else if (line.startsWith('a=rtpmap:')) current.codecs.push(line.slice('a=rtpmap:'.length))
        }
      }
      if (current) sections.push(current)
      return sections
    })()
    log.warn('alexa rtc-session: handleOffer failed', {
      meta: {
        error: message,
        offerLen: sdpOffer.length,
        mSections: mSectionSummary,
        offerSdp: sdpOffer,
      },
    })
    // No session was created, so no `SessionDisconnected` is coming — this is
    // the ONLY place that can release the handle acquired above. Without it a
    // failed offer leaves an ffmpeg running until the broker restarts.
    if (egressPipelineKey !== null) {
      EGRESS_HANDLES.delete(egressHandleKey(deviceId, sessionId))
      await releaseAlexaEgress({
        api,
        deviceId,
        pipelineKey: egressPipelineKey,
        logger: log,
      })
    }
    return errorEnvelope(header, 'INTERNAL_ERROR', `webrtc-session.handleOffer failed: ${message}`)
  }
}

export async function handleSessionDisconnected(
  header: DirectiveHeader,
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: RtcSessionContext,
  _callerIdentity: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const parsed = SessionDisconnectedDirectiveSchema.safeParse({
    endpoint: endpointRaw,
    payload: payloadRaw ?? {},
  })
  if (!parsed.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `payload validation failed: ${parsed.error.message}`,
    )
  }
  const endpoint = parsed.data.endpoint

  // Token is already verified by the centralized entry check in
  // handleDirective (http-server.ts). No per-handler re-verification needed.

  const parsedId = parseCameraEndpointId(endpoint.endpointId)
  if (parsedId.kind === 'camera') {
    // Release the primitive's handle FIRST — before `closeSession`, which is
    // allowed to throw on a session the broker already dropped. Ordering it
    // after would make a benign teardown race leak an ffmpeg.
    const handleKey = egressHandleKey(parsedId.deviceId, parsed.data.payload.sessionId)
    const pipelineKey = EGRESS_HANDLES.get(handleKey)
    if (pipelineKey !== undefined) {
      EGRESS_HANDLES.delete(handleKey)
      await releaseAlexaEgress({
        api: deps.ctx.api,
        deviceId: parsedId.deviceId,
        pipelineKey,
        logger: deps.logger,
      })
    }
    try {
      await deps.ctx.api.webrtcSession.closeSession.mutate({
        deviceId: parsedId.deviceId,
        sessionId: parsed.data.payload.sessionId,
      })
    } catch (err) {
      // closeSession on a non-existent session is a no-op upstream;
      // we still log unexpected failures.
      deps.logger.warn('alexa rtc-session: closeSession threw on disconnect (continuing to ack)', {
        tags: {
          deviceId: parsedId.deviceId,
          sessionId: parsed.data.payload.sessionId,
        },
        meta: {
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  const disconnectedDeviceId = parsedId.kind === 'camera' ? parsedId.deviceId : undefined
  deps.logger.info('alexa rtc-session: SessionDisconnected', {
    tags: {
      sessionId: parsed.data.payload.sessionId,
      ...(disconnectedDeviceId !== undefined ? { deviceId: disconnectedDeviceId } : {}),
    },
    meta: {
      endpointId: endpoint.endpointId,
    },
  })
  return sessionEvent(
    'SessionDisconnected',
    header,
    endpoint.endpointId,
    parsed.data.payload.sessionId,
  )
}

/**
 * The response to `SessionConnected` / `SessionDisconnected` is the event of
 * the same name with the session id (alexa-rtcsessioncontroller) — not a
 * generic `Alexa.Response`.
 */
function sessionEvent(
  name: 'SessionConnected' | 'SessionDisconnected',
  header: DirectiveHeader,
  endpointId: string,
  sessionId: string,
): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa.RTCSessionController',
        name,
        messageId: header.messageId,
        correlationToken: header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: { endpointId },
      payload: { sessionId },
    },
  }
}

/**
 * `SessionConnected` — Alexa reports the media path is up. Nothing to do
 * hub-side (the session already exists from the offer); acknowledge it. Amazon
 * notes it is not always sent, so nothing may depend on it.
 */
export function handleSessionConnected(
  header: DirectiveHeader,
  endpointRaw: unknown,
  payloadRaw: unknown,
  deps: RtcSessionContext,
): unknown {
  const parsed = SessionDisconnectedDirectiveSchema.safeParse({
    endpoint: endpointRaw,
    payload: payloadRaw ?? {},
  })
  if (!parsed.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      `payload validation failed: ${parsed.error.message}`,
    )
  }
  deps.logger.info('alexa rtc-session: SessionConnected', {
    tags: { sessionId: parsed.data.payload.sessionId },
    meta: { endpointId: parsed.data.endpoint.endpointId },
  })
  return sessionEvent(
    'SessionConnected',
    header,
    parsed.data.endpoint.endpointId,
    parsed.data.payload.sessionId,
  )
}
