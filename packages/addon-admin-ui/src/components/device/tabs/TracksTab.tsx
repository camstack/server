import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Footprints,
  MapPin,
  Clock,
  Activity,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react'
import type { Track } from '@camstack/types'
import { useDeviceProxy, useSystem } from '@camstack/ui-library'
import { Trans, useTranslation } from 'react-i18next'

/**
 * TracksTab — replaces the legacy TrackTrailTab. Reads from the
 * `pipeline-analytics` cap introduced by P1. A "trail" is just
 * `track.positions[]` on a Track record — no separate concept.
 *
 * Configuration (snapshot interval, retention, etc.) lives on the
 * device settings aggregator through `pipeline-analytics`'s
 * exposesDeviceSettings contribution — not duplicated here.
 */

interface TracksTabProps {
  readonly deviceId: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDistance(distance: number): string {
  if (distance < 1) return `${(distance * 100).toFixed(0)}cm`
  return `${distance.toFixed(1)}m`
}

const CLASS_COLORS: Record<string, string> = {
  person: 'bg-info/15 text-info',
  vehicle: 'bg-warning/15 text-warning',
  animal: 'bg-success/15 text-success',
  package: 'bg-primary/15 text-primary',
}

function classColor(cls: string): string {
  return CLASS_COLORS[cls.toLowerCase()] ?? 'bg-foreground-subtle/15 text-foreground-subtle'
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BackendPendingState({ label }: { readonly label: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center py-10 text-foreground-subtle">
      <AlertCircle className="h-6 w-6 mb-2 opacity-30" />
      <p className="text-xs">{t('device.tracksTab.backendPending', 'Backend pending')}</p>
      <p className="text-[10px] mt-0.5 opacity-70">
        {t('device.tracksTab.routeUnavailable', { label })}
      </p>
    </div>
  )
}

function ActiveTrackCard({ track }: { readonly track: Track }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex items-center justify-center rounded-lg h-8 w-8 bg-primary/10 flex-shrink-0 mt-0.5">
        <Activity className="h-4 w-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`text-[9px] font-semibold uppercase rounded px-1.5 py-0.5 ${classColor(track.className)}`}
          >
            {track.className}
          </span>
          <span className="text-[10px] font-mono text-foreground-subtle">#{track.trackId}</span>
          <span className="text-[9px] rounded bg-surface-hover px-1.5 py-0.5 text-foreground-subtle">
            {track.state}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1.5 text-[10px] text-foreground-subtle">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(track.firstSeen)}
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {t('device.tracksTab.points', { count: track.positions.length })}
          </span>
          <span>{formatDistance(track.totalDistance)}</span>
        </div>
        {track.zonesVisited.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {track.zonesVisited.map((zone) => (
              <span
                key={zone}
                className="text-[9px] rounded bg-surface-hover px-1.5 py-0.5 text-foreground-subtle"
              >
                {zone}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function HistoricalTrackRow({ track }: { readonly track: Track }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-hover/50 transition-colors text-left"
      >
        <div className="flex-shrink-0 text-foreground-subtle">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </div>
        <span
          className={`text-[9px] font-semibold uppercase rounded px-1.5 py-0.5 ${classColor(track.className)}`}
        >
          {track.className}
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-3 text-[10px] text-foreground-subtle">
          <span>{formatTimestamp(track.firstSeen)}</span>
          <span className="opacity-50">—</span>
          <span>{formatTimestamp(track.lastSeen)}</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-foreground-subtle flex-shrink-0">
          <span>{formatDistance(track.totalDistance)}</span>
          <span>{t('device.tracksTab.points', { count: track.positions.length })}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pl-11">
          {track.zonesVisited.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              <span className="text-[9px] text-foreground-subtle mr-1">
                {t('device.tracksTab.zones', 'Zones:')}
              </span>
              {track.zonesVisited.map((zone) => (
                <span
                  key={zone}
                  className="text-[9px] rounded bg-surface-hover px-1.5 py-0.5 text-foreground-subtle"
                >
                  {zone}
                </span>
              ))}
            </div>
          )}
          <div className="rounded border border-border bg-surface-hover/30 overflow-hidden max-h-48 overflow-y-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="border-b border-border text-foreground-subtle">
                  <th className="px-2 py-1 text-left font-medium">#</th>
                  <th className="px-2 py-1 text-left font-medium">X</th>
                  <th className="px-2 py-1 text-left font-medium">Y</th>
                  <th className="px-2 py-1 text-left font-medium">
                    {t('device.tracksTab.time', 'Time')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {track.positions.map((pos, idx) => (
                  <tr key={idx} className="text-foreground-subtle">
                    <td className="px-2 py-0.5">{idx + 1}</td>
                    <td className="px-2 py-0.5">{pos.x.toFixed(3)}</td>
                    <td className="px-2 py-0.5">{pos.y.toFixed(3)}</td>
                    <td className="px-2 py-0.5">{formatTimestamp(pos.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TracksTab
// ---------------------------------------------------------------------------

export function TracksTab({ deviceId }: TracksTabProps) {
  const { t } = useTranslation()
  // pipeline-analytics is device-scoped — go through the proxy so the
  // call routes through the wrapper chain with deviceId injected.
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const { data: activeTracks, isError: activeErr } = useQuery({
    queryKey: ['device', deviceId, 'pipelineAnalytics.getActiveTracks'],
    queryFn: () => dev?.pipelineAnalytics?.getActiveTracks({}) ?? [],
    enabled: !!dev && !!deviceId,
    refetchInterval: 3_000,
    retry: false,
  })

  const { data: historicalTracks, isError: historicalErr } = useQuery({
    queryKey: ['device', deviceId, 'pipelineAnalytics.listTracks', 20],
    queryFn: () => dev?.pipelineAnalytics?.listTracks({ limit: 20 }) ?? [],
    enabled: !!dev && !!deviceId,
    retry: false,
  })

  return (
    <div className="space-y-4">
      {/* Hint — tuning knobs moved to device settings aggregator */}
      <div className="rounded border border-border/60 bg-surface-muted px-3 py-2 text-[11px] text-foreground-subtle">
        <Trans
          i18nKey="device.tracksTab.trackingHint"
          components={{
            b: <span className="font-medium text-foreground" />,
            code: <code className="px-1 py-0.5 rounded bg-surface text-foreground" />,
          }}
        />
      </div>

      {/* Active tracks */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-foreground-subtle" />
            <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
              {t('device.tracksTab.activeTracks', 'Active tracks')}
            </h2>
          </div>
          {!activeErr && activeTracks && activeTracks.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary font-medium">
              {t('device.tracksTab.liveCount', { count: activeTracks.length })}
            </span>
          )}
        </div>
        {activeErr ? (
          <BackendPendingState
            label={t(
              'device.tracksTab.pipelineanalyticsGetactivetracks',
              'pipelineAnalytics.getActiveTracks',
            )}
          />
        ) : !activeTracks || activeTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-foreground-subtle">
            <Footprints className="h-8 w-8 mb-3 opacity-30" />
            <p className="text-sm">{t('device.tracksTab.noActiveTracks', 'No active tracks')}</p>
            <p className="text-xs mt-1 opacity-70">
              {t(
                'device.tracksTab.tracksAppearWhenObjectsAre',
                'Tracks appear when objects are currently moving',
              )}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {activeTracks.map((t) => (
              <ActiveTrackCard key={t.trackId} track={t} />
            ))}
          </div>
        )}
      </div>

      {/* Historical tracks */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-foreground-subtle" />
            <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
              {t('device.tracksTab.historicalTracks', 'Historical tracks')}
            </h2>
          </div>
          {!historicalErr && historicalTracks && historicalTracks.length > 0 && (
            <span className="text-[10px] text-foreground-subtle">
              {t('device.tracksTab.trackCount', { count: historicalTracks.length })}
            </span>
          )}
        </div>
        {historicalErr ? (
          <BackendPendingState
            label={t(
              'device.tracksTab.pipelineanalyticsListtracks',
              'pipelineAnalytics.listTracks',
            )}
          />
        ) : !historicalTracks || historicalTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-foreground-subtle">
            <MapPin className="h-8 w-8 mb-3 opacity-30" />
            <p className="text-sm">
              {t('device.tracksTab.noCompletedTracksYet', 'No completed tracks yet')}
            </p>
            <p className="text-xs mt-1 opacity-70">
              {t(
                'device.tracksTab.tracksAreArchivedWhenTheir',
                'Tracks are archived when their TTL expires',
              )}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {historicalTracks.map((t) => (
              <HistoricalTrackRow key={t.trackId} track={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
