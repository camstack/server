/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React-Query inferred types collapse to 'error' under bundle parserService context (Phase D widget consolidation, lint-clean in original packages). Phase E builder migration revisits. */
/**
 * Per-device audio metrics panel.
 *
 * Renders the live `AudioMetricsSnapshot` produced by
 * `addon-pipeline-analytics` (audio-metrics cap). Bound to the
 * DeviceProxy reactive state slice
 * `dev.state.audioMetrics` via the canonical `useDeviceState`
 * combinator — push updates, no polling.
 *
 * Three blocks:
 *   - Current dB level + recent peak/avg
 *   - Currently dominant class (most recent above-threshold hit)
 *   - Per-class summary across the rolling window (default 60s)
 */
import { Activity, Mic, MicOff } from 'lucide-react'
import type { AudioMetricsSnapshot, AudioClassSummary, DeviceProxy } from '@camstack/types'
import { useDeviceState, useDeviceStateSlice, useSystem } from '@camstack/ui-library'
import { useT } from '../../i18n/index.js'

/**
 * Defensive normaliser for the snapshot's `windowSec` field. The
 * schema documents seconds, but a persisted slice from an older
 * build (before the unit was tightened) might still hold the
 * milliseconds value. When the value looks suspiciously large
 * (>10 minutes for an in-memory rolling window) interpret it as
 * milliseconds and convert. Avoids surfacing "60000s window" to
 * the operator while older builds drain out of the slice store.
 */
function normalizeWindowSec(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 60
  if (value > 600) return Math.round(value / 1000)
  return Math.round(value)
}

export interface AudioMetricsPanelProps {
  /** Pre-resolved proxy — preferred when a parent tab already owns one. */
  readonly dev?: DeviceProxy | null
  /** Resolve a proxy here when no parent dev is available. */
  readonly deviceId?: number
  readonly title?: string
  readonly variant?: 'full' | 'compact'
}

export function AudioMetricsPanel({
  dev: devProp,
  deviceId,
  title,
  variant = 'full',
}: AudioMetricsPanelProps) {
  const { t } = useT()
  const resolvedTitle = title ?? t('audioMetrics.title')
  const system = useSystem()
  const fallbackSnapshot = useDeviceState<AudioMetricsSnapshot>(
    system.trpcClient,
    devProp === undefined && deviceId !== undefined ? deviceId : null,
    (s) => s.audioMetrics,
  )
  const propSnapshot = useDeviceStateSlice<AudioMetricsSnapshot>(
    devProp ? devProp.state.audioMetrics : undefined,
  )
  const snapshot = devProp !== undefined ? propSnapshot : fallbackSnapshot

  if (!snapshot) {
    return (
      <Shell title={resolvedTitle} variant={variant}>
        <Empty
          icon={<MicOff className="h-5 w-5 mb-2 opacity-30" />}
          message={
            devProp || deviceId !== undefined ? t('audioMetrics.noData') : t('common.resolving')
          }
        />
      </Shell>
    )
  }

  return (
    <Shell title={resolvedTitle} variant={variant} ts={snapshot.ts}>
      <div
        className={variant === 'compact' ? 'space-y-2' : 'grid grid-cols-1 2xl:grid-cols-3 gap-3'}
      >
        <LevelBlock snapshot={snapshot} />
        <CurrentClass snapshot={snapshot} />
        <ClassWindow snapshot={snapshot} />
      </div>
    </Shell>
  )
}

interface ShellProps {
  readonly title: string
  readonly variant: 'full' | 'compact'
  readonly ts?: number
  readonly children: React.ReactNode
}

function Shell({ title, variant, ts, children }: ShellProps) {
  const { t } = useT()
  const ageSec = ts ? Math.max(0, Math.floor((Date.now() - ts) / 1000)) : null
  return (
    <div
      className={
        variant === 'compact'
          ? 'rounded-md border border-border/60 bg-surface/60 p-3'
          : 'rounded-lg border border-border bg-surface overflow-hidden'
      }
    >
      <div
        className={
          variant === 'compact'
            ? 'flex items-center justify-between mb-2'
            : 'border-b border-border px-4 py-2 flex items-center justify-between'
        }
      >
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">{title}</h2>
        {ageSec !== null && (
          <span className="text-[10px] text-foreground-subtle">
            {ageSec === 0 ? t('common.justNow') : t('common.secondsAgo', { seconds: ageSec })}
          </span>
        )}
      </div>
      <div className={variant === 'compact' ? '' : 'p-3'}>{children}</div>
    </div>
  )
}

function Empty({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="px-4 py-6 flex flex-col items-center text-center text-foreground-subtle">
      {icon}
      <p className="text-[11px]">{message}</p>
    </div>
  )
}

function LevelBlock({ snapshot }: { snapshot: AudioMetricsSnapshot }) {
  const { t } = useT()
  // Display dB on a -80..0 scale — typical audio meter range. Clamp
  // -Infinity (pure silence) to -80 for the bar so it doesn't render
  // the bar at full empty width.
  const { dbfs } = snapshot.level
  const safeDbfs = Number.isFinite(dbfs) ? dbfs : -80
  const clamped = Math.max(-80, Math.min(0, safeDbfs))
  const pct = ((clamped + 80) / 80) * 100
  const tone = clamped > -10 ? 'bg-danger' : clamped > -25 ? 'bg-warning' : 'bg-primary'
  return (
    <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle">
        <Activity className="h-3.5 w-3.5" />
        <span>{t('audioMetrics.level')}</span>
        <span className="ml-auto text-base font-semibold text-foreground tabular-nums normal-case tracking-normal">
          {Number.isFinite(dbfs) ? `${dbfs.toFixed(1)} dB` : t('audioMetrics.silent')}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-foreground-subtle/15 overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[9px] text-foreground-subtle mt-1 tabular-nums">
        <span>
          {t('audioMetrics.peak', {
            value: Number.isFinite(snapshot.peakDbfs) ? snapshot.peakDbfs.toFixed(1) : '—',
          })}
        </span>
        <span>{t('audioMetrics.avg', { value: snapshot.avgDbfs.toFixed(1) })}</span>
        <span>{t('audioMetrics.window', { seconds: normalizeWindowSec(snapshot.windowSec) })}</span>
      </div>
    </div>
  )
}

function CurrentClass({ snapshot }: { snapshot: AudioMetricsSnapshot }) {
  const { t } = useT()
  const { current } = snapshot
  return (
    <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle">
        <Mic className="h-3.5 w-3.5" />
        <span>{t('audioMetrics.now')}</span>
      </div>
      {current ? (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-foreground">{current.className}</span>
          <span className="text-[10px] text-foreground-subtle tabular-nums">
            {t('audioMetrics.scoreAgo', {
              score: (current.score * 100).toFixed(0),
              seconds: Math.max(0, Math.floor((Date.now() - current.timestamp) / 1000)),
            })}
          </span>
        </div>
      ) : (
        <span className="text-[10px] text-foreground-subtle italic">
          {t('audioMetrics.unclassified')}
        </span>
      )}
    </div>
  )
}

function ClassWindow({ snapshot }: { snapshot: AudioMetricsSnapshot }) {
  const { t } = useT()
  if (snapshot.byClass.length === 0) {
    return (
      <div className="rounded-md border border-border/40 bg-background/20 px-3 py-2">
        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle">
          <Activity className="h-3.5 w-3.5" />
          <span>{t('audioMetrics.last', { seconds: normalizeWindowSec(snapshot.windowSec) })}</span>
        </div>
        <span className="text-[10px] text-foreground-subtle italic">
          {t('audioMetrics.noClassified')}
        </span>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-border/60 bg-background/40">
      <div className="px-3 py-1.5 border-b border-border/40 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle">
        <Activity className="h-3.5 w-3.5" />
        <span>{t('audioMetrics.last', { seconds: normalizeWindowSec(snapshot.windowSec) })}</span>
        <span className="ml-auto text-[10px] normal-case tracking-normal">
          {snapshot.byClass.length}
        </span>
      </div>
      <div className="divide-y divide-border/30">
        {snapshot.byClass.slice(0, 8).map((cls: AudioClassSummary) => (
          <div
            key={cls.className}
            className="px-3 py-1.5 flex items-center justify-between text-xs"
          >
            <span className="font-medium text-foreground truncate">{cls.className}</span>
            <span className="flex items-center gap-2 tabular-nums text-foreground-subtle">
              <span>{t('audioMetrics.hits', { count: cls.hits })}</span>
              <span className="rounded-full px-1.5 py-0.5 text-[10px] bg-primary/10 text-primary border border-primary/20">
                {(cls.peakScore * 100).toFixed(0)}%
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
