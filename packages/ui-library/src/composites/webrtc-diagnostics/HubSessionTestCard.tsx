/**
 * "Hub session test" — a real live session from THIS browser to the hub,
 * through the same `CameraStreamPlayer` + `useDeviceWebrtc` signaling every
 * viewer uses, run twice: browser ICE policy `all`, then `relay`.
 *
 * Nothing is simulated. The player's own client-offer path builds the offer,
 * trickles, polls the hub's candidates, and reports its 1 Hz
 * `StreamDebugSample` (the `webrtc-debug-stats` collector plus the server's
 * `getSessionDebug`). This card only LISTENS: it wraps the signaling callbacks
 * to see the hub's answer SDP and trickled candidates, and adds listeners to
 * each peer connection the player builds (`onPeerConnection`) for the ICE /
 * DTLS timeline and the browser's own candidates. The target is pinned (a low
 * or sub stream by default) so a large keyframe does not decide the verdict.
 */
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { Activity, Loader2, Play, Square } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UseDeviceWebrtcTrpc, WebrtcTarget } from '../../hooks/use-device-webrtc'
import { useDeviceWebrtc } from '../../hooks/use-device-webrtc'
import { GRID_PAIRED, GRID_GAP, LIST_ROW, SECTION_BODY, TEXT_HINT } from '../../lib/responsive'
import { Button } from '../../primitives/button'
import { Select } from '../../primitives/select'
import { CameraStreamPlayer, type ClientStreamHints } from '../camera-stream-player'
import { SectionCard } from '../section-card'
import type { StreamChoice } from '../stream-panel'
import type { StreamDebugSample } from '../stream-debug/webrtc-debug-stats'
import { probedCandidateFromEvent } from './endpoint-probe'
import { RunReport } from './RunReport'
import {
  emptySessionRun,
  finalizeSessionRun,
  type HubSessionRunReport,
  reduceSessionRun,
  type SessionRunEvent,
  type SessionRunState,
} from './session-run'
import type { DiagnosticIcePolicy } from './session-verdict'

export interface HubSessionTestCardProps {
  readonly trpc: UseDeviceWebrtcTrpc
  /** The hub base URL the player talks to (the adaptive probe origin). */
  readonly serverUrl: string
  /** The camera under test; null until the host picked one. */
  readonly deviceId: number | null
  /** The host's camera picker, drawn at the top of the card. */
  readonly cameraField?: ReactNode
  /** Length of each run. */
  readonly runMs?: number
}

export const HUB_SESSION_RUN_MS = 15_000
const POLICIES: readonly DiagnosticIcePolicy[] = ['all', 'relay']
/** Between runs, so the first session is closed on the hub before the second opens. */
const RUN_GAP_MS = 750
const PROGRESS_TICK_MS = 500

/** Pinned targets only, cheapest first: an adaptive target would climb mid-run. */
export function pinnedStreamChoices(streams: readonly StreamChoice[]): readonly StreamChoice[] {
  const rank = (s: StreamChoice): number => {
    const t = s.target
    if (t.kind === 'profile') return t.profile === 'low' ? 0 : t.profile === 'mid' ? 2 : 3
    if (t.kind === 'cam-stream') return /sub|low|ext/i.test(t.camStreamId) ? 1 : 4
    return 9
  }
  return streams.filter((s) => s.target.kind !== 'adaptive').toSorted((a, b) => rank(a) - rank(b))
}

function policyLabel(t: UiTextFn, policy: DiagnosticIcePolicy): string {
  switch (policy) {
    case 'all':
      return t('uiLibrary.hubSessionTest.policyAll', 'ICE policy all')
    case 'relay':
      return t('uiLibrary.hubSessionTest.policyRelay', 'ICE policy relay (TURN only)')
  }
}

interface LiveRun {
  readonly index: number
  readonly policy: DiagnosticIcePolicy
  readonly token: number
}

export function HubSessionTestCard({
  trpc,
  serverUrl,
  deviceId,
  cameraField,
  runMs = HUB_SESSION_RUN_MS,
}: HubSessionTestCardProps): ReactNode {
  const t = useUiText()
  // A late translator must not restart a run in flight: the timer reads it here.
  const tRef = useRef(t)
  tRef.current = t
  const webrtc = useDeviceWebrtc(trpc, deviceId)
  const choices = useMemo(() => pinnedStreamChoices(webrtc.streams), [webrtc.streams])
  const [choiceId, setChoiceId] = useState<string | null>(null)
  const choice = choices.find((c) => c.id === choiceId) ?? choices[0] ?? null

  const [live, setLive] = useState<LiveRun | null>(null)
  const [reports, setReports] = useState<readonly HubSessionRunReport[]>([])
  const [elapsedMs, setElapsedMs] = useState(0)
  /** True from Run until the last policy reported or Stop — the gap between runs included. */
  const [active, setActive] = useState(false)
  const stateRef = useRef<SessionRunState>(emptySessionRun('all'))
  const t0Ref = useRef(0)
  const tokenRef = useRef(0)
  const gapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const elapsed = useCallback((): number => Math.round(performance.now() - t0Ref.current), [])

  /** Fold one observation into the CURRENT run; a late event from a closed run is dropped. */
  const record = useCallback((token: number, event: SessionRunEvent): void => {
    if (token !== tokenRef.current) return
    stateRef.current = reduceSessionRun(stateRef.current, event)
  }, [])

  const stop = useCallback(() => {
    tokenRef.current += 1
    if (gapTimerRef.current !== null) clearTimeout(gapTimerRef.current)
    gapTimerRef.current = null
    setLive(null)
    setActive(false)
  }, [])

  const startRun = useCallback((index: number) => {
    const policy = POLICIES[index]
    if (policy === undefined) return
    tokenRef.current += 1
    stateRef.current = emptySessionRun(policy)
    t0Ref.current = performance.now()
    setElapsedMs(0)
    setLive({ index, policy, token: tokenRef.current })
  }, [])

  // One run: let the player live `runMs`, fold the report, unmount it (which
  // closes the hub session), then open the next policy after a short gap.
  useEffect(() => {
    if (live === null) return
    const tick = setInterval(() => setElapsedMs(elapsed()), PROGRESS_TICK_MS)
    const done = setTimeout(() => {
      const report = finalizeSessionRun(stateRef.current, elapsed(), tRef.current)
      setReports((prev) => [...prev, report])
      tokenRef.current += 1
      setLive(null)
      const next = live.index + 1
      if (next < POLICIES.length) gapTimerRef.current = setTimeout(() => startRun(next), RUN_GAP_MS)
      else setActive(false)
    }, runMs)
    return () => {
      clearInterval(tick)
      clearTimeout(done)
    }
  }, [live, runMs, elapsed, startRun])

  useEffect(
    () => () => {
      tokenRef.current += 1
      if (gapTimerRef.current !== null) clearTimeout(gapTimerRef.current)
    },
    [],
  )

  const start = useCallback(() => {
    setReports([])
    setActive(true)
    startRun(0)
  }, [startRun])

  const target: WebrtcTarget | null = choice?.target ?? null
  const token = live?.token ?? -1

  // Signaling, wrapped per run so what the hub answered lands in THAT run.
  const handleOffer = useCallback(
    async (sdpOffer: string, sessionId?: string, hints?: ClientStreamHints) => {
      if (target === null) throw new Error('no stream selected')
      const res = await webrtc.handleOffer(target, sdpOffer, sessionId, hints)
      record(token, {
        kind: 'offer-answered',
        at: elapsed(),
        sessionId: res.sessionId,
        sdpAnswer: res.sdpAnswer,
      })
      return res
    },
    [target, webrtc, record, token, elapsed],
  )
  const getIceCandidates = useCallback(
    async (sessionId: string) => {
      const res = await webrtc.getIceCandidates(sessionId)
      record(token, {
        kind: 'hub-candidates',
        at: elapsed(),
        candidates: res.candidates.map((c) => c.candidate ?? '').filter((c) => c.length > 0),
        done: res.done,
      })
      return res
    },
    [webrtc, record, token, elapsed],
  )
  const onPeerConnection = useCallback(
    (pc: RTCPeerConnection) => {
      const seen = new WeakSet<RTCDtlsTransport>()
      pc.addEventListener('iceconnectionstatechange', () =>
        record(token, { kind: 'ice-state', at: elapsed(), state: pc.iceConnectionState }),
      )
      pc.addEventListener('connectionstatechange', () =>
        record(token, { kind: 'peer-state', at: elapsed(), state: pc.connectionState }),
      )
      pc.addEventListener('icecandidate', (e: RTCPeerConnectionIceEvent) => {
        const probed = probedCandidateFromEvent(e, elapsed())
        if (probed === null) return
        record(token, {
          kind: 'local-candidate',
          at: probed.tMs,
          candidate: probed.candidate.raw,
          url: probed.url,
          relayProtocol: probed.relayProtocol,
        })
      })
      pc.addEventListener('track', (e: RTCTrackEvent) => {
        const transport = e.receiver.transport
        if (transport === null || seen.has(transport)) return
        seen.add(transport)
        record(token, { kind: 'dtls-state', at: elapsed(), state: transport.state })
        transport.addEventListener('statechange', () =>
          record(token, { kind: 'dtls-state', at: elapsed(), state: transport.state }),
        )
      })
    },
    [record, token, elapsed],
  )
  const onDebugStats = useCallback(
    (sample: StreamDebugSample) => record(token, { kind: 'sample', at: elapsed(), sample }),
    [record, token, elapsed],
  )
  const onConnectTiming = useCallback(
    (timing: Record<string, number>) => {
      if (timing['firstFrameMs'] !== undefined)
        record(token, { kind: 'first-frame', at: elapsed() })
    },
    [record, token, elapsed],
  )

  const progress = live === null ? null : Math.min(100, Math.round((elapsedMs / runMs) * 100))
  const canRun = deviceId !== null && choice !== null && !active

  return (
    <SectionCard
      headingId="webrtc-diag-hub-session"
      title={t('uiLibrary.hubSessionTest.title', 'Hub session test')}
      icon={Activity}
      testId="webrtc-diag-hub-session"
      actions={
        !active ? (
          <Button onClick={start} disabled={!canRun}>
            <Play className="h-3 w-3" />
            {t('uiLibrary.hubSessionTest.run', 'Run test ({{seconds}} s)', {
              seconds: Math.round((runMs * POLICIES.length) / 1000),
            })}
          </Button>
        ) : (
          <Button variant="outline" onClick={stop}>
            <Square className="h-3 w-3" />
            {t('uiLibrary.hubSessionTest.stop', 'Stop')}
          </Button>
        )
      }
    >
      <div className={`${SECTION_BODY} space-y-3`}>
        <div className={`grid grid-cols-1 sm:grid-cols-2 ${GRID_GAP}`}>
          {cameraField}
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] text-foreground-subtle">
              {t('uiLibrary.hubSessionTest.stream', 'Stream (pinned)')}
            </span>
            <Select
              value={choice?.id ?? ''}
              disabled={choices.length === 0 || active}
              onChange={(e) => setChoiceId(e.target.value)}
              options={
                choices.length === 0
                  ? [
                      {
                        value: '',
                        label:
                          deviceId === null
                            ? t('uiLibrary.hubSessionTest.pickCamera', 'Pick a camera first')
                            : t('uiLibrary.hubSessionTest.noStream', 'No pinned stream'),
                      },
                    ]
                  : choices.map((c) => ({ value: c.id, label: c.label }))
              }
            />
          </label>
        </div>
        <p className={TEXT_HINT}>
          {t(
            'uiLibrary.hubSessionTest.hint',
            'Opens a real live session from this browser twice — first with every candidate type, then TURN relay only — and reads both ends of it.',
          )}
        </p>

        {live !== null && deviceId !== null && choice !== null && (
          <div
            className={`grid grid-cols-1 sm:grid-cols-[minmax(0,16rem)_1fr] ${GRID_GAP} items-start`}
          >
            <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
              <CameraStreamPlayer
                key={`${String(live.token)}-${live.policy}`}
                serverUrl={serverUrl}
                streamKey={`diag-${choice.id}-${live.policy}`}
                autoPlay
                muted
                showControls={false}
                className="h-full w-full"
                handleOffer={handleOffer}
                getIceServers={webrtc.getIceServers}
                addIceCandidate={webrtc.addIceCandidate}
                getIceCandidates={getIceCandidates}
                closeSession={webrtc.closeSession}
                getSessionDebug={webrtc.getSessionDebug}
                applyDownlinkProbe={webrtc.applyDownlinkProbe}
                iceTransportPolicy={live.policy}
                onPeerConnection={onPeerConnection}
                onDebugStats={onDebugStats}
                onConnectTiming={onConnectTiming}
                onReconnectAttempt={() => record(token, { kind: 'reconnect', at: elapsed() })}
                onError={(message) => record(token, { kind: 'error', at: elapsed(), message })}
              />
            </div>
            <div className="space-y-1.5" data-testid="webrtc-diag-progress">
              <div className="flex items-center gap-2 text-xs text-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('uiLibrary.hubSessionTest.progress', 'Run {{index}} of {{total}} · {{policy}}', {
                  index: live.index + 1,
                  total: POLICIES.length,
                  policy: policyLabel(t, live.policy),
                })}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-surface-hover">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${String(progress ?? 0)}%` }}
                />
              </div>
              <div className={TEXT_HINT}>
                {t('uiLibrary.hubSessionTest.elapsed', '{{elapsed}} s of {{total}} s', {
                  elapsed: Math.round(elapsedMs / 1000),
                  total: Math.round(runMs / 1000),
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {reports.length > 0 && (
        <div className={`grid ${GRID_PAIRED} ${GRID_GAP} border-t border-border p-2 sm:p-3`}>
          {reports.map((r, i) => (
            <RunReport
              key={`${String(i)}-${r.policy}`}
              report={r}
              title={t('uiLibrary.hubSessionTest.runTitle', 'Run {{index}} · {{policy}}', {
                index: i + 1,
                policy: policyLabel(t, r.policy),
              })}
            />
          ))}
        </div>
      )}
      {reports.length === 0 && !active && (
        <div className={`${LIST_ROW} border-t border-border ${TEXT_HINT}`}>
          {t('uiLibrary.hubSessionTest.noRun', 'No run yet.')}
        </div>
      )}
    </SectionCard>
  )
}
