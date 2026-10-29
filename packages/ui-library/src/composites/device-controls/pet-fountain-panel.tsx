/**
 * Pet-fountain controls for a `DeviceType.PetFountain` device.
 *
 * Reads the `pet-fountain` cap status slice (water level and volume, empty,
 * pump and its duty cycle, the water drunk) and renders:
 *   - PetFountainInlineControl (device-list row): the tank level and a pump
 *     on/off toggle.
 *   - PetFountainHeroCard (device-detail hero): the tank gauge with the level
 *     and the volume first, what the pet drank today / in 24 h / this hour /
 *     last time, the pump switch, its duty-cycle switch and the run / rest
 *     minutes. The filter is a consumable: the page's Consumables section
 *     draws it, never this card (D915).
 *
 * Every reading may be unknown (`null`) and is drawn as a dash, never as
 * zero. Stored volumes are litres and durations seconds (D944); the card
 * shows millilitres and minutes. Actions are gated on `available`.
 */
import { AlertTriangle, Droplet, Droplets, Eraser, Pause, Play, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PetFountainStatus } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Switch } from '../../primitives/switch'
import type { ControlPanelProps } from './types'

const LITRES_TO_ML = 1000
const SECONDS_PER_MINUTE = 60
const MAX_PUMP_MINUTES = 240

function millilitres(litres: number | null): string {
  return litres === null ? '—' : `${Math.round(litres * LITRES_TO_ML)} mL`
}

function minutesOf(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds / SECONDS_PER_MINUTE)
}

export function PetFountainPanel({
  trpc,
  deviceId,
  layout,
  optimistic,
}: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.petFountain,
    slice: (d) => d.state.petFountain,
  })
  const { display, applyOptimistic } = useOptimisticSlice<PetFountainStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined || display === undefined) return null

  const busy = !available
  const fault = display.error !== null && display.error !== 'no_error' ? display.error : null
  const pumpOn = display.pumpRunning === true
  const level = display.waterLevel
  const setPump = (on: boolean): void => {
    applyOptimistic({ pumpRunning: on })
    void cap.setPump({ on })
  }

  if (layout === 'compact') {
    return (
      <div className="inline-flex items-center gap-2">
        {(fault !== null || display.empty === true) && (
          <AlertTriangle
            className="h-3.5 w-3.5 text-danger"
            aria-label={fault ?? t('uiLibrary.petFountain.empty', 'Tank empty')}
          />
        )}
        <span
          className={cn(
            'inline-flex items-center gap-1 text-xs font-medium tabular-nums',
            display.empty === true ? 'text-danger' : 'text-foreground',
          )}
        >
          <Droplet className="h-3.5 w-3.5" aria-hidden />
          {level === null ? '—' : `${Math.round(level)}%`}
        </span>
        {/* The row is clickable: a toggle must not also open the device. */}
        <span onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={pumpOn}
            disabled={busy}
            aria-label={t('uiLibrary.petFountain.pump', 'Pump')}
            onCheckedChange={setPump}
          />
        </span>
      </div>
    )
  }

  const intervalOn = display.pumpIntervalEnabled === true
  const onMinutes = minutesOf(display.pumpOnTime)
  const offMinutes = minutesOf(display.pumpOffTime)

  return (
    <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-4 rounded-lg border border-border-subtle bg-background-elevated p-3">
        <TankGauge level={level} empty={display.empty === true} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'text-3xl font-bold leading-none tabular-nums',
                display.empty === true ? 'text-danger' : 'text-info',
              )}
            >
              {level === null ? '—' : `${Math.round(level)}%`}
            </span>
            <span className="text-sm tabular-nums text-foreground-muted">
              {millilitres(display.waterVolume)}
            </span>
          </div>
          <StatusLine empty={display.empty} pumpRunning={display.pumpRunning} />
        </div>
      </div>

      {fault !== null && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{fault}</span>
        </div>
      )}

      <Section label={t('uiLibrary.petFountain.consumption', 'Water drunk')}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t('uiLibrary.petFountain.today', 'Today')} value={display.todayDrink} />
          <Stat
            label={t('uiLibrary.petFountain.last24h', 'Last 24 h')}
            value={display.last24hDrink}
          />
          <Stat
            label={t('uiLibrary.petFountain.thisHour', 'This hour')}
            value={display.currentHourDrink}
          />
          <Stat
            label={t('uiLibrary.petFountain.lastDrink', 'Last drink')}
            value={display.lastDrink}
          />
        </div>
      </Section>

      <Section label={t('uiLibrary.petFountain.pumpSection', 'Controls')}>
        <div className="flex flex-col gap-2">
          <SwitchRow
            icon={pumpOn ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            label={t('uiLibrary.petFountain.pump', 'Pump')}
            checked={pumpOn}
            disabled={busy}
            onChange={setPump}
          />
          <SwitchRow
            icon={<Timer className="h-4 w-4" />}
            label={t('uiLibrary.petFountain.cycle', 'On / off cycle')}
            checked={intervalOn}
            disabled={busy}
            onChange={(on) => {
              applyOptimistic({ pumpIntervalEnabled: on })
              void cap.setPumpInterval({ on })
            }}
          />
          {intervalOn && (
            <div className="flex flex-col gap-2">
              <MinutesStepper
                label={t('uiLibrary.petFountain.runMinutes', 'Runs for')}
                minutes={onMinutes}
                disabled={busy}
                onChange={(minutes) => {
                  applyOptimistic({ pumpOnTime: minutes * SECONDS_PER_MINUTE })
                  void cap.setPumpOnMinutes({ minutes })
                }}
              />
              <MinutesStepper
                label={t('uiLibrary.petFountain.restMinutes', 'Rests for')}
                minutes={offMinutes}
                disabled={busy}
                onChange={(minutes) => {
                  applyOptimistic({ pumpOffTime: minutes * SECONDS_PER_MINUTE })
                  void cap.setPumpOffMinutes({ minutes })
                }}
              />
            </div>
          )}
        </div>
      </Section>

      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void cap.resetDailyConsumption({})}
      >
        <Eraser className="h-4 w-4" aria-hidden />
        {t('uiLibrary.petFountain.clearDaily', 'Clear daily count')}
      </Button>
    </div>
  )
}

// ── Building blocks ───────────────────────────────────────────────────────────

/** A tank outline whose water rises with the level; danger-coloured when empty. */
function TankGauge({
  level,
  empty,
}: {
  readonly level: number | null
  readonly empty: boolean
}): ReactNode {
  const t = useUiText()
  const fraction = Math.min(1, Math.max(0, (level ?? 0) / 100))
  const top = 58 - fraction * 40
  return (
    <svg
      width={72}
      height={72}
      viewBox="0 0 72 72"
      role="img"
      aria-label={
        level === null
          ? t('uiLibrary.petFountain.levelUnknown', 'Water level unknown')
          : t('uiLibrary.petFountain.levelPercent', '{{percent}}% water', {
              percent: Math.round(level),
            })
      }
      className="shrink-0"
    >
      <defs>
        <clipPath id="pfn-tank-clip">
          <rect x="18" y="14" width="36" height="46" rx="6" />
        </clipPath>
      </defs>
      <g clipPath="url(#pfn-tank-clip)">
        <rect
          x="18"
          y={top}
          width="36"
          height="46"
          className={empty ? 'fill-danger' : 'fill-info'}
          opacity={0.75}
        />
      </g>
      <rect
        x="18"
        y="14"
        width="36"
        height="46"
        rx="6"
        fill="none"
        strokeWidth="2.5"
        className="stroke-border"
      />
      <rect x="28" y="8" width="16" height="6" rx="2" className="fill-border" />
    </svg>
  )
}

function StatusLine({
  empty,
  pumpRunning,
}: {
  readonly empty: boolean | null
  readonly pumpRunning: boolean | null
}): ReactNode {
  const t = useUiText()
  if (empty === true) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
        <Droplet className="h-3.5 w-3.5" aria-hidden />
        {t('uiLibrary.petFountain.empty', 'Tank empty')}
      </span>
    )
  }
  if (pumpRunning === true) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-info">
        <Droplets className="h-3.5 w-3.5" aria-hidden />
        {t('uiLibrary.petFountain.pumpRunning', 'Pump running')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-foreground-subtle">
      <Pause className="h-3.5 w-3.5" aria-hidden />
      {pumpRunning === false
        ? t('uiLibrary.petFountain.pumpIdle', 'Pump idle')
        : t('uiLibrary.petFountain.pumpUnknown', 'Pump state unknown')}
    </span>
  )
}

function Section({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
        {label}
      </span>
      {children}
    </div>
  )
}

function Stat({
  label,
  value,
}: {
  readonly label: string
  readonly value: number | null
}): ReactNode {
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle bg-background-elevated px-3 py-2">
      <span className="text-[11px] text-foreground-subtle">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {millilitres(value)}
      </span>
    </div>
  )
}

function SwitchRow({
  icon,
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (next: boolean) => void
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-background-elevated px-3 py-2">
      <span className="inline-flex items-center gap-2 text-sm text-foreground">
        <span className="text-foreground-subtle">{icon}</span>
        {label}
      </span>
      <Switch checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onChange} />
    </div>
  )
}

function MinutesStepper({
  label,
  minutes,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly minutes: number | null
  readonly disabled: boolean
  readonly onChange: (minutes: number) => void
}): ReactNode {
  const t = useUiText()
  const current = minutes ?? 0
  const step = (delta: number): void =>
    onChange(Math.min(MAX_PUMP_MINUTES, Math.max(0, current + delta)))
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-background-elevated px-3 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label={t('uiLibrary.petFountain.decrease', 'Decrease {{label}}', { label })}
          disabled={disabled || minutes === null || current <= 0}
          onClick={() => step(-1)}
        >
          −
        </Button>
        <span className="w-14 text-center text-sm font-semibold tabular-nums text-foreground">
          {minutes === null
            ? '—'
            : t('uiLibrary.petFountain.minutes', '{{count}} min', { count: current })}
        </span>
        <Button
          variant="outline"
          size="sm"
          aria-label={t('uiLibrary.petFountain.increase', 'Increase {{label}}', { label })}
          disabled={disabled || minutes === null || current >= MAX_PUMP_MINUTES}
          onClick={() => step(1)}
        >
          +
        </Button>
      </div>
    </div>
  )
}

// ── Registry wrappers ─────────────────────────────────────────────────────────

interface DeviceControlProps {
  readonly trpc: ControlPanelProps['trpc']
  readonly deviceId: number
  readonly features: readonly string[] | undefined
  readonly optimistic?: boolean
}

export function PetFountainInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  return (
    <PetFountainPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="compact"
      optimistic={optimistic}
    />
  )
}

export function PetFountainHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  return (
    <PetFountainPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="full"
      optimistic={optimistic}
    />
  )
}
