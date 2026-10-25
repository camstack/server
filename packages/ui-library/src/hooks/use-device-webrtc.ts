/**
 * useDeviceWebrtc — WebRTC signaling hook for device-scoped streaming.
 *
 * Provides `createSession`, `sendAnswer`, `closeSession` callbacks and
 * a `streams` list (Adaptive + High/Mid/Low) for a given device.
 *
 * Works in both admin-ui (BackendClient.trpc) and addon pages
 * (AddonPageProps.trpc) — parametrized by a minimal tRPC proxy shape.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import type { CamProfile, WebrtcSessionDebug } from '@camstack/types'
import type { StreamChoice } from '../composites/stream-panel'
import type {
  ClientStreamHints,
  SignalingResult,
  ClientOfferResult,
} from '../composites/camera-stream-player'
import { useLiveEvent } from './use-live-event'
import { TurnServerCache } from './turn-server-cache'
import type { ApplyDownlinkProbe, DownlinkProbeAnswer } from '../composites/adaptive-downlink'

/**
 * Discriminated WebRTC target — same shape as `WebrtcStreamTarget` on
 * the backend cap. The `profile` tier uses the canonical `CamProfile`
 * enum so an invalid tier is a compile error.
 */
export type WebrtcTarget =
  | { readonly kind: 'adaptive' }
  | { readonly kind: 'profile'; readonly profile: CamProfile }
  | { readonly kind: 'cam-stream'; readonly camStreamId: string }

// ---------------------------------------------------------------------------
// Minimal tRPC proxy shape — both admin-ui and addon pages satisfy this.
// ---------------------------------------------------------------------------

/** Mutation call shape: `.mutate(input)` → Promise. */
interface MutateFn<I, O> {
  mutate(input: I): Promise<O>
}

/** Query call shape: `.query(input?)` → Promise. */
interface QueryFn<I, O> {
  query(input: I): Promise<O>
}

interface StreamChoiceRow {
  readonly id: string
  readonly label: string
  readonly target: WebrtcTarget
  readonly codec: string | null
  readonly resolution: { width: number; height: number } | null
  readonly status: string | null
  readonly inputFps: number | null
  readonly bitrateKbps: number | null
}

/**
 * Minimal subset of the tRPC proxy needed for WebRTC signaling.
 * Both `BackendClient.trpc` and `AddonPageProps['trpc']` satisfy this
 * at runtime.
 */
export interface UseDeviceWebrtcTrpc {
  webrtcSession: {
    listStreams: QueryFn<{ deviceId: number }, readonly StreamChoiceRow[]>
    createSession: MutateFn<
      { deviceId: number; target: WebrtcTarget; hints?: ClientStreamHints },
      { sessionId: string; sdpOffer: string }
    >
    /**
     * Client-offer signaling: the browser builds the SDP offer (advertising
     * its native decode caps) and the server answers. The dual of
     * `createSession`; lets iOS pass H.264 High/Main through untouched.
     */
    handleOffer: MutateFn<
      {
        deviceId: number
        target: WebrtcTarget
        sdpOffer: string
        sessionId?: string
        hints?: ClientStreamHints
      },
      { sessionId: string; sdpAnswer: string }
    >
    handleAnswer: MutateFn<{ deviceId: number; sessionId: string; sdpAnswer: string }, void>
    /** Trickle ICE — push a client candidate to the server. */
    addIceCandidate: MutateFn<
      {
        deviceId: number
        sessionId: string
        candidate: string
        sdpMid?: string | null
        sdpMLineIndex?: number | null
      },
      void
    >
    /** Trickle ICE — poll the server's gathered candidates. */
    getIceCandidates: QueryFn<
      { deviceId: number; sessionId: string },
      {
        candidates: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }[]
        done: boolean
      }
    >
    closeSession: MutateFn<{ deviceId: number; sessionId: string }, void>
    /**
     * Poll the live signaling state of a session. `pendingRenegotiation`
     * is non-null after the server swaps the broker source to a different
     * tier (adaptive downgrade) — the client must re-offer on the same
     * `sessionId`; `epoch` guards against acting on a stale poll twice.
     */
    getSessionState: QueryFn<
      { deviceId: number; sessionId: string },
      { pendingRenegotiation: { target: WebrtcTarget; epoch: number } | null }
    >
    /** The SERVER's account of a live session, for the stream-debug overlay.
     *  Read-only; the overlay polls it at ~1 Hz only while it is visible. */
    getSessionDebug: QueryFn<{ deviceId: number; sessionId: string }, WebrtcSessionDebug>
    /**
     * Hand the viewer's downlink probe to ONE live session (D733). Optional:
     * a hub built before it has no such route, and the player then keeps its
     * legacy probe climb (a second session).
     */
    applyDownlinkProbe?: MutateFn<
      { deviceId: number; sessionId: string; downlinkMbps: number },
      DownlinkProbeAnswer
    >
  }
  pipelineOrchestrator?: {
    getCameraMetrics: QueryFn<
      { deviceId: number },
      {
        phase: string
        actualFps: number
        avgInferenceTimeMs: number
        droppedFrames: number
        configuredFps: number
      } | null
    >
  }
  /** Optional: aggregated STUN/TURN servers (e.g. cloudflare-turn). When
   *  present, the client uses them so it can gather a reachable relay
   *  candidate for remote (CGNAT/mobile) viewing. */
  turnProvider?: {
    getTurnServers: QueryFn<
      void,
      readonly { urls: string | readonly string[]; username?: string; credential?: string }[]
    >
  }
}

interface CameraMetricsSnapshotPayload {
  readonly deviceId?: number
  readonly metrics?: {
    readonly phase: string
    readonly actualFps: number
    readonly avgInferenceTimeMs: number
    readonly droppedFrames: number
  }
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

/** Pipeline detection metrics for a device. */
export interface DevicePipelineMetrics {
  readonly phase: string
  readonly detectionFps: number
  readonly avgInferenceMs: number
  readonly droppedFrames: number
}

export interface DeviceWebrtcResult {
  /** Available stream choices for the dropdown (Adaptive + assigned profiles). */
  readonly streams: readonly StreamChoice[]
  /** Whether the device has at least one assigned profile (can stream). */
  readonly hasWebrtc: boolean
  /** Live pipeline metrics (phase, detection fps, inference time). */
  readonly pipelineMetrics: DevicePipelineMetrics | null
  /** Server-offer signaling: create a WebRTC session. */
  readonly createSession: (
    target: WebrtcTarget,
    hints?: ClientStreamHints,
  ) => Promise<SignalingResult>
  /** Server-offer signaling: send the client's SDP answer. */
  readonly sendAnswer: (sessionId: string, sdpAnswer: string) => Promise<void>
  /**
   * Client-offer signaling (preferred for browsers): post a browser-built
   * SDP offer and get the server's answer. The browser advertises its full
   * H.264 decode caps in the offer, so a Main/High (incl. 4K) source passes
   * through with no transcode — the only path that lets iOS decode High.
   */
  readonly handleOffer: (
    target: WebrtcTarget,
    sdpOffer: string,
    sessionId?: string,
    hints?: ClientStreamHints,
  ) => Promise<ClientOfferResult>
  /**
   * Fetch the browser-side ICE servers (STUN + TURN from the `turn-provider`
   * cap). Needed for client-offer mode, where the PeerConnection must be
   * built with TURN BEFORE the offer is created so a remote/CGNAT viewer can
   * gather a relay candidate. Best-effort — resolves `undefined` on failure
   * (the player falls back to public STUN).
   */
  readonly getIceServers: () => Promise<readonly RTCIceServer[] | undefined>
  /** Trickle ICE — push a client-gathered candidate to the server. */
  readonly addIceCandidate: (sessionId: string, candidate: RTCIceCandidateInit) => Promise<void>
  /** Trickle ICE — poll the server's gathered candidates for a session. */
  readonly getIceCandidates: (
    sessionId: string,
  ) => Promise<{ candidates: RTCIceCandidateInit[]; done: boolean }>
  /** Close a WebRTC session on the server. */
  readonly closeSession: (sessionId: string) => Promise<void>
  /**
   * Poll the live signaling state of a session. After an adaptive tier
   * switch the server returns a non-null `pendingRenegotiation` (the new
   * target + a monotonic `epoch`); the player re-offers on the SAME
   * `sessionId` so the session re-negotiates against the new tier. Returns
   * `{ pendingRenegotiation: null }` for non-adaptive / steady sessions.
   */
  readonly getSessionState: (sessionId: string) => Promise<SessionRenegotiationState>
  /**
   * The SERVER half of the stream-debug overlay for a session. Unlike
   * `getSessionState`, a failure here THROWS rather than resolving a benign
   * default: this is a diagnostic read, and a swallowed error would render as
   * a confident set of unknowns with no reason attached. The overlay catches
   * it and shows the message.
   */
  readonly getSessionDebug: (sessionId: string) => Promise<WebrtcSessionDebug>
  /**
   * Hand the downlink probe to the session it was measured on (D733). Rejects
   * when there is no device or the hub has no such method — the player reads
   * a rejection as "unsupported" and falls back to its legacy climb.
   */
  readonly applyDownlinkProbe: ApplyDownlinkProbe
}

/** Live signaling state for a session — the adaptive re-offer signal. */
export interface SessionRenegotiationState {
  readonly pendingRenegotiation: { readonly target: WebrtcTarget; readonly epoch: number } | null
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook that provides WebRTC signaling callbacks and stream choices for a device.
 *
 * @param trpc  - tRPC proxy (admin-ui BackendClient.trpc or addon page trpc)
 * @param deviceId - numeric device ID (null = disabled)
 * @param pollIntervalMs - how often to refresh profile slots (default: 5000)
 */
/** Module-level TURN/STUN credential cache. Keyed on the caller's trpc client
 *  object (stable per connected system — NOT on `trpc.turnProvider`, which is
 *  a proxy minted fresh on every property access), so two admin tabs pointed
 *  at different hubs never cross-serve credentials from the memory layer; the
 *  storage layer is per-origin, and the page's origin IS the hub. Coalesces
 *  concurrent fetches (the mount prefetch and the connect's own call used to
 *  race into TWO round trips) and persists across page loads so a fresh embed
 *  page — one per camera open on native — finds warm credentials instead of
 *  re-paying the measured 0.2–3.6 s serialized fetch. See turn-server-cache.ts. */
const turnServersCache = new TurnServerCache()

export function useDeviceWebrtc(
  trpc: UseDeviceWebrtcTrpc,
  deviceId: number | null,
  pollIntervalMs = 5000,
): DeviceWebrtcResult {
  const [remoteStreams, setRemoteStreams] = useState<readonly StreamChoiceRow[]>([])

  // Fetch available streams from the webrtc-session cap
  useEffect(() => {
    if (deviceId === null) return
    let cancelled = false
    const fetch = () => {
      trpc.webrtcSession.listStreams
        .query({ deviceId })
        .then((rows) => {
          if (!cancelled) setRemoteStreams(rows)
        })
        .catch(() => {})
    }
    fetch()
    const iv = setInterval(fetch, pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [trpc, deviceId, pollIntervalMs])

  // Pipeline metrics (phase, detection fps, inference time).
  //
  // Primary signal: `pipeline.camera-metrics-snapshot` event emitted
  // ~1 Hz by the runner that holds this camera. Subscribe via the
  // live-events router and update local state in place — no polling.
  //
  // Bootstrap fallback: when the subscription isn't available yet
  // (initial WS reconnect, runner just spawned), seed once via the
  // orchestrator query so the overlay shows the last-known phase
  // until the first event arrives. The orchestrator routes to the
  // runner that owns the camera (via the assignment map), so this
  // covers multi-agent setups too.
  const [pipelineMetrics, setPipelineMetrics] = useState<DevicePipelineMetrics | null>(null)
  useEffect(() => {
    if (deviceId === null) return
    let cancelled = false
    if (trpc.pipelineOrchestrator) {
      trpc.pipelineOrchestrator.getCameraMetrics
        .query({ deviceId })
        .then((m) => {
          if (cancelled || !m) return
          setPipelineMetrics({
            phase: m.phase,
            detectionFps: m.actualFps,
            avgInferenceMs: m.avgInferenceTimeMs,
            droppedFrames: m.droppedFrames,
          })
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [trpc, deviceId])

  // Live updates: same `pipeline.camera-metrics-snapshot` event the
  // bootstrap query seeds. Filter to the current `deviceId` inside the
  // callback — `useLiveEvent` re-binds on connection-version bumps.
  useLiveEvent<CameraMetricsSnapshotPayload>('pipeline.camera-metrics-snapshot', (evt) => {
    if (deviceId === null) return
    const payload = evt.data
    if (payload.deviceId !== deviceId || !payload.metrics) return
    setPipelineMetrics({
      phase: payload.metrics.phase,
      detectionFps: payload.metrics.actualFps,
      avgInferenceMs: payload.metrics.avgInferenceTimeMs,
      droppedFrames: payload.metrics.droppedFrames,
    })
  })

  // Map remote stream choices to StreamPanel's StreamChoice format —
  // each row carries the structured `target` so the player can hand
  // it back to `createSession` verbatim. No streamId string parsing
  // anywhere in the pipeline.
  const { streams, hasWebrtc } = useMemo(() => {
    if (deviceId === null || remoteStreams.length === 0) {
      return { streams: [] as StreamChoice[], hasWebrtc: false }
    }
    const choices: StreamChoice[] = remoteStreams.map((r) => ({
      id: r.id,
      label: r.label,
      target: r.target,
      status: r.status,
      inputFps: r.inputFps,
      bitrateKbps: r.bitrateKbps,
    }))
    return { streams: choices, hasWebrtc: true }
  }, [deviceId, remoteStreams])

  // Fetch TURN/STUN for the BROWSER side so it can gather a reachable
  // relay candidate over CGNAT/mobile. Best-effort: resolves
  // `undefined` on failure so callers fall back to public STUN only. Shared
  // by `createSession` (server-offer) and `getIceServers` (client-offer).
  //
  // CACHED + PREFETCHED + PERSISTED: measured cold-start breakdowns put this
  // fetch at 0.2–3.6 s, serialized before the offer — the single largest
  // fixed client-side cost of a connect. `TurnServerCache` coalesces
  // concurrent calls (prefetch + connect no longer race into two round
  // trips) and persists the credentials per-origin so the NEXT page load —
  // every camera open on native is one — finds them warm.
  const getIceServers = useCallback(async (): Promise<readonly RTCIceServer[] | undefined> => {
    const provider = trpc.turnProvider
    if (!provider) return undefined
    return turnServersCache.getOrFetch(trpc, async () => {
      const servers = await provider.getTurnServers.query()
      return servers.map((s): RTCIceServer => {
        const urls: string | string[] = typeof s.urls === 'string' ? s.urls : [...s.urls]
        return {
          urls,
          ...(s.username !== undefined ? { username: s.username } : {}),
          ...(s.credential !== undefined ? { credential: s.credential } : {}),
        }
      })
    })
  }, [trpc])

  // Warm the TURN cache while the page is still booting (probe, stream-list
  // hydration) so the connect's serialized `getIceServers` await is ~0 ms.
  useEffect(() => {
    void getIceServers()
  }, [getIceServers])

  // Signaling callbacks — device-scoped webrtc-session cap
  const createSession = useCallback(
    async (target: WebrtcTarget, hints?: ClientStreamHints): Promise<SignalingResult> => {
      if (deviceId === null) throw new Error('No device selected')
      const res = await trpc.webrtcSession.createSession.mutate({ deviceId, target, hints })
      const iceServers = await getIceServers()
      return {
        sessionId: res.sessionId,
        sdpOffer: res.sdpOffer,
        ...(iceServers ? { iceServers } : {}),
      }
    },
    [trpc, deviceId, getIceServers],
  )

  // Client-offer signaling: post the browser's offer, get the server's
  // answer. Preferred for browsers — it's the only path that passes H.264
  // High/Main (incl. 4K) through to iOS without transcoding.
  // `sessionId` is OPTIONAL: omitted on the initial connect (server mints
  // a fresh id); supplied during an adaptive re-offer so the server
  // replaces the existing session under that id (it closes the stale
  // PeerConnection and creates a fresh one against the new tier).
  const handleOffer = useCallback(
    async (
      target: WebrtcTarget,
      sdpOffer: string,
      sessionId?: string,
      hints?: ClientStreamHints,
    ): Promise<ClientOfferResult> => {
      if (deviceId === null) throw new Error('No device selected')
      return trpc.webrtcSession.handleOffer.mutate({
        deviceId,
        target,
        sdpOffer,
        ...(sessionId !== undefined ? { sessionId } : {}),
        // Viewport/downlink hints drive the server's adaptive tier scoring.
        // Cold start omits downlink so the first picture is the lowest rung;
        // a probe then climbs through mid/high. The cap accepts `hints` on
        // `handleOffer`; forward them.
        ...(hints !== undefined ? { hints } : {}),
      })
    },
    [trpc, deviceId],
  )

  const sendAnswer = useCallback(
    async (sessionId: string, sdpAnswer: string) => {
      if (deviceId === null) throw new Error('No device selected')
      await trpc.webrtcSession.handleAnswer.mutate({ deviceId, sessionId, sdpAnswer })
    },
    [trpc, deviceId],
  )

  // Trickle ICE — push a client-gathered candidate to the server.
  const addIceCandidate = useCallback(
    async (sessionId: string, candidate: RTCIceCandidateInit) => {
      if (deviceId === null) return
      await trpc.webrtcSession.addIceCandidate
        .mutate({
          deviceId,
          sessionId,
          candidate: candidate.candidate ?? '',
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        })
        .catch(() => {})
    },
    [trpc, deviceId],
  )

  // Trickle ICE — poll the server's gathered candidates for a session.
  const getIceCandidates = useCallback(
    async (sessionId: string): Promise<{ candidates: RTCIceCandidateInit[]; done: boolean }> => {
      if (deviceId === null) return { candidates: [], done: true }
      return trpc.webrtcSession.getIceCandidates.query({ deviceId, sessionId })
    },
    [trpc, deviceId],
  )

  const closeSession = useCallback(
    async (sessionId: string) => {
      if (deviceId === null) return
      await trpc.webrtcSession.closeSession.mutate({ deviceId, sessionId }).catch(() => {})
    },
    [trpc, deviceId],
  )

  // Poll the session's live signaling state. The player calls this on its
  // existing poll cadence; a non-null `pendingRenegotiation` tells it to
  // re-offer against the new tier. Resolves `null` on failure / no device
  // so the player's poll loop treats it as a steady (no-op) session.
  const getSessionState = useCallback(
    async (sessionId: string): Promise<SessionRenegotiationState> => {
      if (deviceId === null) return { pendingRenegotiation: null }
      try {
        return await trpc.webrtcSession.getSessionState.query({ deviceId, sessionId })
      } catch {
        return { pendingRenegotiation: null }
      }
    },
    [trpc, deviceId],
  )

  // The SERVER half of the stream-debug overlay. Deliberately NOT error-
  // swallowing (see the doc on the returned member).
  const getSessionDebug = useCallback(
    async (sessionId: string): Promise<WebrtcSessionDebug> => {
      if (deviceId === null) {
        throw new Error('getSessionDebug: no device bound to this player')
      }
      return trpc.webrtcSession.getSessionDebug.query({ deviceId, sessionId })
    },
    [trpc, deviceId],
  )

  const applyDownlinkProbe = useCallback(
    async (sessionId: string, downlinkMbps: number): Promise<DownlinkProbeAnswer> => {
      const mutate = trpc.webrtcSession.applyDownlinkProbe
      if (deviceId === null || mutate === undefined) {
        throw new Error('applyDownlinkProbe: not available for this player')
      }
      return mutate.mutate({ deviceId, sessionId, downlinkMbps })
    },
    [trpc, deviceId],
  )

  return {
    streams,
    hasWebrtc,
    pipelineMetrics,
    createSession,
    handleOffer,
    getIceServers,
    addIceCandidate,
    getIceCandidates,
    sendAnswer,
    closeSession,
    getSessionState,
    getSessionDebug,
    applyDownlinkProbe,
  }
}
