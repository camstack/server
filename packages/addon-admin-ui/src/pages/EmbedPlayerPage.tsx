/**
 * EmbedPlayerPage — login-bypassing, chrome-less live WebRTC player.
 *
 * Rendered at `/embed/player` OUTSIDE the ProtectedRoute/AppLayout tree
 * (see `App.tsx`). It exists to be loaded inside a native iOS WKWebView:
 * WebKit's WebRTC stack decodes H.265, which the React-Native app's
 * native libwebrtc cannot, so the native app draws its own chrome and
 * hosts this page purely as the video surface.
 *
 * Auth comes from a JWT injected by the WebView (NOT from a login form):
 * the native side sets `window.__CAMSTACK_EMBED__` BEFORE the page loads.
 * We build a fresh `System` SDK from that `{ serverUrl, token }` — the
 * same client the admin shell uses — and reuse the REAL ui-library
 * client-offer player (`CameraStreamPlayer` + `useDeviceWebrtc`); we do
 * NOT hand-roll any WebRTC signaling.
 *
 * Contract (fixed — the WebView side depends on it exactly):
 *   IN  (set before load):  window.__CAMSTACK_EMBED__ = { serverUrl, token, deviceId, target, muted }
 *   OUT (every state change): window.ReactNativeWebView?.postMessage(JSON.stringify({ type:'state', state, message? }))
 *   IN  (once mounted):     window.__camstackEmbed = { setMuted(b), setTarget(t) }
 */
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  applyFleetQueryDefaults,
  SystemProvider,
  trpc,
  CameraStreamPlayer,
  useDeviceWebrtc,
  type ClientOfferResult,
  type PlayerConnectionState,
  type PlayerWebrtcTarget,
  type WebrtcTarget,
} from '@camstack/ui-library'
import { createSystem, type System } from '@camstack/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CamProfileSchema } from '@camstack/types'
import { useTranslation } from 'react-i18next'

// ── Injected-config contract (validated at the boundary) ───────────────────

/**
 * WebRTC target the native app wants to view. Mirrors the cap's
 * `WebrtcTarget` (`adaptive` | `profile`) — `cam-stream` is intentionally
 * NOT part of the embed contract (the native app only ever asks for an
 * adaptive or a named profile tier).
 */
const embedTargetSchema = z.union([
  z.object({ kind: z.literal('adaptive') }),
  z.object({ kind: z.literal('profile'), profile: CamProfileSchema }),
])

const embedConfigSchema = z.object({
  serverUrl: z.string().min(1),
  token: z.string().min(1),
  deviceId: z.number().int().nonnegative(),
  target: embedTargetSchema,
  muted: z.boolean(),
})

type EmbedConfig = z.infer<typeof embedConfigSchema>
type EmbedTarget = z.infer<typeof embedTargetSchema>

// ── Outbound state contract (page → WebView) ───────────────────────────────

type EmbedReportState = 'connecting' | 'playing' | 'error'

interface EmbedStateMessage {
  readonly type: 'state'
  readonly state: EmbedReportState
  readonly message?: string
}

declare global {
  interface Window {
    __CAMSTACK_EMBED__?: unknown
    __camstackEmbed?: {
      setMuted: (muted: boolean) => void
      setTarget: (target: EmbedTarget) => void
    }
    ReactNativeWebView?: {
      postMessage: (message: string) => void
    }
  }
}

/** Post a state transition to the hosting WebView (best-effort, no-op outside RN). */
function postState(state: EmbedReportState, message?: string): void {
  const payload: EmbedStateMessage =
    message !== undefined ? { type: 'state', state, message } : { type: 'state', state }
  window.ReactNativeWebView?.postMessage(JSON.stringify(payload))
}

/**
 * Map the player's richer connection state onto the 3-state embed contract.
 * `disconnected` (a recoverable blip the player auto-reconnects from) and the
 * cold-start `idle` both surface as `connecting` so the native app shows a
 * spinner rather than a hard error during a transient drop.
 */
function toReportState(state: PlayerConnectionState): EmbedReportState {
  switch (state) {
    case 'playing':
      return 'playing'
    case 'error':
      return 'error'
    case 'connecting':
    case 'disconnected':
    case 'idle':
      return 'connecting'
  }
}

/** The embed target translated into the player/hook's `WebrtcTarget` union. */
function toWebrtcTarget(target: EmbedTarget): WebrtcTarget {
  return target.kind === 'adaptive'
    ? { kind: 'adaptive' }
    : { kind: 'profile', profile: target.profile }
}

/** Stable React key + opaque player streamKey for a target (forces remount on switch). */
function targetKey(target: EmbedTarget): string {
  return target.kind === 'adaptive' ? 'embed:adaptive' : `embed:profile:${target.profile}`
}

// ── Config reader ───────────────────────────────────────────────────────────

interface ConfigReadOk {
  readonly ok: true
  readonly config: EmbedConfig
}
interface ConfigReadErr {
  readonly ok: false
  readonly error: string
}
type ConfigReadResult = ConfigReadOk | ConfigReadErr

function readEmbedConfig(): ConfigReadResult {
  const raw = window.__CAMSTACK_EMBED__
  if (raw === undefined || raw === null) {
    return { ok: false, error: 'window.__CAMSTACK_EMBED__ is not set' } // i18n-ignore: names a window global, shown verbatim
  }
  const parsed = embedConfigSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    }
  }
  return { ok: true, config: parsed.data }
}

// ── Error state ──────────────────────────────────────────────────────────────

function EmbedError({ message }: { message: string }) {
  const { t } = useTranslation()
  // Surface the error to the native app too — a missing/invalid config means
  // the player will never reach `connecting`, so without this the WebView
  // would hang on its own spinner forever.
  useEffect(() => {
    postState('error', message)
  }, [message])
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000',
        color: '#f87171',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
        padding: 16,
        textAlign: 'center',
      }}
    >
      {t('embedPlayerPage.embedConfigError', 'Embed config error:')} {message}
    </div>
  )
}

// ── Player (inside the System/tRPC providers) ────────────────────────────────

interface EmbedPlayerProps {
  readonly system: System
  readonly deviceId: number
  readonly initialTarget: EmbedTarget
  readonly initialMuted: boolean
}

function EmbedPlayer({ system, deviceId, initialTarget, initialMuted }: EmbedPlayerProps) {
  const [target, setTarget] = useState<EmbedTarget>(initialTarget)
  const [muted, setMuted] = useState(initialMuted)

  // Real client-offer signaling — the SAME hook the admin shell uses. No
  // hand-rolled WebRTC anywhere; the hook talks to the `webrtc-session` cap
  // over the token-authenticated tRPC client.
  const {
    handleOffer,
    getIceServers,
    addIceCandidate,
    getIceCandidates,
    closeSession,
    getSessionState,
    getSessionDebug,
    applyDownlinkProbe,
  } = useDeviceWebrtc(system.trpcClient, deviceId)

  const webrtcTarget = useMemo<WebrtcTarget>(() => toWebrtcTarget(target), [target])

  // Bind the selected target into the player's target-agnostic callbacks —
  // mirrors StreamPanel: the player ships only an SDP offer, we close over
  // the target. `reoffer` carries the SERVER-chosen downgrade target verbatim
  // (adaptive re-offer), so it does NOT close over `webrtcTarget`.
  const playerHandleOffer = useMemo(
    () =>
      (sdpOffer: string, sessionId?: string): Promise<ClientOfferResult> =>
        handleOffer(webrtcTarget, sdpOffer, sessionId),
    [handleOffer, webrtcTarget],
  )
  const playerReoffer = useMemo(
    () =>
      (
        sessionId: string,
        sdpOffer: string,
        reofferTarget: PlayerWebrtcTarget,
      ): Promise<ClientOfferResult> =>
        handleOffer(reofferTarget, sdpOffer, sessionId),
    [handleOffer],
  )

  // Expose the WebView → page control surface once mounted. `setTarget`
  // re-points the stream (the changed `streamKey`/`key` remounts the player
  // against the new tier); `setMuted` toggles the <video> via the muted prop.
  useEffect(() => {
    window.__camstackEmbed = {
      setMuted: (next) => setMuted(next),
      setTarget: (next) => {
        const parsed = embedTargetSchema.safeParse(next)
        if (parsed.success) setTarget(parsed.data)
      },
    }
    return () => {
      if (window.__camstackEmbed) delete window.__camstackEmbed
    }
  }, [])

  const key = targetKey(target)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        background: '#000',
      }}
    >
      <CameraStreamPlayer
        key={key}
        serverUrl={system.serverUrl}
        streamKey={key}
        autoPlay
        muted={muted}
        // The native app draws its own chrome — no toolbar/overlay/controls.
        showControls={false}
        className="w-full h-full"
        getSessionDebug={getSessionDebug}
        applyDownlinkProbe={applyDownlinkProbe}
        handleOffer={playerHandleOffer}
        reoffer={playerReoffer}
        getSessionState={getSessionState}
        getIceServers={getIceServers}
        addIceCandidate={addIceCandidate}
        getIceCandidates={getIceCandidates}
        closeSession={closeSession}
        onStateChange={(s) => postState(toReportState(s))}
        onError={(message) => postState('error', message)}
      />
    </div>
  )
}

// ── Page entry ───────────────────────────────────────────────────────────────

export function EmbedPlayerPage() {
  const { t } = useTranslation()
  // Read + validate the injected config ONCE on mount. The native side sets it
  // before the page loads, so it's available synchronously here.
  const configResult = useMemo<ConfigReadResult>(() => readEmbedConfig(), [])

  // Build the SDK + a dedicated React-Query client from the injected token,
  // the same way `AppShell` seeds its providers — but keyed off the injected
  // `{ serverUrl, token }` instead of localStorage + auth context. Torn down
  // on unmount so the WebSocket doesn't leak when the WebView navigates away.
  const built = useMemo(() => {
    if (!configResult.ok) return null
    const system = createSystem({
      serverUrl: configResult.config.serverUrl,
      token: configResult.config.token,
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    })
    applyFleetQueryDefaults(queryClient)
    return { system, queryClient }
  }, [configResult])

  useEffect(() => {
    if (!built) return
    return () => {
      built.system.close()
    }
  }, [built])

  if (!configResult.ok) {
    return <EmbedError message={configResult.error} />
  }
  if (!built) {
    return (
      <EmbedError
        message={t(
          'embedPlayerPage.failedToInitialiseTheEmbed',
          'Failed to initialise the embed player',
        )}
      />
    )
  }

  return (
    <SystemProvider system={built.system}>
      <QueryClientProvider client={built.queryClient}>
        <trpc.Provider client={built.system.trpcClient} queryClient={built.queryClient}>
          <EmbedPlayer
            system={built.system}
            deviceId={configResult.config.deviceId}
            initialTarget={configResult.config.target}
            initialMuted={configResult.config.muted}
          />
        </trpc.Provider>
      </QueryClientProvider>
    </SystemProvider>
  )
}
