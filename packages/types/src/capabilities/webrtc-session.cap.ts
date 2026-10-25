import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { CamProfileSchema } from './schemas/streaming-shared.js'
import { BrokerConsumerAttributionSchema } from './stream-broker.cap.js'

/**
 * Optional client-side hints sent at session creation to help the provider
 * pick the best native source. All fields optional — a viewer that knows
 * nothing still gets a sane default. (Relocated from the retired `webrtc`
 * collection cap; this `webrtc-session` cap is the live signaling surface.)
 */
export const webrtcClientHintsSchema = z
  .object({
    viewportWidth: z.number().int().positive().optional(),
    viewportHeight: z.number().int().positive().optional(),
    devicePixelRatio: z.number().positive().optional(),
    /** navigator.connection.downlink — Mbps the browser estimates. */
    downlinkMbps: z.number().nonnegative().optional(),
    /** Hard tier override; takes precedence over scoring when registered. */
    prefersTier: z.string().optional(),
  })
  .partial()

export type WebrtcClientHints = z.infer<typeof webrtcClientHintsSchema>

/**
 * Discriminated target for a WebRTC session. The client sends this
 * structured object instead of building / parsing brokerId strings;
 * the server resolves it to a brokerId via the assignments map.
 *
 * - `adaptive`: server picks the best broker for the device based on
 *   client hints (viewport, downlink).
 * - `profile`: pin the session to a profile slot (`high`/`mid`/`low`).
 *   The actual source can change as the operator reassigns the slot.
 * - `cam-stream`: pin the session to a specific source by camStreamId
 *   (e.g. `native:main`, `rtsp:sub`). Useful when the operator wants
 *   a stable view of a specific source regardless of profile bindings,
 *   or to consume a manually-activated stream that isn't profile-bound.
 */
export const WebrtcStreamTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('adaptive') }),
  z.object({ kind: z.literal('profile'), profile: CamProfileSchema }),
  z.object({ kind: z.literal('cam-stream'), camStreamId: z.string().min(1) }),
])
export type WebrtcStreamTarget = z.infer<typeof WebrtcStreamTargetSchema>

/** A stream choice the UI can offer for a device. */
export const WebrtcStreamChoiceSchema = z.object({
  /** Stable id for React keys / dropdowns (e.g. `'adaptive'`, `'profile:high'`, `'stream:native:main'`). */
  id: z.string(),
  /** Display label. */
  label: z.string(),
  /** Discriminated target — pass straight to `createSession`. */
  target: WebrtcStreamTargetSchema,
  /** Codec of the underlying broker stream (null for adaptive). */
  codec: z.string().nullable(),
  /** Resolution of the underlying stream (null for adaptive). */
  resolution: z.object({ width: z.number(), height: z.number() }).nullable(),
  /** Broker status (null for adaptive). */
  status: z.enum(['idle', 'connecting', 'streaming', 'error', 'stopped']).nullable(),
  /** Input FPS from the camera (null for adaptive). */
  inputFps: z.number().nullable(),
  /** Bitrate in kbps (null for adaptive). */
  bitrateKbps: z.number().nullable(),
})
export type WebrtcStreamChoice = z.infer<typeof WebrtcStreamChoiceSchema>

/**
 * The last move the adaptive ladder made on this session, and the numbers it
 * rested on. Mirrors `LadderDecision` in the stream-broker's
 * `adaptive-controller.ts` — the log line's evidence, made readable.
 *
 * Nullability is load-bearing: `lossRatio: null` means the loss tracker had
 * no window to report, which is NOT a link with zero loss.
 */
export const WebrtcLadderDecisionSchema = z.object({
  /** `loss` — RTCP / client-reported packet loss; `stall` — the picture
   *  stopped moving; `healthy` — a promotion. */
  cause: z.enum(['loss', 'stall', 'healthy']),
  /** The rung the ladder moved TO. Null for a move that changed no rung
   *  (an MTU reduction, a forced transcode-down at the bottom). */
  tier: CamProfileSchema.nullable(),
  /** Whether that move forced the egress transcode-down rung. */
  forcedTranscodeDown: z.boolean(),
  /** Loss ratio over the tracker's window at the moment of the decision. */
  lossRatio: z.number().nullable(),
  /** The client's reported downlink at that moment, in kbps. */
  clientKbps: z.number().nullable(),
  /** How long the stall detector had been seeing nothing arrive. */
  stalledForMs: z.number().nullable(),
  /** Whether the broker WAS sending while that was measured — the half that
   *  separates "the camera stopped" from "the link stopped". */
  serverSending: z.boolean().nullable(),
  /** Epoch ms. The overlay prints its age; a decision from 40 minutes ago
   *  must not read like one from this second. */
  at: z.number(),
  /** The broker's own cause when it is finer than `cause` can carry, e.g.
   *  `trial-revert` (reported as `stall`/`loss` for older consumers). Optional:
   *  an older server strips it instead of rejecting the answer. */
  causeDetail: z.string().optional(),
})
export type WebrtcLadderDecision = z.infer<typeof WebrtcLadderDecisionSchema>

/**
 * Why the adaptive ladder is NOT climbing on this session right now (D635).
 * Before this, a session held on its rung for a reason and a session with no
 * ladder at all both read "never moved". Every number is one the controller
 * used; `null` is unknown, never zero (D393).
 */
/**
 * The hold codes this build knows. The WIRE carries `code` as a plain string:
 * this output is validated by the router, so a closed enum would make a server
 * built before the NEXT code reject the whole debug answer (review m1). A
 * consumer maps an unknown code to a generic "held" and shows `summary`.
 */
export const WEBRTC_CLIMB_HOLD_CODES = [
  'stall-building',
  'delivery',
  'no-evidence',
  'warming',
  'cooldown',
  'capacity',
  'try-unclean',
  'try-backoff',
  'trial',
  'suspended',
] as const
export type WebrtcClimbHoldCode = (typeof WEBRTC_CLIMB_HOLD_CODES)[number]

/** Clean-path conditions a try-climb can be refused on (`tryBlockedBy`). */
export const WEBRTC_TRY_BLOCKERS = ['delivery', 'loss', 'rtt', 'shared-telemetry'] as const
export type WebrtcTryBlocker = (typeof WEBRTC_TRY_BLOCKERS)[number]

export const WebrtcClimbHoldSchema = z.object({
  /** `stall-building` — the client receives ≪ what is sent; `delivery` — the
   *  current rung is not landing whole; `no-evidence` — no receiver feedback;
   *  `warming` — healthy, accumulating the streak; `cooldown` — too soon after
   *  a change; `capacity` — a MEASURED probe below the next rung's bar;
   *  `try-unclean` — no capacity evidence, and the path is not clean enough to
   *  try; `try-backoff` — a try reverted, waiting out its backoff; `trial` —
   *  this rung IS a try, reverting if it does not land; `suspended` —
   *  recorded playback on the track. */
  code: z.string(),
  /** The rung a climb would go to. */
  nextTier: CamProfileSchema,
  /** Bytes received ÷ bytes sent over the delivery window (≥ one GOP). */
  deliveryRatio: z.number().nullable(),
  deliveryWindowMs: z.number().nullable(),
  /** The ratio a climb requires. */
  climbDeliveryRatio: z.number(),
  /** The receiver's bandwidth estimate (REMB), kbps. Capped by what is sent. */
  capacityKbps: z.number().nullable(),
  /** The viewer's downlink probe for this session, kbps. */
  probeKbps: z.number().nullable(),
  /** The next rung's measured bitrate, kbps. */
  nextTierKbps: z.number().nullable(),
  capacityMargin: z.number(),
  /** The capacity a climb to `nextTier` needs, kbps (bitrate × margin, or the
   *  client ladder threshold when the rung has measured nothing). */
  neededKbps: z.number().nullable(),
  /** For `try-unclean`: which clean-path condition failed (a `WebrtcTryBlocker`,
   *  carried as a string for the same reason as `code`). */
  tryBlockedBy: z.string().nullable(),
  /** The delivery ratio and the loss ratio a try requires / must stay under.
   *  Optional, like every field added to this schema after it first shipped:
   *  the router validates output, so a REQUIRED new field makes a newer server
   *  reject an older broker's whole answer (review m1). */
  tryDeliveryRatio: z.number().optional(),
  tryMaxLossRatio: z.number().optional(),
  /** For `try-backoff`: time until the next try, ms. */
  retryInMs: z.number().nullable(),
  /** The last try that reverted in this viewer session. */
  lastRevert: z
    .object({
      tier: CamProfileSchema,
      deliveryRatio: z.number().nullable(),
      stalled: z.boolean(),
      at: z.number(),
    })
    .nullable(),
  /** For `trial`: how long this rung has been on trial, and for how long it must hold. */
  trialForMs: z.number().nullable(),
  trialMs: z.number().nullable(),
  healthyForMs: z.number().nullable(),
  requiredHealthyMs: z.number().nullable(),
  /** Epoch ms this hold's code began. */
  since: z.number(),
  /** The same one-line account the broker logs, e.g.
   *  `held: delivery 0.97 over 4.0s ok, REMB 480 kbps < mid 1800 kbps × 1.2`. */
  summary: z.string(),
})
export type WebrtcClimbHold = z.infer<typeof WebrtcClimbHoldSchema>

/** Per-tier count of MEASURED downgrades this viewer session has suffered. */
export const WebrtcTierFailureSchema = z.object({
  tier: CamProfileSchema,
  failures: z.number().int().nonnegative(),
})
export type WebrtcTierFailure = z.infer<typeof WebrtcTierFailureSchema>

/**
 * What the SERVER decided for one WebRTC session — the half the client cannot
 * measure. See `getSessionDebug`.
 */
export const WebrtcSessionDebugSchema = z.object({
  sessionId: z.string(),
  /** Whether the session still exists here. Everything below is null when
   *  it does not — a dead session has no measurements, not zero ones. */
  alive: z.boolean(),
  /** Epoch ms this snapshot was taken, so the overlay can show its age. */
  observedAt: z.number(),
  /** The broker actually feeding this session (`<deviceId>/<camStreamId>`). */
  brokerId: z.string().nullable(),
  camStreamId: z.string().nullable(),
  /** `derived` = this hub BUILT the rung being served (a transcode/scale of
   *  another stream); `native` = the camera's own encode. */
  sourceKind: z.enum(['native', 'derived', 'unknown']),
  /** Whether the ladder is running at all (an `adaptive` target). */
  adaptive: z.boolean(),
  /** The rung `auto` ACTUALLY resolved to right now. Null when the broker
   *  is bound to no profile slot (a manually-activated stream). */
  servedTier: CamProfileSchema.nullable(),
  /** Which node ingests the source. Null when unresolved. */
  ingestNodeId: z.string().nullable(),
  /** Whether that node is a remote one (the media crosses a node boundary
   *  before it reaches this session). Null when unresolved. */
  ingestIsRemote: z.boolean().nullable(),
  /** Codec off the source, and the one negotiated with this client. */
  sourceCodec: z.string().nullable(),
  negotiatedCodec: z.string().nullable(),
  /** Whether the EGRESS leg re-encodes for this client or forwards the
   *  source bytes untouched. */
  egressLeg: z.enum(['copy', 'transcode', 'unknown']),
  /** What the broker itself reports about the rung it is serving. */
  brokerStatus: z.string().nullable(),
  brokerCodec: z.string().nullable(),
  brokerBitrateKbps: z.number().nullable(),
  brokerInputFps: z.number().nullable(),
  brokerUptimeMs: z.number().nullable(),
  /** RTP packets this session has sent — the server's own "am I sending?". */
  rtpPacketsSent: z.number().nullable(),
  /** D42: the track may be carrying the recorded feeder, not live. The ladder
   *  is suspended there, so a frozen picture in `recorded` mode means
   *  something entirely different. */
  trackMode: z.enum(['live', 'recorded']).nullable(),
  lastDecision: WebrtcLadderDecisionSchema.nullable(),
  tierFailures: z.array(WebrtcTierFailureSchema),
  /** Successful promotions in this viewer session (drives the progressive
   *  healthy timer). Null when no ladder is running. */
  upgradeCount: z.number().nullable(),
  /** Why the ladder is not climbing right now. Null when no ladder runs, it
   *  is at the top rung, or it just moved. Optional because this output is
   *  validated by the router: a server carrying this schema must still accept
   *  the answer of a stream-broker deployed before the field existed. */
  climbHold: WebrtcClimbHoldSchema.nullable().optional(),
})
export type WebrtcSessionDebug = z.infer<typeof WebrtcSessionDebugSchema>

/**
 * WebRTC session — device-scoped facade over the system `webrtc` cap.
 *
 * Exposes per-device signaling (`createSession`, `handleAnswer`,
 * `closeSession`) on the device proxy so UI / integrations can
 * negotiate a session by (deviceId, profile) instead of constructing
 * an opaque `${deviceId}/${profile}` streamId string. The provider is
 * registered by the stream-broker addon for every camera device with
 * at least one active profile slot; internally it resolves
 * `${deviceId}/${profile}` and forwards to the system webrtc provider.
 *
 * The system `webrtc` cap remains available for cross-device / raw
 * streamId callers (debugging, admin tools). Production UI should
 * prefer this device-scoped cap.
 */
export const webrtcSessionCapability = {
  name: 'webrtc-session',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  // Deterministic default active provider: the werift stream-broker. Without
  // this, a second registered provider (historically the libwebrtc
  // webrtc-native addon) could win by registration order across reboots.
  preferredProvider: 'stream-broker',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /**
     * List available WebRTC streams for a device.
     * Returns adaptive (if any profile is assigned) + each assigned profile
     * with codec/resolution info. UI renders this directly — no hardcoded
     * profile names needed.
     */
    listStreams: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.array(WebrtcStreamChoiceSchema),
    ),
    /**
     * Open a WebRTC session against a specific target on the device.
     * `target.kind` discriminates between adaptive selection, a profile
     * slot, or a specific cam stream source — see `WebrtcStreamTarget`.
     * The server resolves the target to a live broker; clients never
     * build or parse brokerId strings.
     */
    createSession: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        target: WebrtcStreamTargetSchema,
        hints: webrtcClientHintsSchema.optional(),
        /**
         * SERVER-INJECTED — NOT a client hint. The hub layer that holds
         * the tRPC request context (and therefore the client IP) sets
         * this to `true` when the viewer's source IP is non-LAN
         * (4G/CGNAT/internet). The broker then forces TURN-relay-only
         * ICE for the session so a CGNAT client (which can only offer a
         * relay candidate) gets a clean relay↔relay media path instead
         * of werift nominating a dead host/hairpin-srflx pair. LAN
         * clients leave this absent/false and keep the low-latency
         * direct (host/srflx) path. Clients MUST NOT send this — the
         * server overwrites it from the request context.
         */
        relayOnly: z.boolean().optional(),
        /**
         * Subscriber attribution surfaced in the stream-broker widget's
         * client list. Callers (Alexa addon, browser hooks, WHEP server)
         * populate `kind` and any of `label`/`userId`/`sessionId`/
         * `remoteAddr` they know. The hub layer enriches `remoteAddr`
         * from the tRPC request context.
         */
        consumerAttribution: BrokerConsumerAttributionSchema.optional(),
      }),
      z.object({ sessionId: z.string(), sdpOffer: z.string() }),
      { kind: 'mutation' },
    ),
    /**
     * Accept a CLIENT-generated SDP offer and return the server's
     * SDP answer. Mirrors the WHEP / Alexa
     * `Alexa.RTCSessionController.InitiateSessionWithOffer` direction
     * (client offers, server answers) — the dual of `createSession`,
     * which has the server offer first.
     *
     * `target` defaults to the device's adaptive selection when
     * omitted; an optional `sessionId` lets the client provide its
     * own correlation id (Alexa supplies one in the directive
     * payload). The returned `sessionId` is whatever the server uses
     * to track the session and accepts via `closeSession`.
     */
    handleOffer: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        target: WebrtcStreamTargetSchema.optional(),
        sdpOffer: z.string(),
        sessionId: z.string().optional(),
        /**
         * Force TURN-relay-only ICE for this session. Two kinds of caller
         * set it:
         *  - A cloud peer like Alexa's RTCSessionController (reachable
         *    only via TURN, never our host/srflx behind NAT) passes
         *    `true` from its own trusted addon context.
         *  - The hub injects it for browser client-offer viewers from the
         *    request's source IP (non-LAN ⇒ true), exactly as it does for
         *    `createSession`.
         * A LAN/Tailscale browser doing client-offer passthrough leaves it
         * absent/false so a direct host pair carries full native quality.
         * Untrusted browser clients MUST NOT send it — the hub overwrites
         * it from the request context.
         */
        relayOnly: z.boolean().optional(),
        /**
         * Force a NON-TRICKLE answer: the server awaits ICE gathering to
         * COMPLETE and returns a full-candidate answer SDP (with `a=candidate`
         * lines) instead of the default bare/trickle answer.
         *
         * Set `true` by callers that DON'T support trickle ICE — notably
         * Alexa's RTCSessionController, which never polls `getIceCandidates`
         * nor trickles back via `addIceCandidate`, so without server
         * candidates in the answer SDP its ICE agent stalls (no nominated
         * pair → DTLS never connects → Echo shows black → SessionDisconnected).
         *
         * Browser viewers leave it absent/false: they poll `getIceCandidates`
         * and trickle, so the bare answer lets media start in ~0s instead of
         * blocking on full gathering.
         */
        nonTrickle: z.boolean().optional(),
        /**
         * Suppress TURN servers from the per-session iceConfig: the answer
         * will carry ONLY host + srflx candidates, never a relay one.
         *
         * Set `true` by peers that are themselves directly reachable on the
         * public internet (Alexa's RTCSessionController media gateway is
         * AWS-hosted with public host candidates). Including a TURN relay
         * for such a peer is counterproductive: (a) gathering blocks on the
         * TURN allocation round-trip and slows the answer; (b) werift
         * spends ICE-checking budget on a relay-pair that the peer cannot
         * use, sometimes stalling the host/srflx pair validation enough
         * that Echo's agent times out before nominating one — visible as
         * 'ICE checking → DTLS never connected'. Browser viewers leave it
         * absent/false so the relay candidate remains as a fallback for
         * symmetric-NAT clients.
         *
         * Independent from `relayOnly`. `relayOnly: true` forces ICE to a
         * relay-only pair set; `disableTurn: true` strips the relay
         * candidate entirely. They are mutually exclusive in practice but
         * not policed at the schema level — callers MUST NOT set both.
         */
        disableTurn: z.boolean().optional(),
        /**
         * Suppress IPv6 host candidates from gathering and from
         * `additionalHostAddresses`. The answer SDP will contain only IPv4
         * host/srflx (and TURN, unless `disableTurn` is also set).
         *
         * Set `true` by peers that document IPv4-only ICE — Amazon's
         * `Alexa.RTCSessionController` spec states: "For ICE candidates,
         * you can use either UDP or TCP but you must use IPv4." Echo's
         * media gateway ignores IPv6 candidates and they consume budget
         * against the gateway's documented 6-second SDP processing limit.
         *
         * Browser viewers leave it absent/false so IPv6-only paths
         * (Tailscale, native dual-stack) remain available.
         */
        disableIpv6: z.boolean().optional(),
        /** Subscriber attribution. See `createSession` for the contract. */
        consumerAttribution: BrokerConsumerAttributionSchema.optional(),
        /**
         * Client-side stream hints (viewport, downlink) — same contract as
         * `createSession.hints`. Client-offer viewers (the RN viewer's
         * `WebrtcLiveSession`) negotiate via `handleOffer`, so without this
         * field their hints were silently stripped by the schema and the
         * adaptive ladder started blind on the client's display size.
         */
        hints: webrtcClientHintsSchema.optional(),
        /**
         * Talk-back (D771): relay the PEER's audio to the device's speaker
         * through the `intercom` cap's push-talk triple. When `true` and the
         * offer lets the peer send audio, the answer's audio is `sendrecv`
         * and every inbound frame goes to `intercom.pushTalkAudio` for this
         * `deviceId`; absent/false answers `sendonly`, as for every viewer.
         *
         * TRUSTED-CALLER ONLY. Set by the Alexa export for an Echo on a camera
         * with `intercom`, when the linked user may control that camera. The
         * hub STRIPS it from every request-bound call (a browser), exactly as
         * it overwrites `relayOnly` — a viewer's talk permission is the
         * intercom cap's own surface (share tokens gate it there), and this
         * flag must not become a second door to the camera's speaker.
         */
        talkback: z.boolean().optional(),
      }),
      z.object({ sessionId: z.string(), sdpAnswer: z.string() }),
      { kind: 'mutation' },
    ),
    handleAnswer: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        sessionId: z.string(),
        sdpAnswer: z.string(),
      }),
      z.void(),
      { kind: 'mutation' },
    ),
    /**
     * Trickle ICE — add a remote (client) ICE candidate to a live session.
     * Lets the client send its SDP offer/answer IMMEDIATELY (before ICE
     * gathering finishes) and deliver candidates as they arrive, so the
     * connection establishes in ~0s instead of waiting for full gathering.
     * The dual of `getIceCandidates` in the trickle-ICE signaling exchange.
     */
    addIceCandidate: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        sessionId: z.string(),
        candidate: z.string(),
        sdpMid: z.string().nullable().optional(),
        sdpMLineIndex: z.number().int().nullable().optional(),
      }),
      z.void(),
      { kind: 'mutation' },
    ),
    /**
     * Trickle ICE — poll the server's gathered ICE candidates for a session.
     * The server answers immediately (no gathering wait) and the client polls
     * this to receive host/srflx/relay candidates as werift gathers them,
     * adding each to its PeerConnection. Returns all candidates gathered so
     * far; the client dedupes. `done` flips true once gathering completes.
     */
    getIceCandidates: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        sessionId: z.string(),
      }),
      z.object({
        candidates: z.array(
          z.object({
            candidate: z.string(),
            sdpMid: z.string().nullable(),
            sdpMLineIndex: z.number().int().nullable(),
          }),
        ),
        done: z.boolean(),
      }),
      { kind: 'query' },
    ),
    closeSession: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        sessionId: z.string(),
      }),
      z.void(),
      { kind: 'mutation' },
    ),
    /** Whether the underlying provider supports adaptive bitrate for this profile. */
    hasAdaptiveBitrate: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        profile: CamProfileSchema,
      }),
      z.boolean(),
    ),
    /** Poll the live signaling state of a session. `pendingRenegotiation` is
     *  non-null after an adaptive tier switch — the client re-offers on the
     *  same sessionId; `epoch` guards against acting on a stale poll twice. */
    getSessionState: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        sessionId: z.string(),
      }),
      z.object({
        pendingRenegotiation: z
          .object({ target: WebrtcStreamTargetSchema, epoch: z.number() })
          .nullable(),
        /**
         * Whether the session still EXISTS.
         *
         * A consumer that holds a resource for the life of a session needs to
         * be able to ask, because a session does not always end the way it
         * began. Measured on this hub 2026-09-13: an Echo that got stuck never
         * sent `SessionDisconnected`, so the Alexa exporter's
         * `releaseEgressTranscode` never ran, and a 2304x1296 HEVC to 720p
         * H.264 transcode kept running for NOBODY for more than twenty
         * minutes. The WebRTC session had logged `WebRTC session closed`
         * minutes earlier — the broker knew; the holder had no way to ask.
         *
         * `false` for a session id the provider has never heard of, which is
         * the same answer as "it ended": either way nothing is holding it up.
         */
        alive: z.boolean(),
      }),
    ),
    /**
     * The viewer's downlink probe, for ONE live session (D733).
     *
     * The player measures `/adaptive-probe` after the session's first decoded
     * frame (D635). It used to act on the reading itself, by opening a SECOND
     * session with `hints.downlinkMbps` — every adaptive live open became two
     * sessions, two ICE + DTLS handshakes and two server pipelines. It now
     * hands the measurement to the session it already has; the provider picks
     * the rung exactly as it would from an offer's hints (same viewport
     * ceiling) and moves the session there — in place when the negotiated
     * codec carries the new rendition, by the existing re-offer
     * (`getSessionState.pendingRenegotiation`) when it cannot.
     *
     * A MEASUREMENT, never a tier: the client does not choose. A probe only
     * raises the rung; lowering it stays the ladder's call on delivery.
     * `held` answers why nothing moved (`not-adaptive`, `pinned`,
     * `already-there`, `recorded`, …) — a client that gets ANY answer must not
     * fall back to a reconnect; only a provider that does not know the method
     * (an older hub) leaves the client its legacy second session.
     */
    applyDownlinkProbe: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        sessionId: z.string(),
        downlinkMbps: z.number().nonnegative(),
      }),
      z.object({
        outcome: z.enum(['switching', 'held']),
        tier: CamProfileSchema.nullable(),
        reason: z.string(),
      }),
      { kind: 'mutation' },
    ),
    /**
     * The SERVER's half of the stream-debug overlay, for one live session.
     *
     * The client can measure its own transport (`getStats()`); it cannot see
     * which rung `auto` actually resolved to, why the ladder last moved, or
     * whether the rung it is being served is the camera's own encode or
     * something this hub built. That asymmetry is why "quality is stuck on
     * low" reports have historically been unanswerable from the viewer alone.
     *
     * EVERY measurement here is nullable and `null` means UNKNOWN, never zero
     * (D393): a session whose ladder has never moved reports
     * `lastDecision: null`, which is a different fact from a ladder that moved
     * for `healthy` with a 0 loss ratio.
     *
     * Read-only, ~1 Hz, polled by the overlay only while it is visible.
     */
    getSessionDebug: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        sessionId: z.string(),
      }),
      WebrtcSessionDebugSchema,
      { kind: 'query' },
    ),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type IWebrtcSessionProvider = InferProvider<typeof webrtcSessionCapability>
