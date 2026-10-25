/**
 * StreamPanel — unified camera stream viewer with header bar, overlay toggles,
 * stream selector, pipeline phase, play/stop, and snapshot preview.
 *
 * Combines features from LiveStreamViewer (admin-ui) and PipelineTab (benchmark)
 * into a single reusable component in ui-library.
 *
 * The component is data-agnostic: callers fetch devices/streams/detections using
 * their own hooks and pass the results as props.
 */
import { useState, useMemo, useRef, useEffect, useCallback, type ReactNode, type JSX } from 'react'
import type { CamProfile, WebrtcSessionDebug } from '@camstack/types'
import type { QualityOption } from './hls-quality'
import type { ApplyDownlinkProbe } from './adaptive-downlink'
import {
  CameraStreamPlayer,
  type SignalingResult,
  type ClientOfferResult,
  type ClientStreamHints,
  type SessionSignalingState,
  type PlayerWebrtcTarget,
} from './camera-stream-player'
import { HlsVideo } from './hls-video'
import { DetectionOverlay } from './detection-overlay'
import type { DeviceDetections } from '../hooks/use-device-detections'
import type { StationaryOverlayBox } from '@camstack/types'
import { usePlayerToolbarButtons } from '../contexts/player-overlays'
import { useUiText } from '../contexts/ui-text'
import { useRecordedPlayback } from '../contexts/recorded-playback'

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Discriminated WebRTC target — same shape as the backend cap. The
 * `profile` tier uses the canonical `CamProfile` enum.
 */
export type StreamChoiceTarget =
  | { readonly kind: 'adaptive' }
  | { readonly kind: 'profile'; readonly profile: CamProfile }
  | { readonly kind: 'cam-stream'; readonly camStreamId: string }

export interface StreamChoice {
  /**
   * Stable identifier for React keys, dropdown values, and the
   * player's `streamKey` prop. Opaque to the panel — typical values:
   * `'adaptive'`, `'profile:high'`, `'stream:native:main'`.
   */
  readonly id: string
  /** Display label (e.g. "Adaptive", "HIGH (3840×2160)", "Native main"). */
  readonly label: string
  /** Structured WebRTC target — passed verbatim to `createSession`. */
  readonly target: StreamChoiceTarget
  /** Live broker status (null if unavailable). */
  readonly status?: string | null
  /** Input FPS from camera (null if unavailable). */
  readonly inputFps?: number | null
  /** Bitrate in kbps (null if unavailable). */
  readonly bitrateKbps?: number | null
}

export interface StreamStats {
  readonly status: string
  readonly inputFps: number
  readonly uptimeMs: number
}

export interface StreamPanelProps {
  // --- WebRTC signaling (live mode) ---
  // Optional so a VOD-only caller (recorded playback via `playbackUrl`) can
  // omit them entirely. When `playbackUrl` is unset, live mode needs at
  // least `serverUrl` + the offer/answer pair to connect.
  readonly serverUrl?: string
  readonly createSession?: (
    target: StreamChoiceTarget,
    hints?: ClientStreamHints,
  ) => Promise<SignalingResult>
  readonly sendAnswer?: (sessionId: string, sdpAnswer: string) => Promise<void>
  /**
   * Client-offer signaling — PREFERRED over `createSession` for browsers.
   * Closes over the selected target; the player builds the offer and this
   * posts it. Lets iOS pass H.264 High/Main (incl. 4K) through untouched.
   * Optional so non-browser callers (benchmark) can stay on server-offer.
   */
  readonly handleOffer?: (
    target: StreamChoiceTarget,
    sdpOffer: string,
    sessionId?: string,
  ) => Promise<ClientOfferResult>
  /** Browser-side ICE servers (STUN + TURN) for client-offer mode. */
  readonly getIceServers?: () => Promise<readonly RTCIceServer[] | undefined>
  /** Trickle ICE — push a client candidate to the server (sessionId-scoped). */
  readonly addIceCandidate?: (sessionId: string, candidate: RTCIceCandidateInit) => Promise<void>
  /** Trickle ICE — poll the server's gathered candidates (sessionId-scoped). */
  readonly getIceCandidates?: (
    sessionId: string,
  ) => Promise<{ candidates: RTCIceCandidateInit[]; done: boolean }>
  readonly closeSession?: (sessionId: string) => Promise<void>
  /**
   * Poll a session's live signaling state (client-offer mode). A non-null
   * `pendingRenegotiation` after an adaptive tier switch makes the player
   * transparently re-offer on the same session. Optional — omit to disable
   * adaptive re-offer (steady-state behaviour is unchanged).
   */
  readonly getSessionState?: (sessionId: string) => Promise<SessionSignalingState>
  /**
   * The server half of the stream-debug overlay. Optional, and when it is
   * absent the overlay SAYS so rather than showing an empty section — a panel
   * that silently omits half its answer is worse than one that admits it.
   */
  readonly getSessionDebug?: (sessionId: string) => Promise<WebrtcSessionDebug>
  /** Hand the downlink probe to the live session (D733) — one session per open. */
  readonly applyDownlinkProbe?: ApplyDownlinkProbe

  // --- VOD playback (recorded footage) ---
  /**
   * When set, the panel switches to VOD mode: it renders an `HlsVideo`
   * over this master `.m3u8` URL INSTEAD of the live WebRTC player, and
   * the live signaling props are ignored. Lets the same hero player show
   * recordings/clips (driven by the Recording tab) without a second
   * player. Clearing it returns the panel to live mode.
   */
  readonly playbackUrl?: string
  /**
   * What {@link playbackUrl} is. Absent means `hls` — the recorder's manifest,
   * which is what every caller passed before native clips existed. A vendor
   * addon's own clip is `mp4` and the hero plays it as a plain media URL
   * (D549 22); passing it as `hls` would hand an MP4 to a manifest parser.
   */
  readonly playbackFormat?: 'hls' | 'mp4'
  /** Bearer token for the admin-gated data-plane playback route (optional). */
  readonly playbackAuthToken?: string | null
  /**
   * Short label for the clip/window being played — shown in the header in
   * place of the stream selector while in VOD mode.
   */
  readonly playbackLabel?: string
  /**
   * Invoked when the operator clicks the (re-purposed) play/stop button
   * while in VOD mode. The caller clears its playback request to return
   * the panel to the live stream.
   */
  readonly onExitPlayback?: () => void

  // --- Stream selection ---
  /** Available streams. If omitted or single entry, no dropdown shown. */
  readonly streams?: readonly StreamChoice[]
  /** Currently active StreamChoice id. Defaults to first stream. */
  readonly activeStreamId?: string
  /** Called when user selects a different stream (StreamChoice id). */
  readonly onStreamChange?: (id: string) => void

  // --- Device / header info ---
  readonly deviceName?: string
  /** Pipeline phase from useDeviceDetections (e.g. "active", "watching") */
  readonly phase?: string
  /** Pipeline metrics from useDeviceWebrtc. If provided, overrides phase and adds detection fps. */
  readonly pipelineMetrics?: { phase: string; detectionFps: number; avgInferenceMs: number } | null

  // --- Detection overlays ---
  /** Detection data from useDeviceDetections hook. If omitted, no overlays. */
  readonly detections?: DeviceDetections
  /** The census for this camera, normalised — from the occupancy snapshot. The
   *  panel is data-agnostic by design, so the caller fetches it; absent means
   *  "not fetched", and the stationary layer then draws nothing rather than
   *  claiming an empty lot. */
  readonly stationaryObjects?: readonly StationaryOverlayBox[]
  /** Initial state for detection overlay (default: true) */
  readonly defaultShowDetections?: boolean
  /** Initial state for motion overlay (default: false) */
  readonly defaultShowMotion?: boolean

  // --- Stream stats (optional) ---
  readonly streamStats?: StreamStats

  // --- Play/Stop + Snapshot ---
  /** Auto-play on mount (default: true) */
  readonly autoPlay?: boolean
  /** Show play/stop toggle + snapshot preview when stopped (default: false) */
  readonly showPlayStop?: boolean
  /** Snapshot source URL (data: URI). Only used when showPlayStop=true. */
  readonly snapshotSrc?: string | null
  /**
   * Optional poster (snapshot data-URL) painted by the live `<video>` until
   * its FIRST frame decodes — a cold-start fallback only. Independent of
   * `snapshotSrc` (which is the play/stop preview). Caller-supplied; when
   * omitted the video simply starts black until the first frame.
   */
  readonly posterUrl?: string
  /** Whether snapshot is currently loading */
  readonly snapshotLoading?: boolean
  /** Callback to refresh snapshot */
  readonly onRefreshSnapshot?: () => void

  // --- Visibility ---
  /** Show stream stats in header (fps, uptime) (default: false) */
  readonly showStreamStats?: boolean

  // --- Extra content below the video ---
  readonly children?: ReactNode

  /**
   * Extra overlay node composited on top of the video, alongside the
   * built-in detection overlay. Used by callers to layer device-scoped
   * controls (PTZOverlay, AudioPTT, ...) without forking the panel.
   */
  readonly extraOverlay?: ReactNode

  /**
   * Whether the device supports PTZ. When true, the header shows a
   * "PTZ" toggle next to detect/motion.
   */
  readonly ptzAvailable?: boolean
  /**
   * Controlled visibility of the PTZ overlay. Drives both the
   * header button highlight and (combined with `ptzOverlay`) overlay
   * rendering. Caller computes the final value (e.g. OR with an
   * external "force on" surface like a floating PTZ panel) and
   * passes it down here.
   */
  readonly ptzShown?: boolean
  /**
   * Overlay rendered ON the live video when `ptzShown` is true.
   * Typically a `<PTZOverlay controls={...} mode="overlay" />` from
   * ui-library. Combined with `extraOverlay` in the player overlay
   * slot — both render together when active.
   */
  readonly ptzOverlay?: ReactNode
  /**
   * Notified when the user clicks the in-header PTZ toggle. The
   * caller updates its source of truth for `ptzShown`. No-op if
   * omitted (button stays inert).
   */
  readonly onPtzToggle?: () => void

  /**
   * Whether the device supports two-way audio (intercom). When true,
   * the header shows an "Intercom" toggle next to detect/motion that
   * lets the operator open the floating intercom panel without leaving
   * the stream view.
   */
  readonly intercomAvailable?: boolean
  /**
   * Controlled visibility of the intercom panel — drives the button's
   * highlight state. The caller (which owns the floating-panel state)
   * passes `true` while its intercom panel is open.
   */
  readonly intercomShown?: boolean
  /**
   * Notified when the user clicks the in-header intercom toggle. The
   * caller flips its panel state. No-op if omitted (button inert).
   */
  readonly onIntercomToggle?: () => void

  /**
   * When true, drops the panel's outer rounded card chrome (border,
   * rounded corners, background). Use when embedding into another
   * surface that already provides framing — e.g. the device-detail
   * left-column hero where the panel is one row of a larger card.
   */
  readonly chromeless?: boolean

  readonly className?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusDot(st: string): string {
  if (st === 'streaming') return 'bg-emerald-500'
  if (st === 'connecting') return 'bg-amber-500'
  if (st === 'error') return 'bg-rose-500'
  return 'bg-zinc-500'
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

// ── Play icon (inline SVG to avoid lucide-react dependency in ui-library) ───

function PlayIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function StopIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  )
}

function MicIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function MoreIcon({ className }: { readonly className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  )
}

// Sub-menu row used for boolean toggles in the kebab popover.
function MenuToggle({
  label,
  active,
  onClick,
}: {
  readonly label: string
  readonly active: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-[11px] text-foreground hover:bg-surface-hover transition-colors"
    >
      <span>{label}</span>
      <span
        className={`inline-block h-3 w-5 rounded-full transition-colors ${active ? 'bg-primary' : 'bg-foreground-subtle/30'} relative`}
      >
        <span
          className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-all ${active ? 'left-2.5' : 'left-0.5'}`}
        />
      </span>
    </button>
  )
}

function LiveIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
    </svg>
  )
}

function RefreshIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  )
}

function ImageOffIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M10.41 10.41a2 2 0 11-2.83-2.83" />
      <line x1="13.5" y1="13.5" x2="6" y2="21" />
      <path d="M18 12l-1.5-1.5" />
      <path d="M21 15V5a2 2 0 00-2-2H5" />
      <path d="M21 21H5a2 2 0 01-2-2V11" />
    </svg>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export function StreamPanel({
  serverUrl,
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
  playbackUrl,
  playbackFormat,
  playbackAuthToken,
  onExitPlayback,
  posterUrl,
  streams,
  activeStreamId: controlledStreamId,
  onStreamChange,
  deviceName,
  phase,
  pipelineMetrics,
  detections,
  stationaryObjects,
  defaultShowDetections = true,
  defaultShowMotion = false,
  streamStats,
  autoPlay = false,
  showPlayStop = false,
  snapshotSrc,
  snapshotLoading = false,
  onRefreshSnapshot,
  showStreamStats = false,
  children,
  extraOverlay,
  ptzAvailable = false,
  ptzShown = false,
  ptzOverlay,
  onPtzToggle,
  intercomAvailable = false,
  intercomShown = false,
  onIntercomToggle,
  chromeless = false,
  className,
}: StreamPanelProps): JSX.Element {
  const t = useUiText()
  // Toolbar buttons registered by sibling tabs / addon UIs via
  // `usePlayerToolbarButton`. The host renders them uniformly next to
  // the always-on actions (Intercom + Play/Stop). Lets a tab (Detection
  // → Zones, Live stats → Speak, ...) own its button without forking
  // this composite.
  const registeredButtons = usePlayerToolbarButtons()
  // Recorded-playback control (R9): when a RecordedPlaybackProvider is
  // mounted (device-detail page), bind the player's `camstack-control`
  // datachannel into the shared context so the Recording timeline can drive
  // frame-push recorded playback on this SAME WebRTC session. Outside a
  // provider `bindControlChannel` is null → no channel is opened and the
  // player behaves exactly as before.
  const recordedPlayback = useRecordedPlayback()
  // --- Internal state ---
  const [isPlaying, setIsPlaying] = useState(autoPlay)
  const [showDetections, setShowDetections] = useState(defaultShowDetections)
  // Moving vs stationary, as two switches — the same split the viewer's
  // overlay panel offers. Both default ON so turning detections on keeps
  // showing everything it showed before.
  const [showMoving, setShowMoving] = useState(true)
  const [showStationary, setShowStationary] = useState(true)
  const [showMotion, setShowMotion] = useState(defaultShowMotion)
  const [internalStreamId, setInternalStreamId] = useState<string | null>(null)

  // VOD quality selector — lifted from HlsVideo so the selector renders in
  // the header at the same position and with the same styling as the live
  // stream selector. Reset when the playback URL changes.
  const [vodQuality, setVodQuality] = useState<readonly QualityOption[]>([])
  const [vodLevel, setVodLevel] = useState(-1)

  // Sub-menu (kebab) for the secondary controls — Detect/Motion/PTZ
  // toggles + stream stats + adaptive picker. Only Intercom and
  // Play/Stop stay always-visible in the toolbar.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    function onClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  // Reset VOD level selection when the clip changes so Auto is restored.
  useEffect(() => {
    setVodLevel(-1)
  }, [playbackUrl])

  // Stable callback for HlsVideo — avoids re-mounting on every render.
  const handleVodQualityOptions = useCallback((options: readonly QualityOption[]) => {
    setVodQuality(options)
  }, [])

  // Resolve effective stream by StreamChoice id.
  const effectiveStreamId = controlledStreamId ?? internalStreamId ?? streams?.[0]?.id ?? ''

  // Derive stats from the currently selected stream choice
  const selectedChoice = streams?.find((s) => s.id === effectiveStreamId) ?? streams?.[0]
  const choiceStats =
    selectedChoice?.inputFps != null
      ? {
          status: selectedChoice.status ?? 'unknown',
          inputFps: selectedChoice.inputFps,
          bitrateKbps: selectedChoice.bitrateKbps ?? 0,
        }
      : null

  const handleStreamChange = (id: string) => {
    setInternalStreamId(id)
    onStreamChange?.(id)
    // Restart player on stream change
    if (isPlaying && showPlayStop) {
      setIsPlaying(false)
      setTimeout(() => setIsPlaying(true), 50)
    }
  }

  // Closure passed to the player — captures the selected target so the
  // player itself stays target-agnostic and only ships hints.
  const playerCreateSession = useMemo<
    ((hints?: ClientStreamHints) => Promise<SignalingResult>) | undefined
  >(() => {
    const target = selectedChoice?.target
    if (!target || !createSession) return undefined
    return (hints) => createSession(target, hints)
  }, [createSession, selectedChoice])

  // Client-offer counterpart — also captures the selected target so the
  // player stays target-agnostic. Undefined when the parent didn't wire
  // `handleOffer` (server-offer fallback) or no target is selected yet.
  const playerHandleOffer = useMemo<
    ((sdpOffer: string, sessionId?: string) => Promise<ClientOfferResult>) | undefined
  >(() => {
    const target = selectedChoice?.target
    if (!target || !handleOffer) return undefined
    return (sdpOffer, sessionId) => handleOffer(target, sdpOffer, sessionId)
  }, [handleOffer, selectedChoice])

  // Re-offer wrapper for adaptive tier switches. Unlike `playerHandleOffer`
  // (which binds the user-selected target), this carries the SERVER-chosen
  // downgrade target verbatim from `getSessionState`'s `pendingRenegotiation`
  // — the player hands it back here so the re-offer rebinds to the new tier.
  const playerReoffer = useMemo<
    | ((
        sessionId: string,
        sdpOffer: string,
        target: PlayerWebrtcTarget,
      ) => Promise<ClientOfferResult>)
    | undefined
  >(() => {
    if (!handleOffer) return undefined
    return (sessionId, sdpOffer, target) => handleOffer(target, sdpOffer, sessionId)
  }, [handleOffer])

  const visibleStreams = streams

  const handlePlay = () => setIsPlaying(true)
  const handleStop = () => setIsPlaying(false)

  const effectivePhase = pipelineMetrics?.phase ?? phase
  const isPhaseActive = effectivePhase === 'active'
  const hasDetections = !!detections
  const anyOverlay = hasDetections && (showDetections || showMotion)
  // The overlay renders when the caller marks PTZ as shown AND
  // supplies an overlay node. `ptzShown` is fully controlled — the
  // caller is the source of truth, so external surfaces (a floating
  // PTZ panel) and the in-header toggle can OR cleanly without
  // mirroring state.
  const ptzOverlayVisible = ptzAvailable && ptzShown && Boolean(ptzOverlay)
  // VOD mode wins over live: a `playbackUrl` swaps the live WebRTC player
  // for an HLS player and forces the video box visible (the play/stop
  // toggle governs live only).
  const isVod = Boolean(playbackUrl)
  const showingVideo = isVod || (showPlayStop ? isPlaying : true)

  return (
    <div
      className={`overflow-hidden ${chromeless ? '' : 'rounded-xl border border-border bg-surface'} ${className ?? ''}`}
    >
      {/* ── Header bar ─────────────────────────────────────────────────── */}
      {/* `flex-wrap` + a shrinkable left block are LOAD-BEARING: the root
          is `overflow-hidden`, so on a narrow (mobile) column a non-
          wrapping row would push the right-side action cluster (Play/
          Stop + kebab) past the right edge where it gets clipped — i.e.
          the controls silently disappear on phones while working on
          desktop's wider column. Wrapping drops the actions to a second
          row instead; `min-w-0` + `truncate` lets the device name yield
          space rather than shove them out. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border">
        {/* Left: device name + stream selector */}
        <div className="flex items-center gap-2 min-w-0">
          {(streamStats ?? choiceStats) && (
            <span
              className={`shrink-0 w-2 h-2 rounded-full ${statusDot((streamStats ?? choiceStats)!.status)}`}
            />
          )}
          {deviceName && (
            <span className="text-xs font-medium text-foreground truncate">{deviceName}</span>
          )}
          {/* Stream/quality selector — same position and styling for both
              live and VOD modes. In live mode shows the available stream
              profiles (Adaptive + high/mid/low). In VOD mode shows the
              HLS manifest levels reported by HlsVideo. Hidden when there
              is only one option (or none) in either mode. */}
          {!isVod && visibleStreams && visibleStreams.length > 1 && (
            <div className="relative">
              <select
                data-testid="stream-profile-select"
                value={effectiveStreamId}
                onChange={(e) => handleStreamChange(e.target.value)}
                className="appearance-none cursor-pointer rounded-md border border-border bg-surface-hover hover:bg-surface text-foreground text-[11px] font-medium pl-2 pr-6 py-1 focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
              >
                {visibleStreams.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-foreground-subtle">
                <svg
                  className="h-2.5 w-2.5"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 4.5 6 7.5 9 4.5" />
                </svg>
              </span>
            </div>
          )}
          {isVod && vodQuality.length > 1 && (
            <div className="relative">
              <select
                data-testid="vod-quality-select"
                value={vodLevel}
                onChange={(e) => setVodLevel(Number(e.target.value))}
                className="appearance-none cursor-pointer rounded-md border border-border bg-surface-hover hover:bg-surface text-foreground text-[11px] font-medium pl-2 pr-6 py-1 focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
              >
                {vodQuality.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-foreground-subtle">
                <svg
                  className="h-2.5 w-2.5"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 4.5 6 7.5 9 4.5" />
                </svg>
              </span>
            </div>
          )}
        </div>

        {/* Right: only the always-on actions (Intercom + Play/Stop) +
            kebab. Stats / Detect / Motion / PTZ / RefreshSnapshot all
            collapse into the kebab so the toolbar fits the narrowest
            stream-column width on every breakpoint. `shrink-0` keeps the
            buttons at full size; they wrap to a second row (header
            `flex-wrap`) before they'd ever be clipped on mobile. */}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          {/* Intercom toggle — when device advertises two-way audio.
              Always visible (label hides on narrow widths so the icon
              alone fits when the row gets cramped). */}
          {intercomAvailable && !isVod && (
            <button
              data-testid="stream-intercom-toggle"
              data-intercom-shown={intercomShown ? 'true' : 'false'}
              onClick={onIntercomToggle}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${intercomShown ? 'bg-primary/15 text-primary' : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover'}`}
              title={
                intercomShown
                  ? t('uiLibrary.streamPanel.closeIntercom', 'Close intercom')
                  : t('uiLibrary.streamPanel.openIntercom', 'Open intercom')
              }
            >
              <MicIcon className="h-3 w-3" />
              <span className="hidden xl:inline">
                {t('uiLibrary.streamPanel.intercom', 'Intercom')}
              </span>
            </button>
          )}

          {/* Toolbar buttons contributed by sibling tabs via the
              player-overlays registry. Same shell as the built-in
              Intercom button — registry entries pick their own icon,
              label, active flag and tone. */}
          {registeredButtons.map((b) => {
            const isPrimary = b.tone === 'primary'
            const activeCls = isPrimary
              ? 'bg-primary text-primary-foreground'
              : 'bg-primary/15 text-primary'
            const idleCls = 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
            return (
              <button
                key={b.id}
                type="button"
                data-toolbar-button-id={b.id}
                data-toolbar-button-active={b.active ? 'true' : 'false'}
                onClick={b.onClick}
                disabled={b.disabled}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${b.active ? activeCls : idleCls}`}
                title={b.title ?? b.label}
              >
                {b.icon}
                <span className="hidden xl:inline">{b.label}</span>
              </button>
            )
          })}

          {/* Play/Stop — always visible when showPlayStop is on. In VOD
              mode this same button returns to the live stream (the clip
              keeps playing until then). */}
          {showPlayStop && (
            <button
              data-testid="stream-play-toggle"
              data-stream-playing={showingVideo ? 'true' : 'false'}
              data-vod={isVod ? 'true' : 'false'}
              onClick={isVod ? onExitPlayback : showingVideo ? handleStop : handlePlay}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                isVod
                  ? 'bg-primary/10 text-primary hover:bg-primary/20'
                  : showingVideo
                    ? 'bg-danger/10 text-danger hover:bg-danger/20'
                    : 'bg-primary/10 text-primary hover:bg-primary/20'
              }`}
              title={
                isVod
                  ? t('uiLibrary.streamPanel.returnToLive', 'Return to live')
                  : showingVideo
                    ? t('uiLibrary.streamPanel.stopStream', 'Stop stream')
                    : t('uiLibrary.streamPanel.startStream', 'Start stream')
              }
            >
              {isVod ? (
                <LiveIcon className="h-3 w-3" />
              ) : showingVideo ? (
                <StopIcon className="h-3 w-3" />
              ) : (
                <PlayIcon className="h-3 w-3" />
              )}
              <span className="hidden xl:inline">
                {isVod
                  ? t('uiLibrary.streamPanel.live', 'Live')
                  : showingVideo
                    ? t('uiLibrary.streamPanel.stop', 'Stop')
                    : t('uiLibrary.streamPanel.play', 'Play')}
              </span>
            </button>
          )}

          {/* Force-snapshot — always visible when a refresh handler is
              wired. Independent of play state so the operator can warm
              the cached snapshot (used by the camera grid + zones tab)
              while still watching live video. */}
          {onRefreshSnapshot && !isVod && (
            <button
              data-testid="stream-snapshot-refresh"
              onClick={onRefreshSnapshot}
              disabled={snapshotLoading}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
              title={t('uiLibrary.streamPanel.forceRefresh', 'Force snapshot refresh')}
            >
              <RefreshIcon className={`h-3 w-3 ${snapshotLoading ? 'animate-spin' : ''}`} />
              <span className="hidden xl:inline">
                {t('uiLibrary.streamPanel.snapshot', 'Snapshot')}
              </span>
            </button>
          )}

          {/* Kebab — secondary controls (toggles, stats, snapshot
              refresh). Only renders when there's at least one
              secondary action to surface, so non-camera stream-less
              hosts don't get an empty button. */}
          {(hasDetections ||
            ptzAvailable ||
            pipelineMetrics ||
            effectivePhase ||
            streamStats ||
            (choiceStats && choiceStats.inputFps > 0)) && (
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                title={t('uiLibrary.streamPanel.moreControls', 'More controls')}
                className="inline-flex items-center justify-center rounded-md p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                <MoreIcon className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 min-w-[200px] rounded-lg border border-border bg-surface shadow-xl py-1.5">
                  {/* Stats */}
                  {showStreamStats && streamStats && (
                    <div className="px-3 py-1.5 text-[10px] text-foreground-subtle border-b border-border-subtle">
                      <div className="flex justify-between gap-3">
                        <span>{t('uiLibrary.streamPanel.input', 'Input')}</span>
                        <span className="tabular-nums text-foreground">
                          {/* i18n-ignore: unit */}
                          {streamStats.inputFps.toFixed(1)} fps
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span>{t('uiLibrary.streamPanel.uptime', 'Uptime')}</span>
                        <span className="tabular-nums text-foreground">
                          {fmtUptime(streamStats.uptimeMs)}
                        </span>
                      </div>
                    </div>
                  )}
                  {!showStreamStats && choiceStats && choiceStats.inputFps > 0 && (
                    <div className="px-3 py-1.5 text-[10px] text-foreground-subtle border-b border-border-subtle">
                      <div className="flex justify-between gap-3">
                        <span>{t('uiLibrary.streamPanel.input', 'Input')}</span>
                        <span className="tabular-nums text-foreground">
                          {/* i18n-ignore: unit */}
                          {choiceStats.inputFps.toFixed(1)} fps
                        </span>
                      </div>
                      {choiceStats.bitrateKbps > 0 && (
                        <div className="flex justify-between gap-3">
                          <span>{t('uiLibrary.streamPanel.bitrate', 'Bitrate')}</span>
                          <span className="tabular-nums text-foreground">
                            {/* i18n-ignore: unit */}
                            {choiceStats.bitrateKbps} kbps
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Phase */}
                  {(pipelineMetrics || (hasDetections && effectivePhase)) && (
                    <div className="px-3 py-1.5 text-[10px] text-foreground-subtle border-b border-border-subtle">
                      <div className="flex justify-between gap-3 items-center">
                        <span>{t('uiLibrary.streamPanel.phase', 'Phase')}</span>
                        <span
                          className={`flex items-center gap-1 font-semibold uppercase tracking-wider ${isPhaseActive ? 'text-red-400' : 'text-emerald-400'}`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${isPhaseActive ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`}
                          />
                          {isPhaseActive
                            ? t('uiLibrary.streamPanel.active', 'Active')
                            : t('uiLibrary.streamPanel.watching', 'Watching')}
                        </span>
                      </div>
                      {pipelineMetrics && pipelineMetrics.detectionFps > 0 && (
                        <div className="flex justify-between gap-3">
                          <span>{t('uiLibrary.streamPanel.detection', 'Detection')}</span>
                          <span className="tabular-nums text-foreground">
                            {pipelineMetrics.detectionFps.toFixed(1)} det/s
                          </span>
                        </div>
                      )}
                      {pipelineMetrics && pipelineMetrics.avgInferenceMs > 0 && (
                        <div className="flex justify-between gap-3">
                          <span>{t('uiLibrary.streamPanel.inference', 'Inference')}</span>
                          <span className="tabular-nums text-foreground">
                            {pipelineMetrics.avgInferenceMs.toFixed(0)} ms
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Toggles */}
                  {hasDetections && (
                    <>
                      <MenuToggle
                        label={t('uiLibrary.streamPanel.showDetections', 'Show detections')}
                        active={showDetections}
                        onClick={() => setShowDetections((v) => !v)}
                      />
                      {/* Nested under the master switch: with detections off
                          these two decide nothing, and offering them anyway
                          would let an operator turn both on and still see an
                          empty frame. */}
                      {showDetections && (
                        <>
                          <MenuToggle
                            label={t('uiLibrary.streamPanel.moving', '…moving')}
                            active={showMoving}
                            onClick={() => setShowMoving((v) => !v)}
                          />
                          <MenuToggle
                            label={t('uiLibrary.streamPanel.stationary', '…stationary')}
                            active={showStationary}
                            onClick={() => setShowStationary((v) => !v)}
                          />
                        </>
                      )}
                      <MenuToggle
                        label={t('uiLibrary.streamPanel.showMotion', 'Show motion')}
                        active={showMotion}
                        onClick={() => setShowMotion((v) => !v)}
                      />
                    </>
                  )}
                  {ptzAvailable && (
                    <MenuToggle
                      label={t('uiLibrary.streamPanel.ptzControls', 'PTZ controls')}
                      active={ptzShown}
                      onClick={() => {
                        onPtzToggle?.()
                        setMenuOpen(false)
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Video area ─────────────────────────────────────────────────── */}
      {playbackUrl ? (
        <div className="aspect-video relative">
          <HlsVideo
            url={playbackUrl}
            {...(playbackFormat ? { format: playbackFormat } : {})}
            authToken={playbackAuthToken ?? null}
            onQualityOptions={handleVodQualityOptions}
            selectedLevel={vodLevel}
            {...(posterUrl ? { posterUrl } : {})}
          />
          {extraOverlay || ptzOverlayVisible ? (
            <>
              {extraOverlay}
              {ptzOverlayVisible && ptzOverlay}
            </>
          ) : null}
        </div>
      ) : showingVideo && serverUrl ? (
        <div className="aspect-video relative">
          {/* Deliberately NOT keyed on the stream id: a `streamKey` change drives
              the player's SEAMLESS in-place switch (make-before-break); a remount
              would tear the PeerConnection down and pay a full cold connect. */}
          <CameraStreamPlayer
            serverUrl={serverUrl}
            streamKey={effectiveStreamId}
            autoPlay
            className="w-full h-full"
            createSession={playerCreateSession}
            sendAnswer={sendAnswer}
            handleOffer={playerHandleOffer}
            reoffer={playerReoffer}
            getSessionState={getSessionState}
            {...(getSessionDebug ? { getSessionDebug } : {})}
            {...(applyDownlinkProbe ? { applyDownlinkProbe } : {})}
            getIceServers={getIceServers}
            addIceCandidate={addIceCandidate}
            getIceCandidates={getIceCandidates}
            closeSession={closeSession}
            {...(recordedPlayback.bindControlChannel
              ? { onControlChannel: recordedPlayback.bindControlChannel }
              : {})}
            {...(posterUrl ? { posterUrl } : {})}
            overlay={
              anyOverlay || extraOverlay || ptzOverlayVisible ? (
                <>
                  {anyOverlay && (
                    <DetectionOverlay
                      detections={detections!}
                      showPhaseIndicator={false}
                      showMotionZones={showMotion}
                      showMotionRaw={showMotion}
                      showDetections={showDetections}
                      showMoving={showMoving}
                      showStationary={showStationary}
                      {...(stationaryObjects !== undefined ? { stationaryObjects } : {})}
                    />
                  )}
                  {extraOverlay}
                  {ptzOverlayVisible && ptzOverlay}
                </>
              ) : undefined
            }
          />
        </div>
      ) : (
        <SnapshotPreview
          src={snapshotSrc ?? null}
          isLoading={snapshotLoading}
          onPlay={handlePlay}
          onRetry={onRefreshSnapshot}
          // Layered overlays (zones, PTZ) ride on top of the snapshot too,
          // so the operator can edit zones while the live stream is paused.
          // When at least one overlay is registered we suppress the
          // click-to-play hover layer — otherwise it would steal pointer
          // events from the Konva stage. The toolbar Play button stays
          // wired regardless.
          extraOverlay={
            extraOverlay || ptzOverlayVisible ? (
              <>
                {extraOverlay}
                {ptzOverlayVisible && ptzOverlay}
              </>
            ) : null
          }
          suppressPlayHover={Boolean(extraOverlay) || ptzOverlayVisible}
        />
      )}

      {children}
    </div>
  )
}

// ── SnapshotPreview ──────────────────────────────────────────────────────────

function SnapshotPreview({
  src,
  isLoading,
  onPlay,
  onRetry,
  extraOverlay,
  suppressPlayHover = false,
}: {
  readonly src: string | null
  readonly isLoading: boolean
  readonly onPlay: () => void
  readonly onRetry?: () => void
  /** Layered overlays (zones, PTZ, …) painted on top of the still
   *  image so editing surfaces stay usable while paused. */
  readonly extraOverlay?: ReactNode
  /** Hide the click-to-play hover button — used when an overlay is
   *  active so it doesn't steal pointer events from Konva-style
   *  stages. The toolbar Play button stays available. */
  readonly suppressPlayHover?: boolean
}) {
  const t = useUiText()
  // Keep the last-known image visible while a refresh is in flight.
  // The header refresh button already shows a spinner — flashing the
  // viewport to a full-screen loader on every refetch makes the page
  // feel broken, especially on the 30s grid polls. The black-screen
  // loader only appears on a TRUE cold start (no cached image yet).
  if (src) {
    return (
      <div className="relative w-full aspect-video bg-black/90 flex items-center justify-center">
        <img
          src={src}
          alt={t('uiLibrary.streamPanel.cameraSnapshot', 'Camera snapshot')}
          className="w-full h-full object-contain"
        />
        {!suppressPlayHover && (
          <button
            onClick={onPlay}
            className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 hover:opacity-100 transition-opacity cursor-pointer"
          >
            <div className="h-14 w-14 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
              <PlayIcon className="h-7 w-7 text-white ml-0.5" />
            </div>
          </button>
        )}
        {extraOverlay}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="relative w-full aspect-video bg-black/90 flex items-center justify-center">
        <div className="h-8 w-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="relative w-full aspect-video bg-black/90 flex items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-white/40">
        <ImageOffIcon className="h-8 w-8" />
        <span className="text-xs">
          {t('uiLibrary.streamPanel.noSnapshot', 'No snapshot available')}
        </span>
        <div className="flex items-center gap-2 mt-1">
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-1.5 text-xs font-medium text-white/60 hover:text-white hover:border-white/40 transition-colors"
            >
              <RefreshIcon className="h-3 w-3" />
              {t('uiLibrary.streamPanel.retry', 'Retry')}
            </button>
          )}
          <button
            onClick={onPlay}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary transition-colors"
          >
            <PlayIcon className="h-3 w-3" />
            {t('uiLibrary.streamPanel.playLive', 'Play Live')}
          </button>
        </div>
      </div>
    </div>
  )
}
