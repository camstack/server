/**
 * BatteryBadge — compact battery indicator for camera tiles + headers.
 *
 * Renders a battery icon with the percentage, a charging glyph when the
 * device is on DC/solar, and a moon when the camera is sleeping (so
 * operators don't blame the platform for low fps on a sleeping cam).
 *
 * Self-contained on data: the caller passes a `status` snapshot from
 * `trpc.battery.getStatus.useQuery` or the `battery.onStatusChanged`
 * event subscription. Returns `null` when status is missing so the
 * call-site can drop the badge in unconditionally — non-battery
 * cameras simply produce no badge.
 */
import type { JSX } from 'react'
import {
  Battery,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Moon,
  Plug,
  Sun,
} from 'lucide-react'
import { useUiText } from '../contexts/ui-text'
import { cn } from '../lib/cn'

export interface BatteryStatusLike {
  /** `null` means no reading has landed yet (cold seed) — NOT a flat 0 %
   *  (D315). Render "Unknown", never a red critical badge. */
  readonly percentage: number | null
  readonly charging: 'dc' | 'solar' | 'none' | 'unknown'
  readonly sleeping: boolean
  /** True for a binary LOW_BAT source with no real % — render "Normal"/"Low"
   *  instead of a misleading exact percentage. */
  readonly binary?: boolean
}

/** A binary battery is "low" below this stand-in percentage (normal maps to
 *  100, low to a sub-threshold value). Keep in sync with the HA container. */
const BINARY_LOW_THRESHOLD = 50

export interface BatteryBadgeProps {
  readonly status: BatteryStatusLike | null | undefined
  /** `'compact'` shows only icon + %; `'full'` adds the source label. */
  readonly variant?: 'compact' | 'full'
  readonly className?: string
}

// Monotonic fill — more charge = more bars. `Battery` (the empty outline) is
// deliberately NOT used for mid levels: it made 62 % look empty.
function pickIcon(percentage: number): typeof BatteryFull {
  if (percentage <= 10) return BatteryWarning // critical
  if (percentage <= 30) return BatteryLow // ~1 bar
  if (percentage <= 70) return BatteryMedium // ~2 bars
  return BatteryFull // ~3 bars
}

/** A power source the camera actually reported, as opposed to none or unknown. */
function isPowered(charging: BatteryStatusLike['charging']): boolean {
  return charging === 'dc' || charging === 'solar'
}

function levelColor(percentage: number, charging: BatteryStatusLike['charging']): string {
  if (isPowered(charging)) return 'text-emerald-400'
  if (percentage <= 10) return 'text-rose-400'
  if (percentage <= 30) return 'text-amber-400'
  return 'text-foreground-subtle'
}

export function BatteryBadge({
  status,
  variant = 'compact',
  className,
}: BatteryBadgeProps): JSX.Element | null {
  const t = useUiText()
  if (!status) return null
  const { percentage, charging, sleeping, binary } = status

  // No reading has landed yet (cold seed) — neutral "Unknown", never a
  // fabricated 0 % with the red critical icon (D315). A device nobody has
  // read yet and a dead battery must never look alike.
  if (percentage === null) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-medium text-foreground-subtle',
          className,
        )}
        title={t('uiLibrary.batteryBadge.titleUnknown', 'Battery: unknown')}
      >
        <Battery className="h-3.5 w-3.5" />
        <span>{t('uiLibrary.batteryBadge.unknown', 'Unknown')}</span>
      </span>
    )
  }

  // Binary LOW_BAT source: no real charge level — show "Normal"/"Low".
  if (binary === true) {
    const low = percentage < BINARY_LOW_THRESHOLD
    const BinIcon = low ? BatteryWarning : BatteryFull
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[10px] font-medium',
          low ? 'text-rose-400' : 'text-foreground-subtle',
          className,
        )}
        title={
          low
            ? t('uiLibrary.batteryBadge.titleLow', 'Battery: low')
            : t('uiLibrary.batteryBadge.titleNormal', 'Battery: normal')
        }
      >
        <BinIcon className="h-3.5 w-3.5" />
        <span>
          {low
            ? t('uiLibrary.batteryBadge.low', 'Low')
            : t('uiLibrary.batteryBadge.normal', 'Normal')}
        </span>
      </span>
    )
  }

  const Icon = pickIcon(percentage)
  const color = levelColor(percentage, charging)
  const ChargingGlyph = charging === 'solar' ? Sun : charging === 'dc' ? Plug : null
  const showSleeping = sleeping

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[10px] font-medium', color, className)}
      title={[
        t('uiLibrary.batteryBadge.titlePercent', 'Battery: {{percent}}%', {
          percent: Math.round(percentage),
        }),
        isPowered(charging)
          ? t('uiLibrary.batteryBadge.charging', 'charging ({{source}})', { source: charging })
          : null,
        sleeping ? t('uiLibrary.batteryBadge.sleeping', 'sleeping') : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{Math.round(percentage)}%</span>
      {ChargingGlyph && <ChargingGlyph className="h-3 w-3" />}
      {showSleeping && <Moon className="h-3 w-3 text-blue-300" />}
      {variant === 'full' && isPowered(charging) && (
        <span className="text-foreground-subtle">{charging}</span>
      )}
    </span>
  )
}
