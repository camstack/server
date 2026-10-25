/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React-Query inferred types collapse to 'error' under bundle parserService context (Phase D widget consolidation, lint-clean in original packages). Phase E builder migration revisits. */
/**
 * Per-device zone occupancy panel.
 *
 * Renders the live `CameraOccupancySnapshot` produced by the analytics
 * frame processor (`zone-analytics` cap). Three blocks:
 *   - Per-zone breakdown (one row per zone, count + class chips)
 *   - Frame-wide aggregate (everything detected, regardless of zone)
 *   - Unzoned (objects outside every zone)
 *
 * Bound to the DeviceProxy reactive state slice
 * `dev.state.zoneAnalytics` — every analytics frame writes the
 * mirror, the slice subscriber re-renders the panel without polling.
 * Two render modes:
 *   - pass `dev` from a parent that already resolved the proxy
 *     (preferred when embedded in a tab that owns the proxy);
 *   - pass `deviceId` and the panel resolves its own proxy via
 *     `useDeviceProxy` (drop-in usage anywhere on the device page).
 */
import { Layers, Boxes, MapPinOff } from 'lucide-react'
import { useMemo } from 'react'
import type { DeviceProxy, PerScopeBreakdown, CameraOccupancySnapshot } from '@camstack/types'
import { useDeviceProxy, useDeviceStateSlice, useSystem } from '@camstack/ui-library'
import { useT } from '../../i18n/index.js'

export interface OccupancyPanelProps {
  /** Pre-resolved proxy — preferred when a parent tab already owns one. */
  readonly dev?: DeviceProxy | null
  /** Resolve a proxy here when no parent dev is available. */
  readonly deviceId?: number
  readonly title?: string
  readonly variant?: 'full' | 'compact'
}

export function OccupancyPanel({
  dev: devProp,
  deviceId,
  title,
  variant = 'full',
}: OccupancyPanelProps) {
  const { t } = useT()
  const resolvedTitle = title ?? t('occupancy.title')
  const system = useSystem()
  // Resolve our own proxy only if the caller didn't pass one.
  const ownProxy = useDeviceProxy(
    system.trpcClient,
    devProp === undefined && deviceId !== undefined ? deviceId : null,
  )
  const dev = devProp ?? ownProxy

  const snapshot = useDeviceStateSlice(dev?.state.zoneAnalytics)

  if (!snapshot) {
    return (
      <PanelShell title={resolvedTitle} variant={variant}>
        <EmptyState message={dev ? t('occupancy.noData') : t('common.resolving')} />
      </PanelShell>
    )
  }

  return (
    <PanelShell title={resolvedTitle} variant={variant} ts={snapshot.ts}>
      <div
        className={variant === 'compact' ? 'space-y-2' : 'grid grid-cols-1 2xl:grid-cols-3 gap-3'}
      >
        <FrameBreakdown frame={snapshot.frame} />
        <ZoneList snapshot={snapshot} />
        <UnzonedBreakdown unzoned={snapshot.unzoned} />
      </div>
    </PanelShell>
  )
}

interface PanelShellProps {
  readonly title: string
  readonly variant: 'full' | 'compact'
  readonly ts?: number
  readonly children: React.ReactNode
}

function PanelShell({ title, variant, ts, children }: PanelShellProps) {
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-4 py-6 flex flex-col items-center text-center text-foreground-subtle">
      <Layers className="h-5 w-5 mb-2 opacity-30" />
      <p className="text-[11px]">{message}</p>
    </div>
  )
}

function FrameBreakdown({ frame }: { frame: PerScopeBreakdown }) {
  const { t } = useT()
  return (
    <BreakdownCard
      icon={<Boxes className="h-3.5 w-3.5" />}
      label={t('occupancy.frameTotal')}
      total={frame.totalObjects}
      byClass={frame.byClass}
      tone="default"
    />
  )
}

function UnzonedBreakdown({ unzoned }: { unzoned: PerScopeBreakdown }) {
  const { t } = useT()
  return (
    <BreakdownCard
      icon={<MapPinOff className="h-3.5 w-3.5" />}
      label={t('occupancy.outsideZone')}
      total={unzoned.totalObjects}
      byClass={unzoned.byClass}
      tone="muted"
    />
  )
}

function ZoneList({ snapshot }: { snapshot: CameraOccupancySnapshot }) {
  const { t } = useT()
  if (snapshot.zones.length === 0) {
    return (
      <BreakdownCard
        icon={<Layers className="h-3.5 w-3.5" />}
        label={t('occupancy.perZone')}
        total={0}
        byClass={{}}
        tone="muted"
        emptyMessage={t('occupancy.noZones')}
      />
    )
  }
  return (
    <div className="rounded-md border border-border/60 bg-background/40">
      <div className="px-3 py-1.5 border-b border-border/40 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle">
        <Layers className="h-3.5 w-3.5" />
        <span>{t('occupancy.perZone')}</span>
        <span className="ml-auto text-[10px] normal-case tracking-normal">
          {snapshot.zones.length}
        </span>
      </div>
      <div className="divide-y divide-border/30">
        {snapshot.zones.map((z) => (
          <div key={z.zoneId} className="px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground truncate">{z.zoneName}</span>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-foreground-subtle/10 text-foreground-subtle border border-border">
                {z.totalObjects}
              </span>
            </div>
            <ClassChips byClass={z.byClass} />
          </div>
        ))}
      </div>
    </div>
  )
}

interface BreakdownCardProps {
  readonly icon: React.ReactNode
  readonly label: string
  readonly total: number
  readonly byClass: Readonly<Record<string, number>>
  readonly tone: 'default' | 'muted'
  readonly emptyMessage?: string
}

function BreakdownCard({ icon, label, total, byClass, tone, emptyMessage }: BreakdownCardProps) {
  const { t } = useT()
  const classCount = Object.keys(byClass).length
  return (
    <div
      className={
        tone === 'muted'
          ? 'rounded-md border border-border/40 bg-background/20 px-3 py-2'
          : 'rounded-md border border-border/60 bg-background/40 px-3 py-2'
      }
    >
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] uppercase tracking-wider text-foreground-subtle">
        {icon}
        <span>{label}</span>
        <span className="ml-auto text-base font-semibold text-foreground tabular-nums normal-case tracking-normal">
          {total}
        </span>
      </div>
      {classCount === 0 ? (
        <span className="text-[10px] text-foreground-subtle italic">
          {emptyMessage ?? t('occupancy.noObjects')}
        </span>
      ) : (
        <ClassChips byClass={byClass} />
      )}
    </div>
  )
}

function ClassChips({ byClass }: { byClass: Readonly<Record<string, number>> }) {
  const { t } = useT()
  const entries = useMemo(() => Object.entries(byClass).sort(([, a], [, b]) => b - a), [byClass])
  if (entries.length === 0) {
    return (
      <span className="text-[10px] text-foreground-subtle italic">{t('occupancy.noObjects')}</span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([className, count]) => (
        <span
          key={className}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary border border-primary/20"
        >
          <span>{className}</span>
          <span className="tabular-nums opacity-80">{count}</span>
        </span>
      ))}
    </div>
  )
}
