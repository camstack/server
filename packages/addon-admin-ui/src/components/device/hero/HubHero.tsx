import { useMemo } from 'react'
import { Network, RefreshCw, Loader2, Wifi, Moon, WifiOff, HelpCircle } from 'lucide-react'
import {
  useDeviceDiscoveryListDiscovered,
  useDeviceDiscoveryRefreshDiscovery,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import type { DiscoveredChildDevice } from '@camstack/types'
import type { HeroProps } from './HeroRegistry'
import { useTranslation } from 'react-i18next'

/**
 * Hero for `DeviceType.Hub` devices. The page-level header already
 * shows the device name, online badge, and reload control — this
 * panel deliberately skips identity restate and goes straight to
 * the discovery roll-up: Discovered / Adopted / Available counts +
 * per-status legend + a Discover button to force a refresh.
 *
 * Per-channel detail (Add / Remove buttons, individual cameras) lives
 * in the `<DiscoveryPanel>` rendered inside the Overview tab — the
 * hero is purely an at-a-glance summary so the operator doesn't have
 * to scroll for the count.
 */
export function HubHero({ deviceId }: HeroProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const listQuery = useDeviceDiscoveryListDiscovered(
    { deviceId },
    { refetchInterval: 10_000, retry: false },
  )
  const refreshMutation = useDeviceDiscoveryRefreshDiscovery({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceDiscovery', 'listDiscovered']] })
      void queryClient.invalidateQueries({ queryKey: [['deviceDiscovery', 'getStatus']] })
    },
  })

  const summary = useMemo(() => buildSummary(listQuery.data ?? []), [listQuery.data])

  return (
    <div className="flex h-full w-full flex-col gap-3 p-3 sm:p-4">
      {/* Stat tiles + Discover button. Layout strategy:
          - Each tile is `flex-1` with `basis-[140px]` so it claims an
            equal share of the row but never shrinks below 140px. When
            4 × 140px > available width, `flex-wrap` pushes overflowing
            tiles (or the button) onto the next row. The button has
            `basis-auto` so it stays compact and is the first to wrap.
          - This replaces the previous fixed 3-col grid which forced
            all three tiles onto the same line at any width — at md
            breakpoint the tiles ended up cramped to ~80px each.
          - Other heroes (SwitchHero / LightHero / SensorHero) leave
            their root unstyled so the page-level container's border
            is the only chrome — we mirror that here. */}
      <div className="flex flex-wrap items-stretch gap-2 sm:gap-3">
        <StatTile
          label={t('hero.hubHero.discovered', 'Discovered')}
          value={summary.total}
          icon={<Network className="h-3.5 w-3.5" />}
        />
        <StatTile
          label={t('hero.hubHero.adopted', 'Adopted')}
          value={summary.adopted}
          accent="success"
        />
        <StatTile
          label={t('hero.hubHero.available', 'Available')}
          value={summary.available}
          accent={summary.available > 0 ? 'primary' : undefined}
        />
        <button
          type="button"
          onClick={() => {
            void refreshMutation.mutateAsync({ deviceId }).catch(() => {
              /* swallow — surfaced via poll */
            })
          }}
          disabled={refreshMutation.isPending}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 self-stretch shrink-0"
        >
          {refreshMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">{t('hero.hubHero.discover', 'Discover')}</span>
        </button>
      </div>

      {/* Per-status legend — wraps to a second row when the parent is
          too narrow for all 4 entries on one line. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground-subtle border-t border-border-subtle pt-2">
        <LegendItem
          icon={<Wifi className="h-3 w-3 text-emerald-500" />}
          label={t('hero.hubHero.online', '{{online}} online', { online: summary.online })}
        />
        <LegendItem
          icon={<Moon className="h-3 w-3 text-amber-500" />}
          label={t('hero.hubHero.sleeping', '{{sleeping}} sleeping', {
            sleeping: summary.sleeping,
          })}
        />
        <LegendItem
          icon={<WifiOff className="h-3 w-3 text-destructive" />}
          label={t('hero.hubHero.offline', '{{offline}} offline', { offline: summary.offline })}
        />
        {summary.unknown > 0 ? (
          <LegendItem
            icon={<HelpCircle className="h-3 w-3 text-foreground-subtle" />}
            label={t('hero.hubHero.unknown', '{{unknown}} unknown', { unknown: summary.unknown })}
          />
        ) : null}
      </div>
    </div>
  )
}

interface DiscoveredSummary {
  total: number
  adopted: number
  available: number
  online: number
  sleeping: number
  offline: number
  unknown: number
}

function buildSummary(list: readonly DiscoveredChildDevice[]): DiscoveredSummary {
  const summary: DiscoveredSummary = {
    total: list.length,
    adopted: 0,
    available: 0,
    online: 0,
    sleeping: 0,
    offline: 0,
    unknown: 0,
  }
  for (const child of list) {
    if (child.alreadyAdopted) summary.adopted += 1
    else summary.available += 1
    summary[child.status] += 1
  }
  return summary
}

interface StatTileProps {
  readonly label: string
  readonly value: number
  readonly icon?: React.ReactNode
  readonly accent?: 'success' | 'primary'
}

function StatTile({ label, value, icon, accent }: StatTileProps) {
  const accentClass =
    accent === 'success'
      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
      : accent === 'primary'
        ? 'bg-primary/10 border-primary/30 text-primary'
        : 'bg-surface-hover border-border text-foreground'
  return (
    // `basis-[140px]` floors the tile width — no more 3 cramped 80px
    // tiles squeezed onto a narrow row. `flex-1` distributes the
    // remaining width equally; `min-w-0` lets the inner truncate fire
    // when the label is too long for the basis.
    <div
      className={`flex flex-1 basis-[140px] min-w-0 flex-col gap-1 rounded-lg border px-2 py-1.5 sm:px-3 sm:py-2 ${accentClass}`}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-70 truncate">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-xl sm:text-2xl font-semibold tabular-nums leading-none">{value}</div>
    </div>
  )
}

function LegendItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      <span>{label}</span>
    </span>
  )
}
