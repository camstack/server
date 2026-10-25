import { useState, type ReactNode } from 'react'
import { UiTrans, useUiText, type UiTextFn } from '../../contexts/ui-text.js'
import type { WebrtcSessionDebug } from '@camstack/types'
import {
  freezeVerdict,
  type FreezeVerdictKind,
  type WebrtcDebugStats,
} from './webrtc-debug-stats.js'

// i18n-ignore-start: the overlay prints WebRTC statistics, whose field names (rtt, jitter, ice, dtls, ...) are protocol vocabulary shown verbatim

/**
 * The stream-debug overlay: the CLIENT's transport measurements next to what
 * the SERVER decided, over the live picture.
 *
 * Three things about this surface are requirements, not styling:
 *
 *  1. It must be legible over a FROZEN picture. The panel is opaque, not a
 *     wash — a translucent overlay on a stuck bright frame is unreadable
 *     exactly when it is needed.
 *  2. Every number says WHEN it was measured. Two independent clocks feed
 *     this (a 1 s `getStats()` poll and a 1 s server poll) and either can
 *     stop. A stale poll that looks live is how a debug tool lies.
 *  3. An UNKNOWN value renders as `—`, and a measured zero renders as `0`
 *     (D393). In a tool whose whole job is telling a stalled decoder from a
 *     stalled transport, "nobody measured" and "measured nothing" are
 *     opposite conclusions.
 *  4. It must not cover the picture, or the operator turns it off and the tool
 *     is worth nothing. So it is a one-line PILL by default — the verdict and
 *     the three numbers that carry it — and the full panel only when asked.
 *     Collapsed it is small enough to live alongside the app's own overlays
 *     (the audio meter, the box layer), which the operator positions freely
 *     and which this used to sit on top of.
 *
 * Density follows from the same rule: a cumulative counter and its window
 * share ONE row (`12345 +30`), because two rows saying almost the same thing
 * is how a panel grows until it covers the video it is describing.
 */
export interface StreamDebugOverlayProps {
  /** The client half. Null before the first successful poll. */
  readonly stats: WebrtcDebugStats | null
  /** The server half. Null when not wired, or before the first answer. */
  readonly server: WebrtcSessionDebug | null
  /** Why the last server poll produced nothing. Shown verbatim. */
  readonly serverError: string | null
  /** Whether a server poll is wired at all (vs. simply not configured). */
  readonly serverWired: boolean
  /** Ticking clock, so the ages re-render between polls. */
  readonly now: number
  readonly sessionId: string | null
}

/** `—` is the ONLY rendering of unknown. Never an empty cell, never 0. */
const UNKNOWN = '—'

function n(
  value: number | null | undefined,
  opts?: { readonly digits?: number; readonly suffix?: string },
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN
  const digits = opts?.digits ?? 0
  return `${value.toFixed(digits)}${opts?.suffix ?? ''}`
}

function s(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? UNKNOWN : value
}

function b(value: boolean | null | undefined, t: UiTextFn): string {
  if (value === null || value === undefined) return UNKNOWN
  return value
    ? t('uiLibrary.streamDebugOverlay.yes', 'yes')
    : t('uiLibrary.streamDebugOverlay.no', 'no')
}

/** Age of a measurement, in the form an operator reads at a glance. */
function age(at: number | null, now: number, t: UiTextFn): string {
  if (at === null) return UNKNOWN
  const ms = Math.max(0, now - at)
  if (ms < 1_000) return t('uiLibrary.streamDebugOverlay.msAgo', '{{value}}ms ago', { value: ms })
  if (ms < 60_000) {
    return t('uiLibrary.streamDebugOverlay.sAgo', '{{value}}s ago', {
      value: (ms / 1000).toFixed(1),
    })
  }
  return t('uiLibrary.streamDebugOverlay.msAgoLong', '{{minutes}}m{{seconds}}s ago', {
    minutes: Math.floor(ms / 60_000),
    seconds: Math.floor((ms % 60_000) / 1000),
  })
}

/** A measurement older than this is NOT live, and is said to be. */
const STALE_AFTER_MS = 3_000

const VERDICT_CLASS: Readonly<Record<FreezeVerdictKind, string>> = {
  unknown: 'bg-white/15 text-white/70',
  decoding: 'bg-emerald-500/25 text-emerald-200',
  'decoder-stall': 'bg-amber-500/30 text-amber-100',
  'transport-stall': 'bg-rose-500/30 text-rose-100',
  'frozen-unknown': 'bg-white/15 text-white/70',
}

function Row({
  label,
  value,
  window,
  strong = false,
}: {
  label: string
  value: ReactNode
  /** The same measurement over the last window, shown beside the total. */
  window?: ReactNode
  strong?: boolean
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-2 leading-[1.25]">
      <span className="text-white/55 shrink-0">{label}</span>
      <span className="flex items-baseline gap-1 text-right">
        <span
          className={
            strong ? 'text-white font-semibold tabular-nums' : 'text-white/90 tabular-nums'
          }
        >
          {value}
        </span>
        {window !== undefined && <span className="text-sky-300/80 tabular-nums">{window}</span>}
      </span>
    </div>
  )
}

function SectionHeader({
  title,
  measuredAt,
  now,
}: {
  title: string
  measuredAt: number | null
  now: number
}): ReactNode {
  const t = useUiText()
  const stale = measuredAt !== null && now - measuredAt > STALE_AFTER_MS
  return (
    <div className="flex items-baseline justify-between gap-3 mt-2 first:mt-0 pb-0.5 border-b border-white/20">
      <span className="text-white/80 font-semibold tracking-wide uppercase text-[9px]">
        {title}
      </span>
      <span className={stale ? 'text-amber-300 text-[9px]' : 'text-white/45 text-[9px]'}>
        {stale ? `${t('uiLibrary.streamDebugOverlay.staleUpper', 'STALE')} · ` : ''}
        {age(measuredAt, now, t)}
      </span>
    </div>
  )
}

/** The pill's dot: the verdict, in the one place that is always visible. */
const VERDICT_DOT: Readonly<Record<FreezeVerdictKind, string>> = {
  unknown: 'bg-white/50',
  decoding: 'bg-emerald-400',
  'decoder-stall': 'bg-amber-400',
  'transport-stall': 'bg-rose-400',
  'frozen-unknown': 'bg-white/50',
}

export function StreamDebugOverlay(props: StreamDebugOverlayProps): ReactNode {
  const t = useUiText()
  const { stats, server, serverError, serverWired, now, sessionId } = props
  const verdict = freezeVerdict(stats)
  const win = stats?.window
  // Collapsed by default. A debug panel that covers the picture is one the
  // operator turns off, and then it measures nothing at all.
  const [expanded, setExpanded] = useState(false)
  const stale = stats !== null && now - stats.at > STALE_AFTER_MS

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="absolute bottom-10 left-2 z-20 transform-gpu flex items-center gap-1.5 rounded bg-neutral-950/90 ring-1 ring-white/20 px-1.5 py-0.5 text-[9px] font-mono text-white/85 tabular-nums select-text"
        data-testid="stream-debug-pill"
        title={verdict.label}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${VERDICT_DOT[verdict.kind]}`} />
        <span>
          {stats?.width !== null && stats?.width !== undefined
            ? `${stats.width}×${stats.height}`
            : UNKNOWN}
        </span>
        <span>{n(stats?.fps)}fps</span>
        <span>{n(win?.kbps)}k</span>
        {stale && (
          <span className="text-amber-300">{t('uiLibrary.streamDebugOverlay.stale', 'stale')}</span>
        )}
      </button>
    )
  }

  return (
    <div
      className="absolute bottom-10 left-2 z-20 transform-gpu w-[13.5rem] max-h-[70%] overflow-y-auto rounded-md bg-neutral-950/95 ring-1 ring-white/25 shadow-lg px-1.5 py-1 text-[9px] font-mono text-white/90 select-text"
      data-testid="stream-debug-overlay"
    >
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className={`w-full text-left rounded px-1.5 py-0.5 mb-1 text-[9px] font-semibold ${VERDICT_CLASS[verdict.kind]}`}
      >
        {verdict.label}
      </button>

      <SectionHeader title="decode" measuredAt={stats?.at ?? null} now={now} />
      {/* The three numbers the freeze investigation turns on, first and in
          bold: a transport stall and a decoder stall differ only here. */}
      <Row
        label="framesDecoded"
        value={n(stats?.framesDecoded)}
        window={win?.framesDecoded === null ? undefined : `+${n(win?.framesDecoded)}`}
        strong
      />
      <Row label="freezeCount" value={n(stats?.freezeCount)} strong />
      <Row
        label="frozen"
        value={n(stats?.totalFreezeMs, { suffix: 'ms' })}
        window={win?.freezeMs === null ? undefined : `+${n(win?.freezeMs)}ms`}
        strong
      />
      <Row
        label="pliCount"
        value={n(stats?.pliCount)}
        window={win?.pliCount === null ? undefined : `+${n(win?.pliCount)}`}
        strong
      />
      <Row label="framesDropped" value={n(stats?.framesDropped)} />
      <Row
        label="decode"
        value={n(stats?.avgDecodeMs, { digits: 1, suffix: 'ms' })}
        window={win?.decodeMs === null ? undefined : `${n(win?.decodeMs, { digits: 1 })}ms`}
      />

      <SectionHeader title="picture" measuredAt={stats?.at ?? null} now={now} />
      <Row
        label="resolution"
        value={
          stats?.width !== null && stats?.width !== undefined && stats.height !== null
            ? `${stats.width}×${stats.height}`
            : UNKNOWN
        }
      />
      <Row label="fps" value={n(stats?.fps)} />
      <Row
        label="codec"
        value={
          stats?.codec === null || stats?.codec === undefined
            ? UNKNOWN
            : `${stats.codec}${stats.codecProfileLevelId !== null ? ` ${stats.codecProfileLevelId}` : ''}`
        }
      />
      {(stats?.resolutionLog.length ?? 0) > 1 && (
        <div className="mt-0.5 text-white/60 leading-tight">
          {stats?.resolutionLog.map((mark) => (
            <div key={`${mark.at}-${mark.width}x${mark.height}`} className="flex justify-between">
              <span>
                {mark.width}×{mark.height}
              </span>
              <span className="text-white/40">{age(mark.at, now, t)}</span>
            </div>
          ))}
        </div>
      )}

      <SectionHeader title="transport" measuredAt={stats?.at ?? null} now={now} />
      <Row label="bitrate" value={n(win?.kbps, { suffix: ' kbps' })} />
      <Row label="rtt" value={n(stats?.rttMs, { digits: 0, suffix: 'ms' })} />
      <Row label="jitter" value={n(stats?.jitterMs, { digits: 1, suffix: 'ms' })} />
      <Row
        label="packetsLost"
        value={n(stats?.packetsLost)}
        window={win?.packetsLost === null ? undefined : `+${n(win?.packetsLost)}`}
      />
      <Row
        label="loss"
        value={n(stats?.lossPercent, { digits: 2, suffix: '%' })}
        window={
          win?.lossPercent === null ? undefined : n(win?.lossPercent, { digits: 2, suffix: '%' })
        }
      />
      <Row
        label="nackCount"
        value={n(stats?.nackCount)}
        window={win?.nackCount === null ? undefined : `+${n(win?.nackCount)}`}
      />
      <Row
        label={t('uiLibrary.streamDebugOverlay.candidatePair', 'candidate pair')}
        value={s(stats?.candidatePairType)}
      />
      <Row label="protocol" value={s(stats?.candidateProtocol)} />
      <Row label="ice" value={s(stats?.iceConnectionState)} />
      <Row label="dtls" value={s(stats?.dtlsState)} />

      <SectionHeader title="server" measuredAt={server?.observedAt ?? null} now={now} />
      {!serverWired ? (
        <div className="text-amber-300/90 leading-tight py-0.5">
          <UiTrans
            uiKey="uiLibrary.streamDebugOverlay.notWired"
            fallback="not wired on this surface — this player was mounted without <0>getSessionDebug</0>, so the server half cannot be asked"
            components={[<span key="fn" className="text-white/80" />]}
          />
        </div>
      ) : serverError !== null ? (
        <div className="text-rose-300 leading-tight py-0.5 break-words">{serverError}</div>
      ) : server === null ? (
        <div className="text-white/50 leading-tight py-0.5">
          {t('uiLibrary.streamDebugOverlay.waiting', 'waiting for the first answer…')}
        </div>
      ) : !server.alive ? (
        <div className="text-amber-300 leading-tight py-0.5">
          {t(
            'uiLibrary.streamDebugOverlay.sessionNotFound',
            'session not found on the server — it ended, or this node never had it',
          )}
        </div>
      ) : (
        <>
          <Row
            label={t('uiLibrary.streamDebugOverlay.servedRung', 'served rung')}
            value={s(server.servedTier)}
            strong
          />
          <Row label="adaptive" value={b(server.adaptive, t)} />
          <Row label="source" value={s(server.camStreamId)} />
          <Row
            label={t('uiLibrary.streamDebugOverlay.sourceKind', 'source kind')}
            value={server.sourceKind}
          />
          <Row
            label={t('uiLibrary.streamDebugOverlay.ingestNode', 'ingest node')}
            value={s(server.ingestNodeId)}
          />
          <Row
            label={t('uiLibrary.streamDebugOverlay.remote', '· remote')}
            value={b(server.ingestIsRemote, t)}
          />
          <Row
            label={t('uiLibrary.streamDebugOverlay.egressLeg', 'egress leg')}
            value={server.egressLeg}
            strong
          />
          <Row
            /* i18n-ignore: WebRTC / protocol field name */
            label="codec src→out"
            value={`${s(server.sourceCodec)}→${s(server.negotiatedCodec)}`}
          />
          <Row label="broker" value={s(server.brokerStatus)} />
          <Row
            label={t('uiLibrary.streamDebugOverlay.bitrate', '· bitrate')}
            value={n(server.brokerBitrateKbps, { suffix: ' kbps' })}
          />
          <Row
            label={t('uiLibrary.streamDebugOverlay.inputFps', '· input fps')}
            value={n(server.brokerInputFps)}
          />
          {/* i18n-ignore: WebRTC / protocol field name */}
          <Row label="rtp sent" value={n(server.rtpPacketsSent)} />
          <Row
            label={t('uiLibrary.streamDebugOverlay.trackMode', 'track mode')}
            value={s(server.trackMode)}
          />
          {server.lastDecision === null ? (
            <Row
              label="ladder"
              value={
                server.climbHold
                  ? t('uiLibrary.streamDebugOverlay.held', 'held')
                  : t('uiLibrary.streamDebugOverlay.neverMoved', 'never moved')
              }
            />
          ) : (
            <>
              <Row
                label={t('uiLibrary.streamDebugOverlay.ladderMove', 'ladder move')}
                value={`${server.lastDecision.causeDetail ?? server.lastDecision.cause}${server.lastDecision.tier !== null ? ` → ${server.lastDecision.tier}` : ''}`}
                strong
              />
              <Row
                label={t('uiLibrary.streamDebugOverlay.when', '· when')}
                value={age(server.lastDecision.at, now, t)}
              />
              {/* i18n-ignore: WebRTC / protocol field name */}
              <Row label="· lossRatio" value={n(server.lastDecision.lossRatio, { digits: 4 })} />
              <Row
                /* i18n-ignore: WebRTC / protocol field name */
                label="· clientKbps"
                value={n(server.lastDecision.clientKbps, { suffix: ' kbps' })}
              />
              <Row
                /* i18n-ignore: WebRTC / protocol field name */
                label="· stalledFor"
                value={n(server.lastDecision.stalledForMs, { suffix: 'ms' })}
              />
              {/* i18n-ignore: WebRTC / protocol field name */}
              <Row label="· serverSending" value={b(server.lastDecision.serverSending, t)} />
              {/* i18n-ignore: WebRTC / protocol field name */}
              <Row label="· transcode-down" value={b(server.lastDecision.forcedTranscodeDown, t)} />
            </>
          )}
          {server.climbHold ? <Row label="climb" value={server.climbHold.summary} /> : null}
          <Row label="promotions" value={n(server.upgradeCount)} />
          {server.tierFailures.length > 0 && (
            <Row
              label={t('uiLibrary.streamDebugOverlay.tierFailures', 'tier failures')}
              value={server.tierFailures.map((f) => `${f.tier}:${f.failures}`).join(' ')}
            />
          )}
        </>
      )}

      {sessionId !== null && (
        <div className="mt-1 pt-0.5 border-t border-white/15 text-white/40 break-all leading-tight">
          {sessionId}
        </div>
      )}
    </div>
  )
}

// i18n-ignore-end
