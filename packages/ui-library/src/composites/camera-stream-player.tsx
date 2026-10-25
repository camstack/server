import { useUiText } from '../contexts/ui-text'
import { useEffect, useRef, useState, useCallback, type JSX, type ReactNode } from 'react'
import type { CamProfile, WebrtcSessionDebug } from '@camstack/types'
import { nextReconnectAction, type ReconnectAction } from './reconnect-schedule'
import { hubOrigin } from '../lib/hub-mount'
import {
  adaptiveHintsKey,
  createDownlinkProbe,
  measureDownlinkMbps,
  probeAfterFirstFrame,
  type LatestProbe,
  resolveProbeOrigin,
  waitForFirstFrame,
  stripDownlinkForColdStart,
  shouldUpgradeAfterProbe,
  handProbeToSession,
  type AdaptiveHintsReport,
  type AdaptiveOfferPhase,
  type ApplyDownlinkProbe,
} from './adaptive-downlink'
import {
  nextClientSample,
  type ClientNetworkSample,
  type InboundReading,
} from './client-network-sample'
import { buildPeerConnectionConfig } from './peer-connection-config'
import { StreamDebugOverlay } from './stream-debug/stream-debug-overlay.js'
import {
  deriveWebrtcDebugStats,
  freezeVerdict,
  type StreamDebugSample,
  type WebrtcDebugStats,
} from './stream-debug/webrtc-debug-stats.js'

// iOS WebKit (Safari / Chrome-on-iOS) exposes a non-standard presentation-mode
// API on <video> instead of the standard Picture-in-Picture API. These members
// aren't in lib.dom, so declare them as optional here — accessed directly
// (typed, cast-free) rather than via `Reflect.get` (which returns `any`).
type WebkitPresentationMode = 'inline' | 'picture-in-picture' | 'fullscreen'

/**
 * Silence (or restore) a live WebRTC stream FOR REAL.
 *
 * `video.muted` alone is not enough: iOS WebKit keeps playing a
 * `MediaStream`'s audio track through a muted element, which is why live audio
 * kept sounding under recorded playback on the viewer. Gating the audio TRACK
 * (`track.enabled`) is what actually stops it, so both are set together — and
 * re-applied at every stream swap, because a freshly-attached stream arrives
 * with its tracks enabled whatever the element says.
 */
function applyStreamMute(video: HTMLVideoElement, muted: boolean): void {
  video.muted = muted
  const stream = video.srcObject
  if (stream instanceof MediaStream) {
    for (const track of stream.getAudioTracks()) track.enabled = !muted
  }
}
declare global {
  interface HTMLVideoElement {
    webkitSetPresentationMode?: (mode: WebkitPresentationMode) => void
    readonly webkitPresentationMode?: WebkitPresentationMode
    // NOTE: `requestVideoFrameCallback` / `cancelVideoFrameCallback` are now
    // provided by lib.dom — do NOT re-declare them here (it conflicts with the
    // built-in signature). The call site guards with `typeof … === 'function'`.
  }
}

// ── Mobile / touch detection ──────────────────────────────────────────────────
// Checked once at module load; safe for SSR (typeof window guard).
// We use this to always show the toolbar on touch-primary devices instead of
// relying on mouse-hover events that never fire on mobile browsers.
function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  // `matchMedia('(hover:none) and (pointer:coarse)')` alone misfires in some
  // iOS Safari contexts (capability mis-reported), which left the player's
  // toolbar pinned-hidden (opacity-0) and the controls effectively absent.
  // `maxTouchPoints` / `ontouchstart` are reliable touch signals on iOS.
  return (
    window.matchMedia('(hover: none) and (pointer: coarse)').matches ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    'ontouchstart' in window
  )
}

/** True when a captured canvas is (near-)uniformly black. Used to reject blank
 *  iOS-WebKit WebRTC captures so a black frame is never promoted as the retained
 *  still (which would "cover" a reconnect with black). Samples a sparse grid
 *  (cheap) rather than reading the whole bitmap. */
function isCanvasEffectivelyBlack(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const cols = 8
  const rows = 8
  const lumaThreshold = 12 // 0–255; a pixel above this counts as "lit"
  let lit = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.min(w - 1, Math.floor(((c + 0.5) / cols) * w))
      const y = Math.min(h - 1, Math.floor(((r + 0.5) / rows) * h))
      const { data } = ctx.getImageData(x, y, 1, 1)
      const luma = 0.2126 * (data[0] ?? 0) + 0.7152 * (data[1] ?? 0) + 0.0722 * (data[2] ?? 0)
      if (luma > lumaThreshold) lit++
    }
  }
  // Tolerate a couple of stray lit samples (noise); otherwise treat as black.
  return lit <= 1
}

// ── Types ────────────────────────────────────────────────────────────────────

export type PlayerConnectionState = 'connecting' | 'playing' | 'error' | 'disconnected' | 'idle'

/**
 * Discriminated WebRTC target — same shape as `WebrtcStreamTarget` on the
 * backend cap; the `profile` tier uses the canonical `CamProfile` enum.
 * Carried by `getSessionState`'s `pendingRenegotiation` and handed back to
 * `reoffer` verbatim during an adaptive re-offer.
 */
export type PlayerWebrtcTarget =
  | { readonly kind: 'adaptive' }
  | { readonly kind: 'profile'; readonly profile: CamProfile }
  | { readonly kind: 'cam-stream'; readonly camStreamId: string }

/** Live signaling state polled mid-stream — the adaptive re-offer signal. */
export interface SessionSignalingState {
  readonly pendingRenegotiation: {
    readonly target: PlayerWebrtcTarget
    readonly epoch: number
  } | null
}

/**
 * Signaling function for WebRTC connection.
 * Called by the player to establish the WebRTC session.
 * Must return an RTCSessionDescription (the server's offer or answer depending on mode).
 *
 * Server-offer mode (default):
 *   1. signalingFn is called with streamId → returns { sessionId, sdpOffer }
 *   2. Player sets remote description (server offer), creates answer
 *   3. Player calls answerFn(sessionId, sdpAnswer) to complete
 *
 * WHEP mode (legacy):
 *   1. Player creates offer, gathers ICE
 *   2. signalingFn is called with the client SDP offer → returns sdpAnswer
 *   3. Player sets remote description (answer)
 */
export interface SignalingResult {
  /** Server-offer mode: session ID + SDP offer from server */
  sessionId: string
  sdpOffer: string
  /**
   * ICE servers (STUN/TURN) the BROWSER should use, supplied by the server
   * from its `turn-provider` cap. Critical for remote viewing: behind CGNAT
   * (e.g. mobile data) the browser needs a TURN relay candidate or it has no
   * reachable address and the stream stays black. Falls back to public STUN.
   */
  iceServers?: readonly RTCIceServer[]
}

/**
 * Client-offer mode result: the server's SDP answer to a browser-built
 * offer. The browser creates the offer advertising its FULL decode caps
 * (incl. H.264 High on iOS 18), the server answers by echoing the matching
 * codec, and the camera's native bytes pass through untouched — no
 * transcode. This is the dual of `SignalingResult`'s server-offer flow.
 */
export interface ClientOfferResult {
  sessionId: string
  sdpAnswer: string
}

/**
 * Client-side capabilities sent to the server at session creation.
 * The server uses these to pick the best native source for adaptive
 * streams (e.g. a 320×180 thumbnail player on a slow link gets the
 * camera's low stream rather than ffmpeg-transcoded 4K).
 *
 * All fields are optional — when omitted the server defaults to its
 * highest-quality registered source.
 */
export interface ClientStreamHints {
  viewportWidth?: number
  viewportHeight?: number
  devicePixelRatio?: number
  downlinkMbps?: number
  prefersTier?: string
}

/**
 * Read viewport + browser network info to populate hints. Falls back
 * to `window` size if the container isn't measurable yet (StrictMode
 * double-mount during development can hit this path).
 */
function computeClientHints(container: HTMLElement | null): ClientStreamHints {
  const hints: ClientStreamHints = {}
  if (typeof window !== 'undefined') {
    const dpr = window.devicePixelRatio || 1
    if (container) {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        hints.viewportWidth = Math.round(rect.width * dpr)
        hints.viewportHeight = Math.round(rect.height * dpr)
      }
    }
    if (hints.viewportWidth === undefined) {
      hints.viewportWidth = Math.round(window.innerWidth * dpr)
      hints.viewportHeight = Math.round(window.innerHeight * dpr)
    }
    hints.devicePixelRatio = dpr
  }
  return hints
}

const DOWNLINK_TTL_MS = 30_000
/**
 * ONE probe store for the whole app: every player of every camera shares the
 * cache and the probe in flight (review I6 — a grid decoding together fired
 * N concurrent 1 MiB probes, each reading the link ÷ N).
 */
const downlinkProbe = createDownlinkProbe({ now: () => Date.now(), ttlMs: DOWNLINK_TTL_MS })

/**
 * Measure the downlink against the HUB, not the page. `serverUrl` is the hub
 * this player is already signalling to; the page origin is only a fallback,
 * and inside the native WKWebView it is `file://` — see `resolveProbeOrigin`
 * for the full account of what that cost.
 */
/** The origin the probe WILL use, for the client's own decision log. */
function probeOriginFor(serverUrl: string): string | null {
  return resolveProbeOrigin(serverUrl, typeof window !== 'undefined' ? hubOrigin() : undefined)
}

/**
 * The probe, cached or measured (single-flight). `/adaptive-probe` requires a
 * session (D635 round 3): the session cookie rides for a hub-served page
 * (same-origin), and a host whose page cannot carry the cookie (the native
 * app's `file://` embed, a third-party iframe) passes `probeAuthToken`. Without either the
 * probe answers 401 — unknown, never slow (D315).
 */
/** Told the first time an origin refuses the probe in this app (N3). */
type ProbeRefusedSink = (origin: string, status: number) => void

function measuredDownlinkMbps(
  serverUrl: string,
  authToken: string | null,
  onRefused: ProbeRefusedSink,
): Promise<number | undefined> {
  const origin = probeOriginFor(serverUrl)
  if (origin === null) return Promise.resolve(undefined)
  return downlinkProbe.measured(origin, () =>
    measureDownlinkMbps(origin, {
      onRefused: (status) => {
        if (downlinkProbe.firstRefusal(origin, status)) onRefused(origin, status)
      },
      fetchImpl: (url, init) =>
        fetch(url, {
          ...init,
          // Default `same-origin` credentials: the cookie rides to a hub-served
          // page. NOT `include` — the hub answers CORS with `*`, and a browser
          // rejects a credentialed cross-origin response to a wildcard.
          ...(authToken !== null ? { headers: { authorization: `Bearer ${authToken}` } } : {}),
        }),
      now: () => Date.now(),
    }),
  )
}

/** The cached probe only — never measures (review I5: a renegotiation must not
 *  push 1 MiB into the link that just stalled, nor wait 2.5 s for it). */
function cachedDownlinkMbps(serverUrl: string): number | undefined {
  const origin = probeOriginFor(serverUrl)
  return origin === null ? undefined : downlinkProbe.cached(origin)
}

/** The newest probe whatever it read — carried in the telemetry (review I4). */
function latestProbeReading(serverUrl: string): LatestProbe | null {
  const origin = probeOriginFor(serverUrl)
  return origin === null ? null : downlinkProbe.latest(origin)
}

/**
 * The cold-start probe, deferred until THIS connection's first decoded frame
 * (D635). Fired alongside `createSession` it competed with session setup on
 * the hub and read the LAN at ~1.4 Mbps. `readyState` alone is not enough:
 * a reconnect deliberately keeps the previous (ended) stream on the element
 * so its last frame stays visible, and that stream already reads
 * HAVE_CURRENT_DATA — so the frame must belong to `stream`.
 */
interface FirstFrameProbeArgs {
  readonly video: () => HTMLVideoElement | null
  readonly stream: MediaStream
  readonly signal: AbortSignal
  readonly serverUrl: string
  readonly authToken: string | null
  readonly onRefused: ProbeRefusedSink
}

function probeAfterThisStreamsFirstFrame(args: FirstFrameProbeArgs): Promise<number | undefined> {
  return probeAfterFirstFrame({
    waitFrame: () =>
      waitForFirstFrame({
        readyState: () => {
          const v = args.video()
          return v !== null && v.srcObject === args.stream ? v.readyState : null
        },
        signal: args.signal,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      }),
    measure: () => measuredDownlinkMbps(args.serverUrl, args.authToken, args.onRefused),
  })
}

function mergePlayerHints(
  autoHints: ClientStreamHints,
  override: Partial<ClientStreamHints> | undefined,
  downlinkMbps: number | undefined,
  coldStart: boolean,
): ClientStreamHints {
  const merged: ClientStreamHints = {
    ...autoHints,
    ...(downlinkMbps !== undefined ? { downlinkMbps } : {}),
    ...override,
  }
  return coldStart ? stripDownlinkForColdStart(merged) : merged
}

export type { ClientNetworkSample } from './client-network-sample'

export interface CameraStreamPlayerProps {
  /** Server base URL (e.g. window.location.origin) */
  serverUrl: string
  /**
   * Stable key used for React reconciliation (the player remounts when
   * this changes), the snapshot filename, and WHEP fallback URL. The
   * value is opaque to the player — no parsing, no semantic meaning.
   * Typical values: a `StreamChoice.id` (`'profile:high'`, `'stream:native:main'`).
   */
  streamKey: string
  /** Human-readable label shown in overlay */
  label?: string
  /** Auto-play on mount (default: true) */
  autoPlay?: boolean
  /** Start muted (default: true) */
  muted?: boolean
  /** Show toolbar controls (default: true) */
  showControls?: boolean
  /** Show a live client-side WebRTC stats overlay (bitrate/fps/res/RTT),
   *  computed from the PeerConnection's getStats(). Default: false. */
  showStats?: boolean
  /**
   * Report the same measurements to a HOST instead of (or as well as) drawing
   * them.
   *
   * The overlay is a DOM layer, and in the native app the player lives inside a
   * WebView whose touches the RN gesture layer owns — so the panel that opens
   * on a tap can never be opened there. The numbers still have to reach the
   * operator, so they travel out to whoever mounted the player and are rendered
   * in its own UI, next to the battery and link details.
   *
   * Wiring this turns the two 1 Hz polls on by itself: a host that asked for
   * samples wants them whether or not the in-picture overlay is drawn.
   */
  onDebugStats?: (sample: StreamDebugSample) => void
  /** When provided, polls inbound-video getStats() every 5 s during playback
   *  and reports per-window health metrics (frames received/decoded/dropped,
   *  freezes, jitter, playback-clock advance). The embed forwards these over the
   *  existing host log bridge (`{type:'log', scope:'playback'}`), which always
   *  ships — this is the client half of the recorded stutter census. */
  onPlaybackStats?: (data: Record<string, unknown>) => void
  /**
   * When provided, samples the inbound-video getStats() ~every 2s and reports
   * the CLIENT's live network conditions (packet-loss %, jitter, downlink
   * bitrate, RTT) so the caller can push them to the server's
   * `networkQuality.reportClientStats`. This is what lets the broker's ADAPTIVE
   * ladder actually downgrade "auto" under a poor link: without a client
   * signal the server sees only coarse RTCP RR and tends to stay on the top
   * tier. Inert (zero behaviour change) unless a callback is passed; wire it
   * only for adaptive sessions. */
  onClientNetworkSample?: (sample: ClientNetworkSample) => void
  /**
   * Bearer for `/adaptive-probe`, which requires a session (D635). A page the
   * hub serves carries the session cookie and needs none; a host whose page
   * cannot (the native app's `file://` embed) passes its token here. Absent
   * and cookieless, the probe reads unknown and the broker's own ladder
   * decides (try-climb on a clean path).
   */
  probeAuthToken?: string | null
  /**
   * Cold-start phase breakdown, fired ONCE per connect when ICE reaches
   * connected (the same object the `[WebRTC timing]` console line prints:
   * iceServersMs/offerCreatedMs/localSetMs/signalingRttMs/answerSetMs/
   * iceConnectedMs/firstTrackMs — plus firstFrameMs when the first frame
   * DECODES, reported separately as a patch call). Lets an embedding host
   * (the RN app's WebView) ship the numbers to its own logs instead of them
   * dying in the in-WebView console. Inert unless wired. */
  onConnectTiming?: (timing: Record<string, number>) => void
  /** Additional CSS classes for the root container */
  className?: string
  /** Called on connection state change */
  onStateChange?: (state: PlayerConnectionState) => void
  /** Called on error */
  onError?: (error: string) => void
  /**
   * Observer of the auto-retry loop: called with every scheduled attempt and
   * with the exhaustion edge. Hosts wire it to their log pipeline (tagged with
   * the camera) — a retry loop nobody can see is how a camera stays dark
   * while looking busy.
   */
  onReconnectAttempt?: (action: ReconnectAction) => void
  /** Custom overlay rendered on top of the video */
  overlay?: ReactNode
  /**
   * Create a WebRTC session (server-offer signaling). When provided,
   * uses server-offer mode instead of WHEP. The caller closes over the
   * target (profile / cam-stream / adaptive) and any device context;
   * the player just hands it the auto-derived `hints` (viewport,
   * downlink) so the server can score adaptive selections.
   */
  createSession?: (hints?: ClientStreamHints) => Promise<SignalingResult>
  /**
   * Send the client's SDP answer (server-offer signaling).
   * Required when createSession is provided.
   */
  sendAnswer?: (sessionId: string, sdpAnswer: string) => Promise<void>
  /**
   * Client-offer signaling — PREFERRED over `createSession` when supplied.
   * The player builds the SDP offer (advertising the browser's full native
   * decode caps, incl. H.264 High on iOS 18) and this posts it to the
   * server, which answers by echoing the matching codec. That lets a
   * Main/High (incl. 4K) source pass through with NO transcode — the only
   * path that lets iOS decode High. The caller closes over the target.
   */
  handleOffer?: (
    sdpOffer: string,
    sessionId?: string,
    hints?: ClientStreamHints,
  ) => Promise<ClientOfferResult>
  /**
   * Fetch the browser-side ICE servers (STUN + TURN) for client-offer mode.
   * Called BEFORE the offer is built so a remote/CGNAT viewer can gather a
   * relay candidate. Best-effort — resolve `undefined` to use public STUN.
   */
  getIceServers?: () => Promise<readonly RTCIceServer[] | undefined>
  /** Trickle ICE — push a client-gathered candidate to the server. */
  addIceCandidate?: (sessionId: string, candidate: RTCIceCandidateInit) => Promise<void>
  /** Trickle ICE — poll the server's gathered candidates for a session. */
  getIceCandidates?: (
    sessionId: string,
  ) => Promise<{ candidates: RTCIceCandidateInit[]; done: boolean }>
  /** Explicitly close the WebRTC session on server (cleanup on unmount). */
  closeSession?: (sessionId: string) => Promise<void>
  /**
   * Poll the live signaling state of a session (client-offer mode only).
   * After the server swaps the broker source to a different tier (adaptive
   * downgrade), this returns a non-null `pendingRenegotiation` with the new
   * target + a monotonic `epoch`. The player then transparently re-offers
   * on the SAME sessionId — building a fresh PeerConnection in the
   * background and only swapping the live `<video>` to the new stream once
   * it delivers media, so the last decoded frame stays on screen with no
   * loader. Best-effort: omit it to disable adaptive re-offer entirely.
   */
  getSessionState?: (sessionId: string) => Promise<SessionSignalingState>
  /**
   * Poll the SERVER's account of this session for the stream-debug overlay —
   * the rung `auto` actually resolved to, whether that rung is the camera's
   * own encode or one this hub built, which node ingests it, whether the
   * egress leg copies or re-encodes, and the cause + numbers of the ladder's
   * last move (`webrtcSession.getSessionDebug`).
   *
   * The client can measure its own transport; it cannot see any of that, and
   * "quality is stuck on low" is unanswerable without it. Called at ~1 Hz
   * ONLY while `showStats` is true, and never when it is false. Omit it and
   * the overlay shows its client half alone, saying so.
   */
  getSessionDebug?: (sessionId: string) => Promise<WebrtcSessionDebug>
  /**
   * Hand the downlink probe to the session it was measured on
   * (`webrtcSession.applyDownlinkProbe`, D733). The hub then moves THAT
   * session to the probed rung — in place when it can — so a live open stays
   * one session. Omit it (or talk to a hub that does not know the method) and
   * the player keeps its legacy climb: a second, make-before-break session.
   */
  applyDownlinkProbe?: ApplyDownlinkProbe
  /**
   * Re-offer signaling for an adaptive tier switch (client-offer mode).
   * Posts a fresh browser-built offer for an EXISTING `sessionId` against
   * the new `target` (from `getSessionState`'s `pendingRenegotiation`). The
   * server closes the stale session and creates a fresh one under the same
   * id, bound to the new tier's source. Distinct from `handleOffer`, whose
   * target is fixed at the player's selected stream — a re-offer must carry
   * the server-chosen downgrade target instead. Required (alongside
   * `getSessionState`) for adaptive re-offer to run.
   */
  reoffer?: (
    sessionId: string,
    sdpOffer: string,
    target: PlayerWebrtcTarget,
    hints?: ClientStreamHints,
  ) => Promise<ClientOfferResult>
  /**
   * Optional poster image (snapshot data-URL) shown by the <video> before
   * the FIRST-EVER frame is decoded. Only a cold-start fallback — once a
   * frame is showing, the player keeps the last decoded frame across
   * renegotiations and never falls back to the poster. Caller-supplied.
   */
  posterUrl?: string
  /**
   * Override client hints sent to the server at session creation.
   * Values provided here replace the auto-computed browser values.
   * Use for network simulation (benchmark) or manual tier forcing.
   */
  hintsOverride?: Partial<ClientStreamHints>
  /**
   * Observer of the ADAPTIVE decision this client just made — fired once per
   * decision CHANGE (see `adaptiveHintsKey`), never per tick.
   *
   * Deliberately the client's half only: the viewport it measured, the pixel
   * ratio, the downlink it managed to measure (and the origin it probed, null
   * when none was reachable), and the phase of the offer that carried them.
   * The hub logs its own pick from the same inputs; duplicating that here
   * would be a second opinion on someone else's decision. Hosts join the two
   * halves — the RN viewer forwards this over the embed log bridge so a
   * "quality is stuck on low" report carries what the app actually SENT.
   *
   * Inert unless wired.
   */
  onAdaptiveHints?: (report: AdaptiveHintsReport) => void
  /**
   * Host-driven fast reconnect. Bump this number (monotonic) to force a
   * full reconnect WITHOUT remounting the player — used by the embed when
   * the native shell detects a network change (Wi-Fi↔cellular) or returns
   * from background. Because `cleanup()` no longer clears `srcObject`, the
   * LAST DECODED FRAME stays on screen across the reconnect (no black
   * flash, no covering loader). The initial value is ignored — only
   * changes trigger a reconnect. Distinct from remounting via `streamKey`,
   * which blanks the element.
   */
  reconnectSignal?: number
  /**
   * Optional control data-channel hook (client-offer mode only). When
   * provided, the player opens a `camstack-control` `RTCDataChannel` on the
   * PeerConnection BEFORE building the offer (so it is negotiated into the
   * m=application section) and hands the channel to this callback for each new
   * connection. Used by the recorded-playback timeline embed to drive the
   * broker's `TimelineSession` (seek / scrub-commit / play-rate / go-live) and
   * receive server state/position over the SAME WebRTC session that carries the
   * unified live-or-recorded `<video>` track. Omit it (the default) for a plain
   * live player — no data channel is created and behaviour is unchanged.
   */
  onControlChannel?: (channel: RTCDataChannel) => void
  /**
   * Optional handle to the player's `<video>` element, delivered once on mount
   * (and `null` on unmount). Consumers that pace server-pushed frames by what
   * the viewer actually RENDERED (`requestVideoFrameCallback`) need the
   * element itself — the recorded-scrub receiver-credit acks are the use case.
   */
  onVideoElement?: (el: HTMLVideoElement | null) => void
  /**
   * DIAGNOSTICS ONLY — the browser's ICE transport policy for every peer
   * connection this player builds. Absent (always, in production) the policy
   * is not set and the browser gathers host/srflx/relay as before. The WebRTC
   * diagnostics set `'relay'` to prove whether a TURN-only path reaches the
   * hub; see `peer-connection-config.ts` for why the player never does.
   */
  iceTransportPolicy?: RTCIceTransportPolicy
  /**
   * Observer of every peer connection this player creates (first connect,
   * reconnects, re-offers), handed over right after construction and before
   * any signaling. For listeners only — the diagnostics read ICE / DTLS
   * transitions and local candidates through `addEventListener`; a caller
   * must never assign the `on*` handlers the player owns.
   */
  onPeerConnection?: (pc: RTCPeerConnection) => void
}

// Reconnect policy (backoff shape, jitter, attempt budget) lives in
// `reconnect-schedule.ts` as a pure, tested decision function. The counter
// resets to 0 on ICE `connected`, so a recovered stream restores the full
// budget; exhaustion surfaces a HARD error through the same state chain as
// every other failure (never a silent stop).

// After ICE connects, how long to wait for the FIRST decoded frame before
// logging an explicit stall. Diagnoses "connected but black" (adaptive-remote-
// never-loads): media/track present but no keyframe reassembles.
const FIRST_FRAME_TIMEOUT_MS = 8_000

// ── Component ────────────────────────────────────────────────────────────────

export function CameraStreamPlayer({
  serverUrl,
  streamKey,
  label,
  autoPlay = true,
  muted: initialMuted = true,
  showControls = true,
  showStats = false,
  onDebugStats,
  onPlaybackStats,
  onClientNetworkSample,
  probeAuthToken,
  onConnectTiming,
  className = '',
  onStateChange,
  onError,
  onReconnectAttempt,
  overlay,
  createSession,
  sendAnswer,
  handleOffer,
  getIceServers,
  addIceCandidate,
  getIceCandidates,
  closeSession,
  getSessionState,
  getSessionDebug,
  applyDownlinkProbe,
  reoffer,
  posterUrl,
  hintsOverride,
  onAdaptiveHints,
  reconnectSignal,
  onControlChannel,
  onVideoElement,
  iceTransportPolicy,
  onPeerConnection,
}: CameraStreamPlayerProps): JSX.Element {
  const t = useUiText()
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  /** All session IDs created during this player's lifetime — closed on cleanup */
  const sessionIdsRef = useRef(new Set<string>())
  /** Abort controller to cancel in-flight connection attempts on cleanup */
  const connectAbortRef = useRef<AbortController | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const mountedRef = useRef(true)
  /** Stable handle to the latest `onControlChannel` so `connectClientOffer`
   *  (and its reconnects) always opens the control channel with the current
   *  consumer, without re-creating the connect callback on every render. */
  const onControlChannelRef = useRef(onControlChannel)
  onControlChannelRef.current = onControlChannel
  /** Read at connect time through refs so neither diagnostics prop re-creates
   *  the connect callbacks (and so neither forces a reconnect when it changes). */
  const iceTransportPolicyRef = useRef(iceTransportPolicy)
  iceTransportPolicyRef.current = iceTransportPolicy
  const onPeerConnectionRef = useRef(onPeerConnection)
  onPeerConnectionRef.current = onPeerConnection
  /** Same pattern for the video-element handle: delivered once on mount, null
   *  on unmount — the ref keeps the latest consumer without re-running. */
  const onVideoElementRef = useRef(onVideoElement)
  onVideoElementRef.current = onVideoElement
  useEffect(() => {
    onVideoElementRef.current?.(videoRef.current)
    return () => onVideoElementRef.current?.(null)
  }, [])
  /** Same pattern for the adaptive-decision observer — a ref so wiring it does
   *  not re-create the mount-stable connect callbacks. */
  const onAdaptiveHintsRef = useRef(onAdaptiveHints)
  onAdaptiveHintsRef.current = onAdaptiveHints
  /** Last reported decision key — the "once per CHANGE, not per tick" latch. */
  const lastAdaptiveKeyRef = useRef<string | null>(null)
  /**
   * Report the hints THIS offer carried, when they differ from the last
   * reported decision. Mount-stable (`[]` deps by contract) so the connect
   * callbacks can call it without gaining a dependency.
   */
  const reportAdaptiveHints = useCallback(
    (phase: AdaptiveOfferPhase, hints: ClientStreamHints, probeOrigin: string | null): void => {
      const cb = onAdaptiveHintsRef.current
      if (!cb) return
      const report: AdaptiveHintsReport = { phase, probeOrigin, ...hints }
      const key = adaptiveHintsKey(report)
      if (key === lastAdaptiveKeyRef.current) return
      lastAdaptiveKeyRef.current = key
      cb(report)
    },
    [],
  )

  /**
   * A refused probe (401 without a session, 429) goes out on the SAME channel
   * as the adaptive decisions — hosts already forward it over their log bridge
   * — once per origin app-wide (`firstRefusal`), so a missing `probeAuthToken`
   * is visible instead of reading like a failed probe (review N3).
   */
  /** A ref so wiring it never rebuilds the connect callbacks (same as `onAdaptiveHints`). */
  const applyDownlinkProbeRef = useRef(applyDownlinkProbe)
  applyDownlinkProbeRef.current = applyDownlinkProbe

  /**
   * After a cold start's probe justifies a higher rung: hand it to the session
   * it was measured on (D733). Only when the hub cannot take it does the
   * legacy climb run — `reconnect`, a second make-before-break session.
   */
  const climbAfterProbe = useCallback(
    async (sessionId: string | null, mbps: number, reconnect: () => void): Promise<void> => {
      const handoff = await handProbeToSession(applyDownlinkProbeRef.current, sessionId, mbps)
      if (!mountedRef.current) return
      if (handoff.kind === 'unsupported') {
        reconnect()
        return
      }
      const { outcome, tier, reason } = handoff.answer
      onAdaptiveHintsRef.current?.({
        phase: 'probe-in-session',
        probeOrigin: probeOriginFor(serverUrl),
        downlinkMbps: mbps,
        probeAnswer: `${outcome}:${tier ?? '-'}:${reason}`,
      })
    },
    [serverUrl],
  )

  const reportProbeRefused = useCallback((origin: string, status: number): void => {
    onAdaptiveHintsRef.current?.({
      phase: 'probe-refused',
      probeOrigin: origin,
      probeStatus: status,
    })
  }, [])

  // ── Adaptive re-offer state ──────────────────────────────────────────────
  /** The live session being polled for `pendingRenegotiation` (client-offer). */
  const activeSessionIdRef = useRef<string | null>(null)
  /** Timer for the session-state (renegotiation) poll loop. */
  const sessionPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Highest `pendingRenegotiation.epoch` already acted on — act at most once
   *  per epoch so a poll that re-reports the same pending change is a no-op. */
  const lastEpochRef = useRef(0)
  /** True once this adaptive session already climbed after the cold-start probe. */
  const probeUpgradeRef = useRef(false)
  /** True while a background re-offer PeerConnection is being built — guards
   *  against a second poll firing a parallel renegotiation. */
  const renegotiatingRef = useRef(false)
  /** Holds the latest `renegotiate` so the poll loop (a stable callback) can
   *  invoke it without capturing a stale closure — mirrors `connectRef`. */
  const renegotiateRef = useRef<(sessionId: string, target: PlayerWebrtcTarget) => Promise<void>>(
    async () => {},
  )

  const [state, setState] = useState<PlayerConnectionState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [isMuted, setIsMuted] = useState(initialMuted)
  /** Read by the async stream-swap closures: a freshly-promoted stream must
   *  arrive already respecting the CURRENT mute, not the one captured at
   *  connect time. */
  const isMutedRef = useRef(isMuted)
  isMutedRef.current = isMuted
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Picture-in-Picture is only offered when the platform supports it. Covers
  // both the standard API (`document.pictureInPictureEnabled`, Chromium/Firefox/
  // desktop Safari) and the iOS WebKit variant (`webkitSetPresentationMode` on
  // the <video>), since iOS Safari/Chrome lack the standard API. Detected after
  // mount so `videoRef` is populated.
  const [isPipSupported, setIsPipSupported] = useState(false)
  // Toolbar starts VISIBLE everywhere — touch detection (matchMedia /
  // maxTouchPoints) proved unreliable across devices and left the controls
  // stuck at opacity-0 (in the DOM but invisible) when it mis-reported. On
  // pointer devices it still auto-hides after 3s of inactivity (and re-shows
  // on hover); on touch it stays until tapped. Visible-by-default guarantees
  // the controls are reachable regardless of detection.
  const isTouch = isTouchDevice()
  const [showToolbar, setShowToolbar] = useState(true)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mode is sticky-once-set: as soon as the parent supplies any of
  // the server-offer signaling callbacks we lock into server-offer
  // mode for the lifetime of the player. We bias toward "server-
  // offer intended" — `sendAnswer` is enough on its own because the
  // parent only wires it up when there's a server signaling channel.
  // `createSession` may briefly be `undefined` while
  // `useDeviceWebrtc.streams` is hydrating; we still need to know
  // we're in server-offer mode so we DON'T fall back to WHEP and
  // trigger a `/api/webrtc 404` on a backend that doesn't speak
  // WHEP. The `connectServerOffer` body itself early-returns when
  // `createSession` isn't ready yet, and the retrigger useEffect
  // below kicks the connection once the callback shows up.
  const serverOfferModeRef = useRef(false)
  if (sendAnswer || createSession) serverOfferModeRef.current = true
  const useServerOffer = serverOfferModeRef.current

  // Client-offer mode is sticky-once-set and takes PRECEDENCE over server-
  // offer: when the parent wires `handleOffer` we lock into the
  // capability-driven path (browser offers its decode caps, server answers
  // → native passthrough incl. iOS H.264 High). Same hydration story as
  // server-offer: `handleOffer` may briefly be undefined while the parent's
  // stream list loads, so the sticky flag keeps us off WHEP and the
  // retrigger effect kicks the handshake once the callback shows up.
  const clientOfferModeRef = useRef(false)
  if (handleOffer) clientOfferModeRef.current = true
  const useClientOffer = clientOfferModeRef.current

  // True once the stream has reached 'playing' at least once. After that, a
  // reconnect shows the RETAINED last stream frame (see capture below) as an
  // <img> instead of a black <video>, so the connecting/disconnected indicator
  // shrinks to a small corner spinner. Only the cold start (never played, no
  // poster) shows the full-cover loader.
  const [hasPlayed, setHasPlayed] = useState(false)

  // ── Last-frame retention (iOS WebKit black-frame fix) ──────────────────────
  // On iOS, WebKit does NOT freeze the last MediaStream frame when the track
  // ends on a reconnect — the <video> paints BLACK. So we capture the live
  // frame to a canvas every couple of seconds while playing, and on a drop we
  // promote the latest capture to a visible <img> overlay that stays up until
  // the new stream plays. `posterUrl` (a persisted server snapshot) is the
  // separate cold-start fallback used before any frame has ever decoded.
  const capturedFrameRef = useRef<string | null>(null)
  const [lastFrameUrl, setLastFrameUrl] = useState<string | null>(null)
  // True once the CURRENT (re)connected stream has presented its first real
  // frame. Gates hiding the retained still: we keep the still up from the drop
  // until the new stream actually paints — covering the gap between
  // ICE-connected and first-decoded-frame that otherwise flashes black.
  const [liveFrameReady, setLiveFrameReady] = useState(false)

  const captureFrame = useCallback((): void => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0)
      // Reject an all-black capture: on iOS WebKit, drawing a WebRTC <video> to a
      // canvas can silently yield a blank/black frame. Promoting that as the
      // retained still would defeat the whole mechanism — we'd "cover" the
      // reconnect gap WITH black. Skip it so the previous good capture (or the
      // posterUrl snapshot) stays the visible still instead.
      if (isCanvasEffectivelyBlack(ctx, canvas.width, canvas.height)) return
      capturedFrameRef.current = canvas.toDataURL('image/jpeg', 0.6)
    } catch {
      /* canvas tainted / decode not ready — keep the previous capture */
    }
  }, [])

  const updateState = useCallback(
    (s: PlayerConnectionState) => {
      setState(s)
      if (s === 'playing') setHasPlayed(true)
      onStateChange?.(s)
    },
    [onStateChange],
  )

  const cleanup = useCallback(() => {
    // Abort any in-flight connection attempt (prevents orphan sessions from StrictMode double-mount)
    connectAbortRef.current?.abort()
    connectAbortRef.current = null

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    // Stop the renegotiation poll loop and drop renegotiation state — the
    // old session is gone (full teardown / reconnect / streamKey change), so
    // the next connect starts a fresh epoch baseline.
    if (sessionPollTimerRef.current) {
      clearTimeout(sessionPollTimerRef.current)
      sessionPollTimerRef.current = null
    }
    activeSessionIdRef.current = null
    renegotiatingRef.current = false
    lastEpochRef.current = 0
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    // Close ALL sessions created by this player
    if (closeSession && sessionIdsRef.current.size > 0) {
      for (const sid of sessionIdsRef.current) {
        closeSession(sid).catch(() => {})
      }
      sessionIdsRef.current.clear()
    }
    // INTENTIONALLY do NOT clear `videoRef.srcObject` here: keeping the old
    // (now-ended) stream assigned leaves the LAST DECODED FRAME frozen on the
    // element through a reconnect, instead of flashing black. `ontrack` swaps in
    // the fresh stream once the new connection delivers media. (The element
    // unmounts on a real teardown, so nothing leaks.)
  }, [closeSession])

  // Seamless-reconnect teardown: abort any in-flight connect + clear timers and
  // renegotiation flags, but DO NOT touch the live PC, its sessions, or the
  // video srcObject — those stay until the new stream swaps in (make-before-
  // break). The non-destructive half of cleanup().
  const partialReconnectReset = useCallback(() => {
    connectAbortRef.current?.abort()
    connectAbortRef.current = null
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (sessionPollTimerRef.current) {
      clearTimeout(sessionPollTimerRef.current)
      sessionPollTimerRef.current = null
    }
    // Detach the adaptive-poll's active session so an already-in-flight
    // getSessionState tick can't pass its `activeSessionIdRef === sessionId`
    // guard and kick a spurious renegotiate() on the OLD session mid-reconnect.
    // The new connect re-arms the poll with the fresh sid.
    activeSessionIdRef.current = null
    renegotiatingRef.current = false
    lastEpochRef.current = 0
  }, [])

  // ── Adaptive re-offer poll ────────────────────────────────────────────────
  // Poll `getSessionState` for the active session. When the server reports a
  // `pendingRenegotiation` with an epoch we haven't acted on, kick a
  // transparent renegotiation (new PC, same sessionId, keep last frame). The
  // epoch makes us act AT MOST ONCE per pending change. No-op for non-adaptive
  // sessions (server always returns `null`) and when `getSessionState`/
  // `reoffer` aren't wired — so the steady-state path is unchanged.
  const SESSION_STATE_POLL_MS = 1_000
  const startSessionStatePoll = useCallback(
    (sessionId: string) => {
      if (!getSessionState || !reoffer) return
      if (sessionPollTimerRef.current) {
        clearTimeout(sessionPollTimerRef.current)
        sessionPollTimerRef.current = null
      }
      const tick = async (): Promise<void> => {
        if (!mountedRef.current) return
        // Stop if the session we were watching is no longer active.
        if (activeSessionIdRef.current !== sessionId) return
        if (!renegotiatingRef.current) {
          try {
            const { pendingRenegotiation } = await getSessionState(sessionId)
            if (
              mountedRef.current &&
              activeSessionIdRef.current === sessionId &&
              pendingRenegotiation &&
              pendingRenegotiation.epoch > lastEpochRef.current &&
              !renegotiatingRef.current
            ) {
              // Act at most once per epoch.
              lastEpochRef.current = pendingRenegotiation.epoch
              await renegotiateRef.current(sessionId, pendingRenegotiation.target)
              return // renegotiate() restarts the poll against the (new) session
            }
          } catch {
            /* transient — keep polling */
          }
        }
        if (!mountedRef.current || activeSessionIdRef.current !== sessionId) return
        sessionPollTimerRef.current = setTimeout(() => {
          void tick()
        }, SESSION_STATE_POLL_MS)
      }
      sessionPollTimerRef.current = setTimeout(() => {
        void tick()
      }, SESSION_STATE_POLL_MS)
    },
    [getSessionState, reoffer],
  )

  // ── Server-offer connection ──────────────────────────────────────────────

  const connectServerOffer = useCallback(
    async (seamless = false, withDownlink = seamless, knownDownlinkMbps?: number) => {
      if (!mountedRef.current || !createSession || !sendAnswer) return

      // Make-before-break (seamless): keep the OLD PC + its last decoded frame on
      // screen while the new connection is built; swap only when the new stream
      // presents media, then tear the old PC + sessions down. Non-seamless: tear
      // the old PC down up front (original behaviour — identical to before).
      const oldPc = seamless ? pcRef.current : null
      const oldSessions = seamless ? new Set(sessionIdsRef.current) : null
      if (seamless) {
        partialReconnectReset()
      } else {
        cleanup()
      }
      updateState('connecting')

      const abort = new AbortController()
      connectAbortRef.current = abort

      try {
        // Step 1: get server offer (with hints derived from the live player).
        // A probe-climb carries the measurement that TRIGGERED it — re-reading
        // the cache could hand the climb a different (lower) number than the
        // one that justified it.
        const autoHints = computeClientHints(containerRef.current)
        const downlinkMbps = withDownlink
          ? (knownDownlinkMbps ??
            (await measuredDownlinkMbps(serverUrl, probeAuthToken ?? null, reportProbeRefused)))
          : undefined
        const mergedHints = mergePlayerHints(autoHints, hintsOverride, downlinkMbps, !withDownlink)
        reportAdaptiveHints(
          withDownlink ? 'probe-climb' : 'cold-start',
          mergedHints,
          probeOriginFor(serverUrl),
        )
        const { sessionId, sdpOffer, iceServers } = await createSession(mergedHints)
        sessionIdsRef.current.add(sessionId)
        if (!mountedRef.current || abort.signal.aborted) {
          // Cleanup raced — close the just-created session immediately
          closeSession?.(sessionId).catch(() => {})
          sessionIdsRef.current.delete(sessionId)
          return
        }

        // Step 2: create peer connection. Prefer the server-supplied ICE servers
        // (STUN + TURN from the turn-provider cap) so the browser gathers a
        // reachable relay candidate over CGNAT/mobile; keep public STUN as a
        // fallback when the server returns none.
        //
        // DO NOT force `iceTransportPolicy: 'relay'`. werift's relay media-forward
        // is unreliable across two real TURN servers (relay↔relay connects but
        // media never arrives → connected-but-black). Forcing relay also defeats
        // the direct path on LAN / Tailscale, where a host↔host pair carries full
        // native quality with no relay. Keep TURN in `iceServers` as a fallback
        // candidate, but let ICE gather host/srflx/relay and nominate the best
        // reachable pair (direct when possible).
        const pc = new RTCPeerConnection(
          buildPeerConnectionConfig(iceServers, iceTransportPolicyRef.current),
        )
        onPeerConnectionRef.current?.(pc)
        if (!seamless) pcRef.current = pc

        // Collect all tracks and attach them to the video element.
        // The server sends video and audio in separate streams (different msid),
        // so we aggregate them into a single MediaStream for the video element.
        const combinedStream = new MediaStream()
        // Cold start: probe once THIS stream shows its first frame, then climb
        // (make-before-break) only if the measured downlink justifies it.
        if (!withDownlink) {
          void probeAfterThisStreamsFirstFrame({
            video: () => videoRef.current,
            stream: combinedStream,
            signal: abort.signal,
            serverUrl,
            authToken: probeAuthToken ?? null,
            onRefused: reportProbeRefused,
          }).then((mbps) => {
            if (mbps === undefined || !shouldUpgradeAfterProbe(mbps)) return
            if (!mountedRef.current || abort.signal.aborted) return
            if (probeUpgradeRef.current) return
            probeUpgradeRef.current = true
            void climbAfterProbe(sessionId, mbps, () => {
              if (!mountedRef.current || abort.signal.aborted) return
              void connectServerOffer(true, true, mbps)
            })
          })
        }

        // Promote the new PC and swap the <video> to its stream. In seamless mode
        // this is the ONLY moment the visible frame changes — the old PC's last
        // frame stays up until here; then the old PC + its sessions are torn down.
        let swappedIn = false
        const swapInOnce = () => {
          if (swappedIn || !mountedRef.current) return
          swappedIn = true
          pcRef.current = pc
          if (videoRef.current) {
            videoRef.current.srcObject = combinedStream
            applyStreamMute(videoRef.current, isMutedRef.current)
            videoRef.current.play().catch(() => {})
          }
          if (oldPc && oldPc !== pc) {
            try {
              oldPc.close()
            } catch {
              /* already closed */
            }
          }
          if (oldSessions) {
            for (const sid of oldSessions) {
              sessionIdsRef.current.delete(sid)
              closeSession?.(sid).catch(() => {})
            }
          }
        }

        pc.ontrack = (event) => {
          console.debug('[WebRTC] ontrack', event.track.kind, event.track.readyState)
          combinedStream.addTrack(event.track)
          if (seamless) {
            swapInOnce()
            return
          }
          if (videoRef.current) {
            videoRef.current.srcObject = combinedStream
            applyStreamMute(videoRef.current, isMutedRef.current)
            // Chrome won't auto-play a MediaStream that has no data yet.
            // Explicitly call play() each time a track arrives so the
            // element starts rendering as soon as RTP packets flow.
            videoRef.current.play().catch(() => {})
          }
        }

        pc.oniceconnectionstatechange = () => {
          if (!mountedRef.current) return
          const iceState = pc.iceConnectionState
          console.debug('[WebRTC] ICE state:', iceState)
          if (iceState === 'connected' || iceState === 'completed') {
            reconnectAttemptsRef.current = 0
            if (seamless) swapInOnce()
            updateState('playing')
            // Ensure the video is actually playing — autoplay alone is
            // insufficient when the MediaStream had no data at attach time.
            if (videoRef.current?.paused) {
              console.debug('[WebRTC] video was paused at ICE connected — calling play()')
              videoRef.current.play().catch(() => {})
            }
          } else if (
            iceState === 'failed' ||
            iceState === 'disconnected' ||
            iceState === 'closed'
          ) {
            // Seamless + not-yet-swapped: the NEW pc died while the old frame is
            // still showing. It isn't pcRef yet, so the reconnect's cleanup won't
            // reach it — close the orphan here, then fall through to a hard
            // reconnect (which keeps the retained still up via F2).
            if (seamless && !swappedIn) {
              try {
                pc.close()
              } catch {
                /* already closed */
              }
            }
            updateState('disconnected')
            scheduleReconnect()
          }
        }

        pc.onicecandidateerror = (event) => {
          console.debug('[WebRTC] ICE candidate error:', event)
        }

        // Step 3: set remote description (server offer) and create answer
        console.debug('[WebRTC] Setting remote description (server offer)...')
        await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer })
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        console.debug('[WebRTC] Local description set, waiting for ICE gathering...')

        // Wait for ICE gathering
        await waitForIceGathering(pc)
        if (!mountedRef.current) return

        const localCandidates = (pc.localDescription?.sdp ?? '')
          .split('\n')
          .filter((l) => l.startsWith('a=candidate:')).length
        console.debug('[WebRTC] Sending answer to server', {
          localCandidates,
          sessionId: sessionId.slice(0, 8),
        })

        // Step 4: send answer to server
        await sendAnswer(sessionId, pc.localDescription?.sdp ?? '')
        console.debug('[WebRTC] Answer sent successfully')

        // Step 5: Monitor actual media flow (diagnostic — remove after stabilisation)
        const savedPc = pc
        const checkMedia = () => {
          const connState = savedPc.connectionState
          if (connState === 'closed' || connState === 'failed') return
          const videoEl = videoRef.current
          if (videoEl && videoEl.readyState === 0) {
            console.log(`[WebRTC] no video data yet (ice=${savedPc.iceConnectionState})`)
          }
        }
        setTimeout(checkMedia, 3000)
        setTimeout(checkMedia, 8000)
      } catch (err) {
        if (!mountedRef.current) return
        const msg = err instanceof Error ? err.message : String(err)
        setErrorMessage(msg)
        updateState('error')
        onError?.(msg)
        scheduleReconnect()
      }
    },
    [
      serverUrl,
      streamKey,
      createSession,
      sendAnswer,
      cleanup,
      partialReconnectReset,
      closeSession,
      updateState,
      onError,
      hintsOverride,
      reportAdaptiveHints,
      probeAuthToken,
      reportProbeRefused,
      climbAfterProbe,
    ],
  )

  // ── WHEP connection (legacy fallback) ────────────────────────────────────

  const connectWhep = useCallback(async () => {
    if (!mountedRef.current) return

    cleanup()
    updateState('connecting')

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      })
      pcRef.current = pc

      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })

      const whepStream = new MediaStream()

      pc.ontrack = (event) => {
        whepStream.addTrack(event.track)
        if (videoRef.current) {
          videoRef.current.srcObject = whepStream
          applyStreamMute(videoRef.current, isMutedRef.current)
          videoRef.current.play().catch(() => {})
        }
      }

      pc.oniceconnectionstatechange = () => {
        if (!mountedRef.current) return
        const iceState = pc.iceConnectionState
        if (iceState === 'connected' || iceState === 'completed') {
          reconnectAttemptsRef.current = 0
          updateState('playing')
          if (videoRef.current?.paused) {
            videoRef.current.play().catch(() => {})
          }
        } else if (iceState === 'failed' || iceState === 'disconnected' || iceState === 'closed') {
          updateState('disconnected')
          scheduleReconnect()
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGathering(pc)
      if (!mountedRef.current) return

      const whepUrl = `${serverUrl}/api/webrtc?src=${encodeURIComponent(streamKey)}`
      const response = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription?.sdp ?? '',
      })

      if (!response.ok) {
        throw new Error(`WHEP ${response.status}: ${response.statusText}`)
      }

      const answerSdp = await response.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      updateState('error')
      onError?.(msg)
      scheduleReconnect()
    }
  }, [serverUrl, streamKey, cleanup, updateState, onError])

  // ── Client-offer connection (capability-driven passthrough) ───────────────
  // The dual of connectServerOffer: the BROWSER creates the offer so it
  // advertises its own decode capabilities (incl. H.264 High on iOS 18),
  // and the server answers by echoing the matching codec → the camera's
  // native bytes pass through with no transcode. Signals over tRPC
  // (`handleOffer`), NOT the WHEP HTTP endpoint.
  const connectClientOffer = useCallback(
    async (seamless = false, withDownlink = seamless, knownDownlinkMbps?: number) => {
      if (!mountedRef.current || !handleOffer) return

      // Make-before-break (seamless): keep the OLD PC + last frame on screen,
      // swap only when the new stream presents media. See connectServerOffer.
      const oldPc = seamless ? pcRef.current : null
      const oldSessions = seamless ? new Set(sessionIdsRef.current) : null
      if (seamless) {
        partialReconnectReset()
      } else {
        cleanup()
      }
      updateState('connecting')

      const abort = new AbortController()
      connectAbortRef.current = abort

      // Startup-latency instrumentation. Each phase records ms-since-start so a
      // slow cold start is attributable to a concrete phase (ICE-server fetch,
      // offer build, server signaling RTT, ICE connect, first media) rather
      // than guessed. One structured `[WebRTC timing]` line per session; low
      // volume (once per connect). Read it in the browser console.
      const t0 = performance.now()
      const ms = (): number => Math.round(performance.now() - t0)
      const timing: Record<string, number> = {}

      try {
        // ICE servers must be on the PC BEFORE createOffer so the offer
        // carries a relay candidate for remote/CGNAT viewers. Best-effort:
        // fall back to public STUN. (Server-offer gets these back from
        // createSession; client-offer must fetch them up front.)
        const iceServers = await getIceServers?.()
        timing.iceServersMs = ms()
        if (!mountedRef.current || abort.signal.aborted) return

        const pc = new RTCPeerConnection(
          buildPeerConnectionConfig(iceServers, iceTransportPolicyRef.current),
        )
        onPeerConnectionRef.current?.(pc)
        if (!seamless) pcRef.current = pc

        const combinedStream = new MediaStream()
        /** This connect's server session — known once `handleOffer` answers,
         *  which is before the first frame the probe waits for. */
        let probeSessionId: string | null = null
        // Cold start: probe once THIS stream shows its first frame — never
        // during ICE/offer/handleOffer — then climb only if it justifies it.
        if (!withDownlink) {
          void probeAfterThisStreamsFirstFrame({
            video: () => videoRef.current,
            stream: combinedStream,
            signal: abort.signal,
            serverUrl,
            authToken: probeAuthToken ?? null,
            onRefused: reportProbeRefused,
          }).then((mbps) => {
            if (mbps === undefined || !shouldUpgradeAfterProbe(mbps)) return
            if (!mountedRef.current || abort.signal.aborted) return
            if (probeUpgradeRef.current) return
            probeUpgradeRef.current = true
            void climbAfterProbe(probeSessionId, mbps, () => {
              if (!mountedRef.current || abort.signal.aborted) return
              void connectClientOffer(true, true, mbps)
            })
          })
        }

        let swappedIn = false
        const swapInOnce = () => {
          if (swappedIn || !mountedRef.current) return
          swappedIn = true
          pcRef.current = pc
          if (videoRef.current) {
            videoRef.current.srcObject = combinedStream
            applyStreamMute(videoRef.current, isMutedRef.current)
            videoRef.current.play().catch(() => {})
          }
          if (oldPc && oldPc !== pc) {
            try {
              oldPc.close()
            } catch {
              /* already closed */
            }
          }
          if (oldSessions) {
            for (const sid of oldSessions) {
              sessionIdsRef.current.delete(sid)
              closeSession?.(sid).catch(() => {})
            }
          }
        }

        pc.ontrack = (event) => {
          if (timing.firstTrackMs === undefined) timing.firstTrackMs = ms()
          console.debug('[WebRTC] ontrack (client-offer)', event.track.kind, event.track.readyState)
          combinedStream.addTrack(event.track)
          if (seamless) {
            swapInOnce()
            return
          }
          if (videoRef.current) {
            videoRef.current.srcObject = combinedStream
            applyStreamMute(videoRef.current, isMutedRef.current)
            videoRef.current.play().catch(() => {})
          }
        }

        let timingLogged = false
        pc.oniceconnectionstatechange = () => {
          if (!mountedRef.current) return
          const iceState = pc.iceConnectionState
          console.debug('[WebRTC] ICE state (client-offer):', iceState)
          if (iceState === 'connected' || iceState === 'completed') {
            if (!timingLogged) {
              timingLogged = true
              timing.iceConnectedMs = ms()
              // Phase breakdown of the cold-start latency (all ms-since-connect-start):
              //  iceServersMs   — fetching TURN/STUN creds before building the offer
              //  offerCreatedMs — createOffer done
              //  localSetMs     — setLocalDescription done
              //  signalingRttMs — server offer→answer round-trip (large ⇒ server blocked,
              //                   e.g. cold RTSP dial + first-IDR wait — NOT the network)
              //  answerSetMs    — setRemoteDescription done
              //  iceConnectedMs — ICE reached connected (answerSetMs→here = ICE time)
              //  firstTrackMs   — first media track arrived
              console.info('[WebRTC timing] client-offer connected', { streamKey, ...timing })
              onConnectTiming?.({ ...timing })
              // First DECODED frame (not just first RTP track): discriminates
              // "media arrived but nothing decodes until the next IDR" (e.g. a
              // lossy pre-buffer GOP replay) from a genuinely late track.
              const v = videoRef.current
              if (v && 'requestVideoFrameCallback' in v) {
                ;(
                  v as HTMLVideoElement & {
                    requestVideoFrameCallback: (cb: () => void) => void
                  }
                ).requestVideoFrameCallback(() => {
                  timing.firstFrameMs = ms()
                  console.info('[WebRTC timing] first decoded frame', {
                    streamKey,
                    firstFrameMs: timing.firstFrameMs,
                  })
                  onConnectTiming?.({ ...timing })
                })
                // Make the "connected but nothing decodes" failure VISIBLE
                // rather than a merely-absent line: if no frame has decoded
                // FIRST_FRAME_TIMEOUT_MS after ICE connected, emit an explicit
                // stall log. This is the adaptive-remote-never-loads signature —
                // ICE/DTLS up, track present, but an oversized keyframe never
                // reassembles over the lossy remote link so `firstFrameMs`
                // never arrives.
                setTimeout(() => {
                  if (!mountedRef.current) return
                  if (timing.firstFrameMs !== undefined) return
                  console.warn('[WebRTC timing] NO decoded frame (stalled)', {
                    streamKey,
                    sinceIceConnectedMs: ms() - (timing.iceConnectedMs ?? 0),
                    iceConnectedMs: timing.iceConnectedMs,
                    firstTrackMs: timing.firstTrackMs,
                  })
                  // A connected session that never decodes is a FAILURE, not a
                  // diagnostic: feed the same error state every other failure
                  // uses (host renders it on its transport bar) and let the
                  // auto-retry rebuild the session — the log line alone left
                  // the player showing "playing" over a frozen/black surface.
                  // The client-side twin of the server's answered-but-silent
                  // watchdog.
                  reportHardErrorRef.current('no decoded frame after connect')
                  scheduleReconnect()
                }, FIRST_FRAME_TIMEOUT_MS)
              }
            }
            reconnectAttemptsRef.current = 0
            if (seamless) swapInOnce()
            updateState('playing')
            if (videoRef.current?.paused) videoRef.current.play().catch(() => {})
          } else if (
            iceState === 'failed' ||
            iceState === 'disconnected' ||
            iceState === 'closed'
          ) {
            // Seamless + not-yet-swapped: close the orphan new pc (not pcRef yet),
            // then hard-reconnect (keeps the retained still up via F2).
            if (seamless && !swappedIn) {
              try {
                pc.close()
              } catch {
                /* already closed */
              }
            }
            updateState('disconnected')
            scheduleReconnect()
          }
        }

        // Trickle ICE (~0s connect): send the offer IMMEDIATELY
        // — do NOT wait for ICE gathering. The browser gathers in the background;
        // each local candidate is pushed to the server via `addIceCandidate`, and
        // the server's candidates are polled via `getIceCandidates` and added
        // here. Buffer local candidates gathered before the sessionId is known
        // (createOffer starts gathering before handleOffer returns).
        let sessionId: string | null = null
        const pendingLocal: RTCIceCandidateInit[] = []
        pc.onicecandidate = (e) => {
          if (!e.candidate) return
          const json = e.candidate.toJSON()
          if (sessionId && addIceCandidate) addIceCandidate(sessionId, json).catch(() => {})
          else pendingLocal.push(json)
        }

        // recvonly transceivers so the OFFER advertises the browser's full
        // native decode caps (incl. H.264 High on iOS 18); the server picks the
        // matching codec and forwards native bytes.
        pc.addTransceiver('video', { direction: 'recvonly' })
        pc.addTransceiver('audio', { direction: 'recvonly' })

        // Control data channel (recorded-playback timeline). Created BEFORE the
        // offer so the m=application section is negotiated into this session; the
        // server's `TimelineSession` picks it up via `ondatachannel`. No-op when
        // no `onControlChannel` consumer is wired (plain live player).
        if (onControlChannelRef.current) {
          const control = pc.createDataChannel('camstack-control')
          onControlChannelRef.current(control)
        }

        const offer = await pc.createOffer()
        timing.offerCreatedMs = ms()
        await pc.setLocalDescription(offer)
        timing.localSetMs = ms()
        if (!mountedRef.current || abort.signal.aborted) return

        // Bare offer goes out now (no gather wait) — candidates trickle after.
        // Client hints (viewport, downlink) go WITH the offer. Cold start omits
        // downlink so the broker lands on the lowest rung; a probe then climbs
        // through mid/high. A seamless reconnect carries the measured downlink.
        const downlinkMbps = withDownlink
          ? (knownDownlinkMbps ??
            (await measuredDownlinkMbps(serverUrl, probeAuthToken ?? null, reportProbeRefused)))
          : undefined
        const clientOfferHints = mergePlayerHints(
          computeClientHints(containerRef.current),
          hintsOverride,
          downlinkMbps,
          !withDownlink,
        )
        reportAdaptiveHints(
          withDownlink ? 'probe-climb' : 'cold-start',
          clientOfferHints,
          probeOriginFor(serverUrl),
        )
        const signalingStart = ms()
        const { sessionId: sid, sdpAnswer } = await handleOffer(
          pc.localDescription?.sdp ?? offer.sdp ?? '',
          undefined,
          clientOfferHints,
        )
        // Server offer→answer round-trip: a large value here means the server
        // blocked (e.g. cold RTSP dial + first-IDR wait), not the network/ICE.
        timing.signalingRttMs = ms() - signalingStart
        sessionId = sid
        probeSessionId = sid
        sessionIdsRef.current.add(sid)
        // This session is now the one the renegotiation poll watches.
        activeSessionIdRef.current = sid
        if (!mountedRef.current || abort.signal.aborted) {
          closeSession?.(sid).catch(() => {})
          sessionIdsRef.current.delete(sid)
          return
        }

        // Flush local candidates gathered before we knew the sessionId.
        if (addIceCandidate) for (const c of pendingLocal) addIceCandidate(sid, c).catch(() => {})
        pendingLocal.length = 0

        await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer })
        timing.answerSetMs = ms()
        console.debug('[WebRTC] Client-offer answer set (trickle)', { sessionId: sid.slice(0, 8) })

        // Poll the server's trickled candidates and add them until gathering is
        // done, the connection is up, or a budget elapses.
        if (getIceCandidates) {
          const seen = new Set<string>()
          const started = Date.now()
          const pollOnce = async (): Promise<void> => {
            // Stop once this pc is gone. We CANNOT key on `pcRef.current === pc`
            // here: in a seamless reconnect `pcRef` is not promoted to this pc
            // until the swap, so the candidate poll must keep running through the
            // pre-swap window (otherwise the new pc never gets the server's
            // trickled candidates and fails on TURN — defeating seamless). A
            // superseded pc is always closed via cleanup(), so closed-state is the
            // reliable stop signal (mirrors renegotiate's poll).
            if (!mountedRef.current || abort.signal.aborted) return
            if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return
            try {
              const { candidates, done } = await getIceCandidates(sid)
              for (const c of candidates) {
                const key = c.candidate ?? ''
                if (key && !seen.has(key)) {
                  seen.add(key)
                  pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
                }
              }
              const ice = pc.iceConnectionState
              if (
                done ||
                Date.now() - started > 10_000 ||
                ice === 'connected' ||
                ice === 'completed'
              )
                return
            } catch {
              /* transient — keep polling */
            }
            setTimeout(() => {
              void pollOnce()
            }, 200)
          }
          void pollOnce()
        }

        // Start the adaptive re-offer poll for this session. Only meaningful
        // in client-offer mode (the re-offer uses `reoffer`/`handleOffer`).
        startSessionStatePoll(sid)
      } catch (err) {
        if (!mountedRef.current) return
        const msg = err instanceof Error ? err.message : String(err)
        setErrorMessage(msg)
        updateState('error')
        onError?.(msg)
        scheduleReconnect()
      }
    },
    [
      serverUrl,
      handleOffer,
      getIceServers,
      addIceCandidate,
      getIceCandidates,
      closeSession,
      cleanup,
      partialReconnectReset,
      updateState,
      onError,
      startSessionStatePoll,
      hintsOverride,
      reportAdaptiveHints,
      probeAuthToken,
      reportProbeRefused,
      climbAfterProbe,
    ],
  )

  // ── Adaptive re-offer (transparent tier switch) ───────────────────────────
  // Build a NEW PeerConnection for the SAME sessionId against the server-
  // chosen downgrade `target`, KEEPING the old PC + its last decoded frame
  // on screen. Only when the new PC delivers media do we swap the <video>'s
  // srcObject to the new stream and close the old PC — so the switch is
  // seamless (no loader, no black flash). The server closes the stale session
  // and creates a fresh one under the same id when it receives the re-offer.
  const renegotiate = useCallback(
    async (sessionId: string, target: PlayerWebrtcTarget): Promise<void> => {
      const reofferFn = reoffer
      if (!mountedRef.current || !reofferFn) return
      const oldPc = pcRef.current
      renegotiatingRef.current = true
      try {
        const iceServers = await getIceServers?.()
        if (!mountedRef.current) return

        const pc = new RTCPeerConnection(
          buildPeerConnectionConfig(iceServers, iceTransportPolicyRef.current),
        )
        onPeerConnectionRef.current?.(pc)

        const newStream = new MediaStream()
        let swappedIn = false

        // ── First-decoded-frame gating for the visible swap ──────────────────
        // A tier switch is a full close-and-recreate of the server peer, so the
        // NEW PC always has a keyframe-wait window with NO decoded frame yet.
        // Swapping `videoRef.srcObject` to it on track-arrival / ICE-connected
        // (as this path used to) blanks the visible element to BLACK until the
        // new stream's first keyframe decodes — and the `liveFrameReady` still-
        // guard never re-arms because `state` stays 'playing' across the switch
        // (that effect keys on `[state]` only). Fix: warm the incoming stream on
        // a HIDDEN <video> and only promote it into the visible element once it
        // has actually DECODED its first frame. The old PC's live frame stays on
        // screen until that instant → make-before-break, no black gap.
        let warmupStarted = false
        let warmupVideo: HTMLVideoElement | null = null
        let warmupRvfc: number | undefined
        let warmupSafety: ReturnType<typeof setTimeout> | undefined
        const teardownWarmup = () => {
          if (warmupSafety !== undefined) {
            clearTimeout(warmupSafety)
            warmupSafety = undefined
          }
          const v = warmupVideo
          warmupVideo = null
          if (!v) return
          if (warmupRvfc !== undefined && typeof v.cancelVideoFrameCallback === 'function') {
            v.cancelVideoFrameCallback(warmupRvfc)
          }
          v.removeEventListener('loadeddata', commitSwap)
          // Detach the stream from the throwaway element and remove it from the
          // DOM. The MediaStream/tracks live on — they are still owned by `pc`
          // (and, once swapped, by the visible element).
          try {
            v.srcObject = null
          } catch {
            /* older engines throw on null assignment — safe to ignore */
          }
          v.remove()
        }

        // Perform the actual visible swap + old-PC teardown. Idempotent.
        function commitSwap(): void {
          if (swappedIn || !mountedRef.current) {
            teardownWarmup()
            return
          }
          swappedIn = true
          // Promote the new PC to the active one and swap the video over — this
          // is the only moment the visible frame changes. The old PC's last
          // frame stayed on screen until right now, and the incoming stream has
          // already decoded a frame on the warm-up element, so the visible
          // element presents new pixels immediately (no black).
          pcRef.current = pc
          if (videoRef.current) {
            videoRef.current.srcObject = newStream
            videoRef.current.play().catch(() => {})
          }
          // Old PC is now redundant — tear it down (keeps its server session
          // around; the re-offer reused the SAME sessionId, so closing here
          // would kill the live session — only close the PC object).
          if (oldPc && oldPc !== pc) oldPc.close()
          teardownWarmup()
        }

        // Begin warming the new stream (idempotent). Attaches it to a 1×1
        // near-invisible (but NOT display:none — that halts decoding) <video>
        // and waits for its first decoded frame before committing the swap.
        const armSwap = () => {
          if (warmupStarted || swappedIn || !mountedRef.current) return
          warmupStarted = true
          if (typeof document === 'undefined') {
            // Non-DOM environment (SSR / tests): no warm-up element possible —
            // fall back to the original immediate swap so we never stall.
            commitSwap()
            return
          }
          const v = document.createElement('video')
          v.muted = true
          v.playsInline = true
          v.autoplay = true
          // Kept in the DOM (decoding is suspended for display:none / detached
          // elements on some engines) but visually inert.
          v.style.cssText =
            'position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;'
          v.srcObject = newStream
          warmupVideo = v
          ;(containerRef.current ?? document.body).appendChild(v)
          v.play().catch(() => {})

          // Primary signal: first DECODED frame. Fires only once real pixels are
          // ready — exactly the moment it's safe to show the new stream.
          if (typeof v.requestVideoFrameCallback === 'function') {
            warmupRvfc = v.requestVideoFrameCallback(() => commitSwap())
          }
          // Fallback for engines without a reliable rVFC (some WebKit builds):
          // `loadeddata` fires once the first frame's data is available.
          v.addEventListener('loadeddata', commitSwap, { once: true })
          // Safety timeout: if NEITHER signal fires (rVFC unsupported AND
          // loadeddata missed, or a stalled stream) swap anyway so we never get
          // permanently stuck on the frozen old frame. ~1.8s ≫ a healthy first
          // frame yet short enough that a genuinely stalled switch still recovers
          // via the visible element + reconnect path.
          warmupSafety = setTimeout(() => commitSwap(), 1_800)
        }

        pc.ontrack = (event) => {
          console.debug('[WebRTC] ontrack (reoffer)', event.track.kind, event.track.readyState)
          newStream.addTrack(event.track)
          // Media is flowing on the fresh connection — start warming it. The
          // visible swap is deferred to the first DECODED frame (see armSwap).
          armSwap()
        }

        pc.oniceconnectionstatechange = () => {
          if (!mountedRef.current) return
          const iceState = pc.iceConnectionState
          console.debug('[WebRTC] ICE state (reoffer):', iceState)
          if (iceState === 'connected' || iceState === 'completed') {
            reconnectAttemptsRef.current = 0
            // Begin warming the new stream (the visible swap still waits for its
            // first decoded frame — see armSwap). `ontrack` usually fires first;
            // this covers the case where ICE completes before a track event.
            armSwap()
            updateState('playing')
            if (videoRef.current?.paused) videoRef.current.play().catch(() => {})
          } else if (iceState === 'failed' || iceState === 'closed') {
            // The new PC failed. Whether or not we swapped it in, the OLD PC is
            // also dead server-side (the re-offer reused the sessionId, so the
            // server already closed the stale session). Keep the last frame on
            // screen (don't blank) but schedule a full reconnect to recover.
            // Drop any pending warm-up (its timers/element are now orphaned).
            teardownWarmup()
            // If we never swapped in, the new pc isn't `pcRef.current`, so
            // `cleanup()` in the reconnect won't reach it — close it here.
            if (!swappedIn && iceState === 'failed') pc.close()
            updateState('disconnected')
            scheduleReconnect()
          }
        }

        let pendingSid: string | null = null
        const pendingLocal: RTCIceCandidateInit[] = []
        pc.onicecandidate = (e) => {
          if (!e.candidate) return
          const json = e.candidate.toJSON()
          if (pendingSid && addIceCandidate) addIceCandidate(pendingSid, json).catch(() => {})
          else pendingLocal.push(json)
        }

        pc.addTransceiver('video', { direction: 'recvonly' })
        pc.addTransceiver('audio', { direction: 'recvonly' })

        // Re-create the recorded-playback control channel on the renegotiated PC
        // (an adaptive tier switch builds a fresh PC). Without this, the m=application
        // section would be missing from the new offer and timeline control would drop
        // after a downgrade. Guarded → live-only consumers are unaffected.
        if (onControlChannelRef.current) {
          const control = pc.createDataChannel('camstack-control')
          onControlChannelRef.current(control)
        }

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        if (!mountedRef.current) {
          pc.close()
          return
        }

        // Re-offer on the SAME sessionId + the new target. Server replaces the
        // session under that id (closes the stale server peer, builds a fresh one).
        // Carry the same client hints as the initial offer — harmless on a
        // downgrade re-offer (the server's controller-chosen tier intent wins
        // over any hint), and keeps the surface consistent for a later upgrade.
        const downlinkMbps = cachedDownlinkMbps(serverUrl)
        const reofferHints: ClientStreamHints = {
          ...computeClientHints(containerRef.current),
          ...(downlinkMbps !== undefined ? { downlinkMbps } : {}),
          ...hintsOverride,
        }
        reportAdaptiveHints('renegotiate', reofferHints, probeOriginFor(serverUrl))
        const { sessionId: sid, sdpAnswer } = await reofferFn(
          sessionId,
          pc.localDescription?.sdp ?? offer.sdp ?? '',
          target,
          reofferHints,
        )
        if (!mountedRef.current) {
          pc.close()
          return
        }
        pendingSid = sid
        sessionIdsRef.current.add(sid)
        activeSessionIdRef.current = sid

        if (addIceCandidate) for (const c of pendingLocal) addIceCandidate(sid, c).catch(() => {})
        pendingLocal.length = 0

        await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer })

        if (getIceCandidates) {
          const seen = new Set<string>()
          const started = Date.now()
          const pollOnce = async (): Promise<void> => {
            // Stop once this PC is no longer in play: either it was promoted and
            // later torn down, or the re-offer failed pre-swap and we reverted
            // to the old PC. While building (pre-swap) `pcRef.current` is still
            // the OLD pc, so we must also keep polling until the new pc fails.
            if (!mountedRef.current) return
            if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return
            try {
              const { candidates, done } = await getIceCandidates(sid)
              for (const c of candidates) {
                const key = c.candidate ?? ''
                if (key && !seen.has(key)) {
                  seen.add(key)
                  pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
                }
              }
              const ice = pc.iceConnectionState
              if (
                done ||
                Date.now() - started > 10_000 ||
                ice === 'connected' ||
                ice === 'completed'
              )
                return
            } catch {
              /* transient — keep polling */
            }
            setTimeout(() => {
              void pollOnce()
            }, 200)
          }
          void pollOnce()
        }

        // Resume the session-state poll against the (possibly new) sessionId so
        // a further downgrade is picked up.
        startSessionStatePoll(sid)
      } catch (err) {
        console.debug(
          '[WebRTC] reoffer failed; keeping last frame, re-arming poll',
          err instanceof Error ? err.message : String(err),
        )
        // Keep the old PC/frame and re-arm the poll so a later epoch can retry
        // the renegotiation. The old sessionId is still the live one server-side
        // (the new PC never completed its re-offer).
        startSessionStatePoll(sessionId)
      } finally {
        renegotiatingRef.current = false
      }
      // `scheduleReconnect` is intentionally omitted from deps (it's a stable
      // `[]`-dep callback referenced after its declaration line — listing it
      // here would read it during render before its `const` is initialized,
      // hitting the TDZ; the existing connect callbacks omit it for the same
      // reason).
    },
    [
      serverUrl,
      reoffer,
      getIceServers,
      addIceCandidate,
      getIceCandidates,
      updateState,
      startSessionStatePoll,
      hintsOverride,
      reportAdaptiveHints,
    ],
  )
  renegotiateRef.current = renegotiate

  // ── Shared logic ─────────────────────────────────────────────────────────

  const connect = useClientOffer
    ? connectClientOffer
    : useServerOffer
      ? connectServerOffer
      : connectWhep

  // Stash the latest `connect` in a ref. The setTimeout body inside
  // `scheduleReconnect` would otherwise capture whatever `connect` was
  // at the time `scheduleReconnect` was last memoized — and on the
  // very first render (before sticky server-offer mode is set or
  // `createSession` is supplied) that's `connectWhep`. Once the loop
  // is wedged on the WHEP path each retry re-arms a setTimeout that
  // STILL holds the old `connect`, so the 404 retries every
  // `RECONNECT_DELAY_MS` forever despite the sticky flag. Reading
  // through a ref breaks the closure capture without having to
  // memoize away the conditional.
  const connectRef = useRef<() => Promise<void> | void>(() => {})
  // Attempt/exhaustion reporting must be reachable from the MOUNT-STABLE
  // `scheduleReconnect` closure (empty deps by contract — see the comment on
  // its `connectRef` read). Route the mutable pieces through refs, refreshed
  // every render.
  const onReconnectAttemptRef = useRef(onReconnectAttempt)
  onReconnectAttemptRef.current = onReconnectAttempt
  const reportHardErrorRef = useRef<(msg: string) => void>(() => {})
  reportHardErrorRef.current = (msg: string) => {
    console.warn('[WebRTC] hard error', { streamKey, msg })
    setErrorMessage(msg)
    onError?.(msg)
    updateState('error')
  }
  connectRef.current = connect

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return
    const attempt = reconnectAttemptsRef.current
    // Pure decision (backoff shape + exhaustion pinned by tests); this layer
    // only executes it. Reading `connect` through `connectRef` avoids the
    // stale-closure WHEP trap documented above.
    const action = nextReconnectAction(attempt)
    // Every attempt (and the exhaustion edge) is observable: the host wires
    // this to its log pipeline, tagged with the camera. A retry loop nobody
    // can see is how a camera stays dark while looking busy.
    onReconnectAttemptRef.current?.(action)
    if (action.kind === 'exhausted') {
      // The old inline version returned silently here — the loop just
      // stopped and the surface stayed on whatever state it last had. The
      // exhaustion is now a hard, visible error the host can render (and
      // whose manual retry resets the budget via handleReconnect).
      reportHardErrorRef.current(`reconnect attempts exhausted (${action.attempts})`)
      return
    }
    reconnectAttemptsRef.current += 1
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) void connectRef.current()
    }, action.delayMs)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + stable setters
  }, [])

  // Mount-once: connect and tear down at unmount ONLY. `serverUrl`/`streamKey`
  // changes are handled by the dedicated switch effect below (seamless
  // make-before-break) instead of the historical cleanup+cold-connect — a
  // profile switch keeps the old frame on screen until the new tier paints.
  useEffect(() => {
    mountedRef.current = true
    reconnectAttemptsRef.current = 0
    if (autoPlay) connect()
    return () => {
      mountedRef.current = false
      cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, [])

  // Retrigger the initial connection once `createSession` resolves —
  // when the parent's `useDeviceWebrtc` is still hydrating its stream
  // list, `createSession` arrives `undefined`, our sticky mode flag
  // already locked in server-offer (so we don't fall back to WHEP),
  // but the early-return inside `connectServerOffer` skipped the
  // first attempt. As soon as the parent supplies the real callbacks,
  // kick off the handshake.
  const hasSignaledRef = useRef(false)
  useEffect(() => {
    if (!autoPlay) return
    // Wait for the callbacks of the active mode to hydrate before firing.
    if (useClientOffer) {
      if (!handleOffer) return
    } else if (useServerOffer) {
      if (!createSession || !sendAnswer) return
    } else {
      return
    }
    if (hasSignaledRef.current) return
    if (pcRef.current) return // already connected
    hasSignaledRef.current = true
    connect()
  }, [autoPlay, useClientOffer, useServerOffer, handleOffer, createSession, sendAnswer, connect])

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleReconnect = () => {
    reconnectAttemptsRef.current = 0
    connect()
  }

  // Host-driven reconnect: make-before-break when there's a live PC and the
  // active mode supports it (server/client offer) — the old frame stays on
  // screen until the new stream paints, so a network-change reconnect never
  // flashes black. Falls back to a hard reconnect (cold start, or WHEP).
  const handleSeamlessReconnect = () => {
    reconnectAttemptsRef.current = 0
    if (pcRef.current && useClientOffer) {
      void connectClientOffer(true)
      return
    }
    if (pcRef.current && useServerOffer) {
      void connectServerOffer(true)
      return
    }
    connect()
  }

  // Host-driven fast reconnect: when the parent bumps `reconnectSignal` (e.g.
  // the embed reacting to a NetInfo connectivity change or a foreground
  // resume), tear down and reconnect WITHOUT remounting. `cleanup()` keeps the
  // last decoded frame on the <video>, so the reconnect is seamless. The
  // initial value is skipped — only subsequent changes fire — so mounting with
  // a non-zero signal doesn't double-connect alongside the autoPlay effect.
  // Stream/profile SWITCH: a changed `streamKey` re-points this SAME player
  // instance. With a live PC this goes make-before-break — the parent's
  // signaling closures already carry the new target, so the old tier's last
  // frame stays on screen until the new tier presents media (no remount, no
  // black flash, no re-paid ICE-server fetch thanks to the TURN cache). A
  // changed `serverUrl` is a different hub — hard teardown + cold connect.
  const prevServerUrlRef = useRef(serverUrl)
  const prevStreamKeyRef = useRef(streamKey)
  useEffect(() => {
    const serverChanged = prevServerUrlRef.current !== serverUrl
    const keyChanged = prevStreamKeyRef.current !== streamKey
    prevServerUrlRef.current = serverUrl
    prevStreamKeyRef.current = streamKey
    if (!serverChanged && !keyChanged) return
    if (!mountedRef.current) return
    reconnectAttemptsRef.current = 0
    probeUpgradeRef.current = false
    if (serverChanged) {
      cleanup()
      connect()
      return
    }
    handleSeamlessReconnect()
    // Keyed on the identifiers only — the handlers are read fresh from the
    // render closure (same pattern as the reconnectSignal effect below).
  }, [serverUrl, streamKey])

  const prevReconnectSignalRef = useRef<number | undefined>(reconnectSignal)
  useEffect(() => {
    if (prevReconnectSignalRef.current === reconnectSignal) return
    prevReconnectSignalRef.current = reconnectSignal
    if (!mountedRef.current) return
    handleSeamlessReconnect()
    // Keyed ONLY on the signal: an unrelated re-render must never reconnect, and
    // `handleReconnect`/`connect` are read fresh from the render closure. (No
    // react-hooks lint plugin in this package, so no disable directive — adding
    // one errors as an unknown rule.)
  }, [reconnectSignal])

  const toggleMute = () => {
    if (videoRef.current) {
      const next = !videoRef.current.muted
      applyStreamMute(videoRef.current, next)
      setIsMuted(next)
    }
  }

  const toggleFullscreen = async () => {
    if (!containerRef.current) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }
      // Standard Fullscreen API — works on all modern desktop/Android browsers.
      if (containerRef.current.requestFullscreen) {
        await containerRef.current.requestFullscreen()
        return
      }
      // iOS Safari fallback: the Fullscreen API is not available for arbitrary
      // elements. The only supported path is `webkitEnterFullscreen()` on the
      // <video> element itself. We cast through `unknown` to avoid referencing a
      // non-standard property in the normal type surface.
      const video = videoRef.current as {
        webkitEnterFullscreen?: () => void
        webkitExitFullscreen?: () => void
      } | null
      if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen()
      }
    } catch (err) {
      console.warn(`Fullscreen toggle failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  const togglePip = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      // iOS WebKit (Safari / Chrome on iOS) has no standard PiP API — toggle the
      // <video> presentation mode directly (typed via the global augmentation).
      if (typeof video.webkitSetPresentationMode === 'function') {
        video.webkitSetPresentationMode(
          video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture',
        )
        return
      }
      // Standard Picture-in-Picture API (typed in lib.dom — no cast needed).
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await video.requestPictureInPicture()
      }
    } catch (err) {
      console.warn(`PiP toggle failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const takeSnapshot = () => {
    if (!videoRef.current) return
    const canvas = document.createElement('canvas')
    canvas.width = videoRef.current.videoWidth || 1280
    canvas.height = videoRef.current.videoHeight || 720
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(videoRef.current, 0, 0)
    const link = document.createElement('a')
    link.download = `${streamKey.replace(/[/:]/g, '-')}-${Date.now()}.jpg`
    link.href = canvas.toDataURL('image/jpeg', 0.92)
    link.click()
  }

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    // iOS Safari fires webkitfullscreenchange on the video element
    // (webkitEnterFullscreen / webkitExitFullscreen) rather than on document.
    const video = videoRef.current as EventTarget | null
    video?.addEventListener('webkitbeginfullscreen', handler)
    video?.addEventListener('webkitendfullscreen', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      video?.removeEventListener('webkitbeginfullscreen', handler)
      video?.removeEventListener('webkitendfullscreen', handler)
    }
  }, [])

  // Detect Picture-in-Picture support once the <video> is mounted: standard API
  // first, then the iOS WebKit presentation-mode fallback.
  useEffect(() => {
    const video = videoRef.current
    const standard = typeof document !== 'undefined' && document.pictureInPictureEnabled === true
    const webkit = video !== null && typeof video.webkitSetPresentationMode === 'function'
    setIsPipSupported(standard || webkit)
  }, [])

  // Keep the live <video> in sync when the parent flips the `muted` prop AFTER
  // mount (e.g. the grid's exclusive audio selection, or a host setMutedAll).
  // The mute state is otherwise seeded only once from `initialMuted` into
  // `isMuted` (line above), so a later prop change never reached the element and
  // audio never (un)muted — the "audio not propagated" grid bug. On unmute we
  // also kick play(): the change is driven by a user gesture (tap) and that call
  // satisfies the browser's autoplay-with-sound gate.
  // ── Stream-debug overlay (the `showStats` toggle) ────────────────────────
  //
  // Two independent polls, both alive ONLY while the overlay is visible:
  //   1. the PeerConnection's `getStats()`, derived by the pure
  //      `deriveWebrtcDebugStats` (codec, jitter, loss, NACK/PLI,
  //      framesDecoded, freezes, decode time, candidate-pair type, resolution
  //      changes);
  //   2. the SERVER's own account of the session — the rung `auto` resolved
  //      to and why the ladder last moved — through the injected
  //      `getSessionDebug`.
  //
  // Neither runs when `showStats` is false: an operator toggle must not leave
  // a 1 Hz tRPC query running behind a closed panel on every tile of a grid.
  const [debugStats, setDebugStats] = useState<WebrtcDebugStats | null>(null)
  const [serverDebug, setServerDebug] = useState<WebrtcSessionDebug | null>(null)
  const [serverDebugError, setServerDebugError] = useState<string | null>(null)
  // A ticking clock so the "measured Xs ago" ages advance between polls —
  // without it a frozen overlay looks as fresh as a live one, which is the
  // precise failure this surface exists to avoid.
  const [debugNow, setDebugNow] = useState(() => Date.now())
  // Either surface wants the numbers: the drawn overlay, or a host that
  // subscribed to them.
  const debugWanted = showStats || onDebugStats !== undefined
  useEffect(() => {
    if (!showStats) return
    const id = setInterval(() => setDebugNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [showStats])

  useEffect(() => {
    if (!debugWanted) {
      setDebugStats(null)
      return
    }
    // The previous sample lives in a ref, not in state: the window deltas must
    // be derived from the sample this tick actually followed, and a state read
    // inside an async tick is a render-old value.
    const prev: { current: WebrtcDebugStats | null } = { current: null }
    let cancelled = false
    const tick = async (): Promise<void> => {
      const pc = pcRef.current
      if (!pc) return
      try {
        const report = await pc.getStats()
        if (cancelled) return
        const next = deriveWebrtcDebugStats({
          report,
          prev: prev.current,
          now: Date.now(),
          iceConnectionState: pc.iceConnectionState,
          // `currentRemoteDescription`-era browsers expose the DTLS state on
          // the transport stat; `connectionState` is the aggregate and is what
          // every engine agrees on.
          dtlsState: pc.connectionState,
        })
        prev.current = next
        setDebugStats(next)
      } catch {
        // A transient getStats() failure keeps the LAST sample and lets its
        // age advance — it must not be reported as fresh zeroes.
      }
    }
    void tick()
    const id = setInterval(() => {
      void tick()
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [debugWanted])

  useEffect(() => {
    if (!debugWanted || !getSessionDebug) {
      setServerDebug(null)
      setServerDebugError(null)
      return
    }
    let cancelled = false
    const tick = async (): Promise<void> => {
      const sid = activeSessionIdRef.current
      if (sid === null) {
        // Said, not skipped. This is the branch that made the server half look
        // simply empty: no session id yet means nothing can be asked, and a
        // panel that shows "waiting for the first answer" for ever is
        // indistinguishable from a server that never replies.
        setServerDebugError('no session id on this player yet — nothing to ask the server about')
        return
      }
      try {
        const answer = await getSessionDebug(sid)
        if (cancelled) return
        setServerDebug(answer)
        setServerDebugError(null)
      } catch (err) {
        if (cancelled) return
        // Keep the last answer on screen — its age is shown, so a reader can
        // see it went stale — and name the failure rather than blanking.
        setServerDebugError(err instanceof Error ? err.message : String(err))
      }
    }
    void tick()
    const id = setInterval(() => {
      void tick()
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [debugWanted, getSessionDebug])

  // ── Reporting the same numbers OUT ───────────────────────────────────────
  //
  // One sample per second, carrying both halves and the session they describe.
  // The host renders them where its own UI can be touched; this player keeps
  // drawing the overlay or not, independently.
  //
  // `onDebugStats` is read through a ref so a caller that passes an inline
  // arrow — which every caller does — does not re-arm the interval on every
  // render, which would reset the window the client stats are measured over
  // and make every delta read zero.
  const onDebugStatsRef = useRef(onDebugStats)
  onDebugStatsRef.current = onDebugStats
  useEffect(() => {
    if (onDebugStats === undefined) return
    const emit = (): void => {
      onDebugStatsRef.current?.({
        at: Date.now(),
        verdict: freezeVerdict(debugStatsRef.current).kind,
        sessionId: activeSessionIdRef.current,
        stats: debugStatsRef.current,
        server: serverDebugRef.current,
        serverError: serverDebugErrorRef.current,
        serverWired: getSessionDebug !== undefined,
      })
    }
    emit()
    const id = setInterval(emit, 1000)
    return () => clearInterval(id)
    // Deliberately NOT depending on the sampled values: this timer reads the
    // latest through refs, so it arms once per mount instead of once per
    // sample.
  }, [onDebugStats === undefined, getSessionDebug])

  const debugStatsRef = useRef<WebrtcDebugStats | null>(null)
  debugStatsRef.current = debugStats
  const serverDebugRef = useRef<WebrtcSessionDebug | null>(null)
  serverDebugRef.current = serverDebug
  const serverDebugErrorRef = useRef<string | null>(null)
  serverDebugErrorRef.current = serverDebugError

  // ── Client network-condition reporter (drives the server ADAPTIVE ladder) ──
  // Inert unless `onClientNetworkSample` is wired. Samples inbound-video
  // getStats() ~every 2s and derives the client's live conditions as WINDOW
  // DELTAS (packet-loss % = Δlost / (Δlost + Δreceived)), matching the broker's
  // per-window loss tracker. The caller forwards these to
  // `networkQuality.reportClientStats`; the broker's adaptive controller polls
  // that value, so a poor link finally produces a real downgrade signal instead
  // of "auto" pinning the top tier.
  const netPrev = useRef<InboundReading | null>(null)
  useEffect(() => {
    if (!onClientNetworkSample) {
      netPrev.current = null
      return
    }
    const tick = async (): Promise<void> => {
      const pc = pcRef.current
      if (!pc) return
      try {
        const report = await pc.getStats()
        let lost = 0
        let recv = 0
        let bytes = 0
        let ts = 0
        let jitterS = 0
        let rttS = 0
        report.forEach((raw) => {
          const s = raw as RTCStats &
            Partial<{
              kind: string
              mediaType: string
              packetsLost: number
              packetsReceived: number
              bytesReceived: number
              jitter: number
              nominated: boolean
              currentRoundTripTime: number
            }>
          if (s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video') {
            lost = s.packetsLost ?? 0
            recv = s.packetsReceived ?? 0
            bytes = s.bytesReceived ?? 0
            ts = s.timestamp
            jitterS = s.jitter ?? 0
          } else if (
            s.type === 'candidate-pair' &&
            s.nominated &&
            typeof s.currentRoundTripTime === 'number'
          ) {
            rttS = s.currentRoundTripTime
          }
        })
        // The PC read may have been swapped (a tier change) since the last
        // tick: `nextClientSample` re-baselines rather than clamp to a zero,
        // and reports nothing while a renegotiation is in flight (D635 I1).
        const step = nextClientSample(
          netPrev.current,
          { pc, lost, recv, bytes, ts, rttS, jitterS },
          { renegotiating: renegotiatingRef.current, probe: latestProbeReading(serverUrl) },
        )
        netPrev.current = step.baseline
        if (step.sample !== null) onClientNetworkSample(step.sample)
      } catch {
        /* transient — skip this window */
      }
    }
    const id = setInterval(() => {
      void tick()
    }, 2000)
    return () => clearInterval(id)
  }, [onClientNetworkSample, serverUrl])

  // Recorded VOD-over-WebRTC stutter census. Sample inbound-video getStats()
  // + the <video> clock every 5 s and report per-window DELTAS: burst delivery
  // (dRecv spikes then 0), playback stalls (dCtMs → ~0), freezes, jitter-buffer
  // depth. The embed forwards these over the host log bridge (always shipped).
  const pbPrev = useRef<{
    recv: number
    dec: number
    drop: number
    freeze: number
    ct: number
    ts: number
  } | null>(null)
  useEffect(() => {
    if (!onPlaybackStats) {
      pbPrev.current = null
      return
    }
    const tick = async (): Promise<void> => {
      const pc = pcRef.current
      const video = videoRef.current
      if (!pc) return
      try {
        const report = await pc.getStats()
        let recv = 0,
          dec = 0,
          drop = 0,
          fps = 0,
          freeze = 0,
          freezeDur = 0,
          jbDelay = 0,
          jbEmitted = 0
        report.forEach((raw) => {
          const s = raw as RTCStats &
            Partial<{
              kind: string
              mediaType: string
              framesReceived: number
              framesDecoded: number
              framesDropped: number
              framesPerSecond: number
              freezeCount: number
              totalFreezesDuration: number
              jitterBufferDelay: number
              jitterBufferEmittedCount: number
            }>
          if (s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video') {
            recv = s.framesReceived ?? 0
            dec = s.framesDecoded ?? 0
            drop = s.framesDropped ?? 0
            fps = s.framesPerSecond ?? 0
            freeze = s.freezeCount ?? 0
            freezeDur = s.totalFreezesDuration ?? 0
            jbDelay = s.jitterBufferDelay ?? 0
            jbEmitted = s.jitterBufferEmittedCount ?? 0
          }
        })
        const ct = video?.currentTime ?? 0
        const now = Date.now()
        const prev = pbPrev.current
        const avgJitterMs = jbEmitted > 0 ? Math.round((jbDelay / jbEmitted) * 1000) : 0
        if (prev) {
          onPlaybackStats({
            dRecv: recv - prev.recv, // frames received this ~1s (burst → spikes then ~0)
            dDec: dec - prev.dec, // frames decoded
            dDrop: drop - prev.drop, // frames dropped
            fps: Math.round(fps),
            dFreeze: freeze - prev.freeze, // new freezes this window
            freezeTotalMs: Math.round(freezeDur * 1000),
            avgJitterMs, // jitter-buffer depth
            dCtMs: Math.round((ct - prev.ct) * 1000), // playback clock advance (stall → ~0)
            dtMs: now - prev.ts,
            readyState: video?.readyState ?? -1,
          })
        }
        pbPrev.current = { recv, dec, drop, freeze, ct, ts: now }
      } catch {
        /* transient — keep last */
      }
    }
    void tick()
    const id = setInterval(() => {
      void tick()
    }, 5000)
    return () => clearInterval(id)
  }, [onPlaybackStats])

  useEffect(() => {
    setIsMuted(initialMuted)
    const video = videoRef.current
    if (!video) return
    applyStreamMute(video, initialMuted)
    if (!initialMuted) video.play().catch(() => {})
  }, [initialMuted])

  const showToolbarBriefly = () => {
    // On touch devices the toolbar is pinned visible — don't install an
    // auto-hide timer that would remove it after the user's first tap.
    if (isTouch) return
    setShowToolbar(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setShowToolbar(false), 3000)
  }

  // Tapping the video toggles toolbar visibility so the user can dismiss it
  // after using a control (more video real-estate). NOT gated on `isTouch`:
  // if touch detection ever mis-fires, a tap must still be able to reveal the
  // controls — otherwise they'd be unreachable on that device.
  const handleTouchToggleToolbar = () => {
    setShowToolbar((v) => !v)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
  }

  // While playing, keep a fresh capture of the live frame; when the stream
  // leaves 'playing' (drop / reconnect), promote the latest capture so the
  // retained frame stays visible through the reconnect instead of black video.
  // We do NOT clear the still here — it's cleared only once the new stream
  // paints its first frame (the liveFrameReady effect), to avoid a black flash.
  useEffect(() => {
    if (state === 'playing') {
      captureFrame()
      const id = setInterval(captureFrame, 2000)
      return () => clearInterval(id)
    }
    if (hasPlayed && capturedFrameRef.current) setLastFrameUrl(capturedFrameRef.current)
  }, [state, hasPlayed, captureFrame])

  // Track when the (re)connected stream presents its FIRST real frame. Reset to
  // false whenever we leave 'playing' (so the still comes back on a drop), and
  // flip to true ONLY once the new stream actually presents a frame after
  // re-entering 'playing'. This is the gap that was flashing black: ICE reports
  // connected before the decoder has a frame on screen.
  //
  // Clearing the still must be driven by a REAL frame signal, never a bare
  // timer: a network-change reconnect over cellular/TURN-relay routinely takes
  // longer than a second or two to present the first frame, and the old 1500ms
  // safety timer dropped the retained still mid-gap → black. We register the
  // exact signal (requestVideoFrameCallback) AND loadeddata as a fallback for
  // engines where rVFC is unreliable, and keep a long last-resort safety so the
  // still is never pinned forever if every frame signal is somehow missed (state
  // is 'playing' here, so ICE is already connected — media should be flowing).
  useEffect(() => {
    if (state !== 'playing') {
      setLiveFrameReady(false)
      return
    }
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    const markReady = (): void => {
      if (!cancelled) setLiveFrameReady(true)
    }

    let rvfcHandle: number | undefined
    if (typeof video.requestVideoFrameCallback === 'function') {
      rvfcHandle = video.requestVideoFrameCallback(() => markReady())
    }
    video.addEventListener('loadeddata', markReady, { once: true })

    // Last-resort safety only (12s ≫ a slow first-frame); the real signals above
    // do the normal job. Deliberately NOT a short timer — that was the bug.
    const safety = setTimeout(markReady, 12_000)

    return () => {
      cancelled = true
      clearTimeout(safety)
      if (rvfcHandle !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(rvfcHandle)
      }
      video.removeEventListener('loadeddata', markReady)
    }
  }, [state])

  // The still to paint over the <video>: the retained last stream frame once
  // we've played, else the cold-start poster snapshot. Shown until the live
  // stream has presented a fresh frame (covers connecting/disconnected AND the
  // brief connected-but-not-yet-painted window).
  const stillImg = hasPlayed && lastFrameUrl ? lastFrameUrl : (posterUrl ?? null)
  const showStill = !liveFrameReady && stillImg !== null

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      // `isolate` establishes a clean stacking context so the z-indices below
      // are honoured against the video. On iOS WebKit (Safari AND Chrome — both
      // WebKit) a `<video>` reserves a hardware compositing layer on attach that
      // paints OVER its absolutely-positioned siblings regardless of z-index,
      // which left every over-video layer (toolbar, label, spinner) invisible on
      // mobile even before playback. The fix: pin the video to the lowest layer
      // (`relative z-0`) and GPU-promote each over-video layer (`transform-gpu`
      // → translate3d(0,0,0)) so it composites ABOVE the video's media layer.
      className={`relative isolate bg-black overflow-hidden group ${className}`}
      onMouseMove={showToolbarBriefly}
      onMouseEnter={showToolbarBriefly}
      onTouchStart={handleTouchToggleToolbar}
    >
      <video
        ref={videoRef}
        autoPlay={autoPlay}
        muted={isMuted}
        playsInline
        className="w-full h-full object-contain relative z-0"
      />

      {/* Retained-frame / snapshot still: covers the <video> until the live
          stream presents a fresh frame, so iOS WebKit's black-on-track-end and
          the connected-but-not-yet-painted gap never show. GPU-promoted so it
          composites ABOVE the video's media layer. */}
      {showStill && stillImg && (
        <img
          src={stillImg}
          alt=""
          className="absolute inset-0 w-full h-full object-contain z-[5] transform-gpu pointer-events-none"
        />
      )}

      {label && state === 'playing' && (
        <div className="absolute top-2 left-2 z-10 transform-gpu px-2 py-0.5 rounded bg-black/60 text-[10px] text-white font-medium">
          {label}
        </div>
      )}

      {showStats && (
        <StreamDebugOverlay
          stats={debugStats}
          server={serverDebug}
          serverError={serverDebugError}
          serverWired={getSessionDebug !== undefined}
          now={debugNow}
          sessionId={activeSessionIdRef.current}
        />
      )}

      {overlay}

      {/* No still to show (cold start, never played, no poster): full-cover
          loader while connecting; full error surface on a hard failure.

          BOTH are gated on `showControls`, completing the corner-chrome gate
          below: `showControls={false}` means the HOST draws the chrome, and
          in the hosted (WebView) case every touch over the video belongs to
          the host's gesture layer — so an in-page button here is VISIBLE but
          can never receive the press. Worse than none (operator, 2026-08-02:
          a retry button appeared and refused the tap). The hosted path
          reports the error up the state chain instead; the host's transport
          bar renders it and owns the retry control. */}
      {showControls && !stillImg && state === 'connecting' && (
        <div className="absolute inset-0 z-10 transform-gpu flex flex-col items-center justify-center bg-black/70 gap-2">
          <svg className="h-6 w-6 text-white/60 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="32"
              strokeDashoffset="32"
              className="animate-[dash_1.5s_ease-in-out_infinite]"
            />
          </svg>
          <span className="text-xs text-white/60">
            {t('uiLibrary.cameraStreamPlayer.connecting', 'Connecting…')}
          </span>
        </div>
      )}

      {showControls && !stillImg && (state === 'error' || state === 'disconnected') && (
        <div className="absolute inset-0 z-10 transform-gpu flex flex-col items-center justify-center bg-black/70 gap-2">
          <svg
            className="h-6 w-6 text-red-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              d="M1 1l5.5 5.5M23 23l-5.5-5.5M8.11 15.89a8 8 0 0110.78-10.78M3.64 3.64A12 12 0 0020.36 20.36"
              strokeLinecap="round"
            />
          </svg>
          <span className="text-xs text-red-400 text-center px-4">
            {state === 'error'
              ? errorMessage || t('uiLibrary.cameraStreamPlayer.failed', 'Connection failed')
              : t('uiLibrary.cameraStreamPlayer.disconnected', 'Disconnected')}
          </span>
          <button
            onClick={handleReconnect}
            className="mt-1 inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            {t('uiLibrary.cameraStreamPlayer.reconnect', 'Reconnect')}
          </button>
        </div>
      )}

      {/* A still IS showing: a small animated spinner in the corner while
          (re)connecting (over the retained frame / snapshot), or a compact
          retry button on a hard error — never a covering loader.

          Both are suppressed when `showControls` is false. That prop already
          means "the HOST draws the chrome": the viewer app embeds this player
          and shows the very same state on its playback-toolbar ring, so this
          corner disc was a SECOND loader for one state, drawn in the one
          corner the host cannot reach (the web embed is cross-origin, so it
          could not be hidden from outside either). Operator, 2026-08-02:
          "c'è ancora un loading spinner in alto a sinistra del player layer.
          Deve essere utilizzato anche in quel caso il loader sulla playback
          toolbar." [there is still a loading spinner at the top left of the player layer. The loader on the playback toolbar must be used in that case too.]

          The RETRY button is gated too: a host that draws its own chrome owns
          the recovery affordance as well, and a button the host cannot style
          or place is worse than none. A standalone embed (showControls: true)
          keeps both — there it is the only thing the viewer has. */}
      {showControls && stillImg && (state === 'connecting' || state === 'disconnected') && (
        <div className="absolute top-2 left-2 z-10 transform-gpu flex h-6 w-6 items-center justify-center rounded-full bg-black/55">
          <svg className="h-3.5 w-3.5 text-white/90 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="32"
              strokeDashoffset="32"
              className="animate-[dash_1.5s_ease-in-out_infinite]"
            />
          </svg>
        </div>
      )}

      {showControls && stillImg && state === 'error' && (
        <button
          onClick={handleReconnect}
          title={errorMessage || t('uiLibrary.cameraStreamPlayer.reconnect', 'Reconnect')}
          className="absolute top-2 left-2 z-10 transform-gpu flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white/90 hover:bg-black/75 transition-colors"
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      )}

      {showControls && state !== 'idle' && state !== 'error' && (
        <div
          className={`absolute bottom-0 inset-x-0 z-20 transform-gpu flex items-center justify-between px-3 py-1.5 bg-gradient-to-t from-black/80 to-transparent transition-opacity duration-200 ${
            // On touch devices the audio + fullscreen toolbar is PINNED
            // visible: a tap on the video used to toggle it off and, with
            // no hover to bring it back, the controls became unreachable
            // (the bug behind "non vedo audio e fullscreen" on mobile).
            // Pointer devices keep the hover-driven auto-hide via showToolbar.
            isTouch || showToolbar
              ? 'opacity-100 pointer-events-auto'
              : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className="flex items-center gap-1">
            <ToolbarButton
              onClick={toggleMute}
              title={
                isMuted
                  ? t('uiLibrary.cameraStreamPlayer.unmute', 'Unmute')
                  : t('uiLibrary.cameraStreamPlayer.mute', 'Mute')
              }
            >
              {isMuted ? (
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
                </svg>
              )}
            </ToolbarButton>
          </div>

          <div className="flex items-center gap-1">
            <ToolbarButton
              onClick={takeSnapshot}
              title={t('uiLibrary.cameraStreamPlayer.snapshot', 'Take snapshot')}
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </ToolbarButton>

            {isPipSupported && (
              <ToolbarButton
                onClick={togglePip}
                title={t('uiLibrary.cameraStreamPlayer.pip', 'Picture-in-Picture')}
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 9V6a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h4" />
                  <rect width="10" height="7" x="12" y="13" rx="2" />
                </svg>
              </ToolbarButton>
            )}

            <ToolbarButton
              onClick={toggleFullscreen}
              title={
                isFullscreen
                  ? t('uiLibrary.cameraStreamPlayer.exitFullscreen', 'Exit fullscreen')
                  : t('uiLibrary.cameraStreamPlayer.fullscreen', 'Fullscreen')
              }
            >
              {isFullscreen ? (
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
                </svg>
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
                </svg>
              )}
            </ToolbarButton>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      // min-w/min-h ensure a 44px touch target on mobile (iOS HIG / WCAG 2.5.5)
      // while keeping the visual size compact on desktop.
      className="rounded-full p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/80 hover:text-white hover:bg-white/20 active:bg-white/30 transition-colors"
    >
      {children}
    </button>
  )
}

async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  return new Promise<void>((resolve) => {
    let settled = false
    let poll: ReturnType<typeof setInterval> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      pc.removeEventListener('icegatheringstatechange', handler)
      resolve()
    }
    const handler = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    pc.addEventListener('icegatheringstatechange', handler)
    // Don't block startup on full ICE gathering. The LAN/Tailscale direct
    // path only needs a host candidate, which appears in <1s; waiting for
    // STUN/TURN gathering to "complete" cost many seconds of dead startup
    // latency. Resolve as soon as a host candidate is in the local SDP (with
    // a small floor so a fast srflx also makes the offer); srflx/relay keep
    // gathering into the SDP, we just don't wait on them. Hard cap bounds a
    // stalled agent (e.g. a remote-only client that needs a slow relay).
    const start = Date.now()
    poll = setInterval(() => {
      const sdp = pc.localDescription?.sdp ?? ''
      if (/ typ host/.test(sdp) && Date.now() - start >= 600) finish()
    }, 100)
    setTimeout(finish, 2500)
  })
}
