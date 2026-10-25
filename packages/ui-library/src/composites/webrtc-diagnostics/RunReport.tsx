/**
 * One hub session run, rendered: the verdict first, then the evidence by
 * layer (hub candidates → timeline → path → media). Every unmeasured value
 * reads "unknown" (D393), never 0.
 */
import type { ReactNode } from 'react'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import {
  SECTION_CARD,
  SECTION_HEADER,
  SECTION_BODY,
  TEXT_HINT,
  TEXT_SECTION_LABEL,
} from '../../lib/responsive'
import { Badge } from '../../primitives/badge'
import { KeyValueList } from '../key-value-list'
import { fmtBytes, fmtCount, fmtMs, fmtPercent, fmtText } from './format'
import type { HubCandidateSummary, ParsedIceCandidate } from './ice-candidates'
import type { HubSessionRunReport } from './session-run'
import type { SessionVerdictLayer } from './session-verdict'

const VERDICT_VARIANT: Readonly<
  Record<SessionVerdictLayer, 'success' | 'warning' | 'danger' | 'default'>
> = {
  healthy: 'success',
  'loss-keyframe': 'warning',
  transport: 'danger',
  'hub-dtls': 'danger',
  'media-black-hole': 'danger',
  'hub-not-sending': 'danger',
  unknown: 'default',
}

function flagText(flag: HubCandidateSummary['flag'], t: UiTextFn): string {
  switch (flag) {
    case 'public-path':
      return t(
        'uiLibrary.runReport.flagPublicPath',
        'has a public path (srflx / relay / public host)',
      )
    case 'private-only':
      return t('uiLibrary.runReport.flagPrivateOnly', 'LAN/Tailscale only, no srflx/relay')
    case 'none':
      return t('uiLibrary.runReport.flagNone', 'answered with no candidate')
    case 'unknown':
      return t('uiLibrary.runReport.flagUnknown', 'no answer received')
  }
}

function candidateText(c: ParsedIceCandidate, t: UiTextFn): string {
  const where =
    c.address === null
      ? t('uiLibrary.runReport.unknown', 'unknown')
      : `${c.address}:${c.port === null ? '?' : String(c.port)}`
  return `${c.type} ${c.protocol ?? '?'} ${where} · ${c.scope}`
}

function typeCounts(counts: Readonly<Record<string, number>>, t: UiTextFn): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${String(count)} ${type}`)
  return parts.length > 0 ? parts.join(' · ') : t('uiLibrary.runReport.none', 'none')
}

function Group({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="space-y-0.5">
      <div className={TEXT_SECTION_LABEL}>{title}</div>
      {children}
    </div>
  )
}

export function RunReport({
  report,
  title,
}: {
  readonly report: HubSessionRunReport
  readonly title: string
}): ReactNode {
  const t = useUiText()
  const { hub, timeline, path, media, verdict, local } = report
  return (
    <section className={SECTION_CARD} data-testid={`webrtc-diag-run-${report.policy}`}>
      <header className={`${SECTION_HEADER} flex flex-wrap items-center gap-2`}>
        <h3 className={`${TEXT_SECTION_LABEL} min-w-0 flex-1`}>{title}</h3>
        <Badge variant={VERDICT_VARIANT[verdict.layer]}>{verdict.title}</Badge>
      </header>
      <div className={`${SECTION_BODY} space-y-3`}>
        <p className="text-xs text-foreground">{verdict.detail}</p>

        <Group title={t('uiLibrary.runReport.hubCandidates', 'Hub candidates')}>
          <KeyValueList
            items={[
              {
                key: t('uiLibrary.runReport.offered', 'Offered'),
                value: (
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    {typeCounts(hub.countByType, t)}
                    <Badge
                      variant={
                        hub.flag === 'private-only'
                          ? 'warning'
                          : hub.flag === 'public-path'
                            ? 'success'
                            : 'default'
                      }
                    >
                      {flagText(hub.flag, t)}
                    </Badge>
                  </span>
                ),
              },
              {
                key: t('uiLibrary.runReport.source', 'Source'),
                value: `${t(
                  'uiLibrary.runReport.sourceCounts',
                  '{{sdp}} in the answer SDP · {{trickled}} trickled',
                  {
                    sdp: hub.fromSdp,
                    trickled: hub.fromTrickle,
                  },
                )}${hub.trickleDone === true ? ` · ${t('uiLibrary.runReport.gatheringDone', 'gathering done')}` : ''}`,
              },
            ]}
          />
          {hub.candidates.length > 0 && (
            <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-foreground-subtle">
              {hub.candidates.map((c) => (
                <li key={c.raw} className="break-all">
                  {candidateText(c, t)}
                </li>
              ))}
            </ul>
          )}
        </Group>

        <Group title={t('uiLibrary.runReport.timeline', 'Timeline')}>
          <KeyValueList
            items={[
              { key: 'ICE connected', value: fmtMs(timeline.iceConnectedMs) },
              { key: 'DTLS connected', value: fmtMs(timeline.dtlsConnectedMs) },
              {
                key: t('uiLibrary.runReport.firstFrame', 'First frame'),
                value: fmtMs(timeline.firstFrameMs),
              },
              {
                key: 'ICE · DTLS final',
                value: `${fmtText(timeline.iceFinalState)} · ${fmtText(timeline.dtlsFinalState)}`,
              },
            ]}
          />
        </Group>

        <Group title={t('uiLibrary.runReport.path', 'Path')}>
          <KeyValueList
            items={[
              {
                key: t('uiLibrary.runReport.selectedPair', 'Selected pair'),
                value:
                  path.pairType === null
                    ? fmtText(null)
                    : t('uiLibrary.runReport.pairType', '{{type}} (local/remote)', {
                        type: path.pairType,
                      }),
              },
              { key: 'Protocol · RTT', value: `${fmtText(path.protocol)} · ${fmtMs(path.rttMs)}` },
              {
                key: t('uiLibrary.runReport.browserOffered', 'Browser offered'),
                value: `${typeCounts(local.countByType, t)}${local.relayProtocols.length > 0 ? ` · ${t('uiLibrary.runReport.relayOver', 'relay over {{protocols}}', { protocols: local.relayProtocols.join('/') })}` : ''}`,
              },
            ]}
          />
        </Group>

        <Group title={t('uiLibrary.runReport.media', 'Media')}>
          <KeyValueList
            items={[
              {
                key: t('uiLibrary.runReport.hubSent', 'Hub sent'),
                value: `${t('uiLibrary.runReport.rtpPackets', '{{value}} RTP packets', { value: fmtCount(media.serverPacketsSent) })}${media.servedTier !== null ? ` · ${media.servedTier}` : ''}${media.egressLeg !== null ? ` · ${media.egressLeg}` : ''}`,
              },
              {
                key: t('uiLibrary.runReport.browserGot', 'Browser got'),
                value: `${t('uiLibrary.runReport.packets', '{{value}} packets', { value: fmtCount(media.clientPacketsReceived) })} · ${fmtBytes(media.clientBytesReceived)}`,
              },
              {
                key: t('uiLibrary.runReport.framesDecoded', 'Frames decoded'),
                value: fmtCount(media.framesDecoded),
              },
              {
                key: t('uiLibrary.runReport.lossFreezes', 'Loss · freezes'),
                value: `${fmtPercent(media.lossPercent)} · ${fmtCount(media.freezeCount)} (${fmtMs(media.totalFreezeMs)})`,
              },
              {
                key: 'PLI · NACK',
                value: `${fmtCount(media.pliCount)} · ${fmtCount(media.nackCount)}`,
              },
            ]}
          />
        </Group>

        {(report.reconnects > 0 || report.errors.length > 0 || report.serverError !== null) && (
          <div className={TEXT_HINT}>
            {report.reconnects > 0 && (
              <div>
                {t('uiLibrary.runReport.reconnects', 'Player reconnects: {{count}}', {
                  count: report.reconnects,
                })}
              </div>
            )}
            {report.errors.map((e, i) => (
              <div key={`${String(i)}-${e}`}>
                {t('uiLibrary.runReport.playerError', 'Player error: {{message}}', { message: e })}
              </div>
            ))}
            {report.serverError !== null && (
              <div>
                {t('uiLibrary.runReport.serverDebug', 'Server debug: {{message}}', {
                  message: report.serverError,
                })}
              </div>
            )}
          </div>
        )}
        <div className={TEXT_HINT}>
          {t('uiLibrary.runReport.sessions', 'Sessions: {{ids}} · {{seconds}} s', {
            ids:
              report.sessionIds.length > 0
                ? report.sessionIds.map((id) => id.slice(0, 8)).join(', ')
                : t('uiLibrary.runReport.none', 'none'),
            seconds: Math.round(report.durationMs / 1000),
          })}
        </div>
      </div>
    </section>
  )
}
