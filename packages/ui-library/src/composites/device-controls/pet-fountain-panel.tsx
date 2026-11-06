/**
 * Pet-fountain controls for a `DeviceType.PetFountain` device.
 *
 * Reads the `pet-fountain` cap status slice (water level and volume, empty,
 * pump) and renders:
 *   - PetFountainInlineControl (device-list row): the tank level and a pump
 *     on/off toggle.
 *   - PetFountainHeroCard (device-detail hero): the tank gauge with the level
 *     and the volume first and the pump switch. The pump's duty-cycle switch and run /
 *     rest minutes belong to the optional `pump-cycle` cap: that section is
 *     drawn only on a fountain that composes it (planning#366). The tank
 *     (also a `water` consumable), the filter, the cleaning and the water
 *     change are consumables: the page's Consumables section draws them (D915).
 *
 * Every reading may be unknown (`null`) and is drawn as a dash, never as
 * zero. Stored volumes are litres and durations seconds (D944); the card
 * shows millilitres and minutes. Actions are gated on `available`.
 */
import { AlertTriangle, Droplet, Droplets, Pause, Play, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  DeviceType,
  TIMED_RUN_LIMITS,
  type PetFountainStatus,
  type PumpCycleStatus,
} from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { Switch } from '../../primitives/switch'
import { TimedRunControl } from './timed-run-control'
import type { ControlPanelProps } from './types'

// Scoped keyframes — transform/opacity only. Played only while the pump runs.
const KEYFRAMES = `
@keyframes pfn-ripple { 0% { transform: scale(.45); opacity: .7 } 100% { transform: scale(1.15); opacity: 0 } }
@keyframes pfn-rise { 0% { transform: translateY(0); opacity: 0 } 20% { opacity: .8 } 100% { transform: translateY(-16px); opacity: 0 } }
.pfn-ripple, .pfn-bubble { transform-box: fill-box; transform-origin: center; }
.pfn-ripple { animation: pfn-ripple 2.4s ease-out infinite; }
.pfn-bubble { animation: pfn-rise 2.2s ease-in infinite; }
@media (prefers-reduced-motion: reduce) {
  .pfn-ripple, .pfn-bubble { animation: none !important; opacity: 0; }
}
`
const PUMP_LIMIT = TIMED_RUN_LIMITS[DeviceType.PetFountain]

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
  const { display, applyOptimisticAction } = useOptimisticSlice<PetFountainStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined || display === undefined) return null

  const busy = !available
  const fault = display.error !== null && display.error !== 'no_error' ? display.error : null
  const pumpOn = display.pumpRunning === true
  const level = display.waterLevel
  const setPump = (on: boolean): void => {
    applyOptimisticAction({ pumpRunning: on }, () => cap.setPump({ on }))
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

  return (
    <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-4 rounded-lg border border-border-subtle bg-background-elevated p-3">
        <style>{KEYFRAMES}</style>
        <TankGauge
          level={level}
          empty={display.empty === true}
          pumping={display.pumpRunning === true}
        />
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

      <Section label={t('uiLibrary.petFountain.pumpSection', 'Controls')}>
        <div className="flex flex-col gap-2">
          <SwitchRow
            icon={pumpOn ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            label={t('uiLibrary.petFountain.pump', 'Pump')}
            checked={pumpOn}
            disabled={busy}
            onChange={setPump}
          />
          <PumpCycleSection trpc={trpc} deviceId={deviceId} optimistic={optimistic} />
        </div>
      </Section>

      {PUMP_LIMIT !== undefined && (
        <TimedRunControl trpc={trpc} deviceId={deviceId} limit={PUMP_LIMIT} />
      )}
    </div>
  )
}

// ── Building blocks ───────────────────────────────────────────────────────────

/**
 * The pump's on/off duty cycle: its switch and, while it is on, the run / rest
 * minutes. It reads the optional `pump-cycle` cap and draws nothing on a fountain
 * that does not compose it. The device proxy resolves every binding of the device
 * at once and the card is already drawn from `pet-fountain`, so a missing handle
 * here is a fountain without a cycle, not a query still in flight (D315).
 */
function PumpCycleSection({
  trpc,
  deviceId,
  optimistic,
}: Pick<ControlPanelProps, 'trpc' | 'deviceId' | 'optimistic'>): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.pumpCycle,
    slice: (d) => d.state.pumpCycle,
  })
  const { display, applyOptimisticAction } = useOptimisticSlice<PumpCycleStatus>(slice, {
    enabled: optimistic ?? true,
  })
  if (cap === undefined || display === undefined) return null
  const busy = !available
  const intervalOn = display.enabled === true
  return (
    <>
      <SwitchRow
        icon={<Timer className="h-4 w-4" />}
        label={t('uiLibrary.petFountain.cycle', 'On / off cycle')}
        checked={intervalOn}
        disabled={busy}
        onChange={(on) => {
          applyOptimisticAction({ enabled: on }, () => cap.setEnabled({ on }))
        }}
      />
      {intervalOn && (
        <div className="flex flex-col gap-2">
          <MinutesStepper
            label={t('uiLibrary.petFountain.runMinutes', 'Runs for')}
            minutes={minutesOf(display.onTime)}
            disabled={busy}
            onChange={(minutes) => {
              applyOptimisticAction({ onTime: minutes * SECONDS_PER_MINUTE }, () =>
                cap.setOnMinutes({ minutes }),
              )
            }}
          />
          <MinutesStepper
            label={t('uiLibrary.petFountain.restMinutes', 'Rests for')}
            minutes={minutesOf(display.offTime)}
            disabled={busy}
            onChange={(minutes) => {
              applyOptimisticAction({ offTime: minutes * SECONDS_PER_MINUTE }, () =>
                cap.setOffMinutes({ minutes }),
              )
            }}
          />
        </div>
      )}
    </>
  )
}

/** A tank outline whose water rises with the level; danger-coloured when empty. */
function TankGauge({
  level,
  empty,
  pumping,
}: {
  readonly level: number | null
  readonly empty: boolean
  /** Pump running (true only — false and unknown stay still). */
  readonly pumping: boolean
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
        {pumping && level !== null && !empty && (
          <g data-testid="fountain-ripple">
            <ellipse
              cx="36"
              cy={top}
              rx="14"
              ry="3.5"
              fill="none"
              strokeWidth="1.5"
              className="pfn-ripple stroke-info"
            />
            <ellipse
              cx="36"
              cy={top}
              rx="14"
              ry="3.5"
              fill="none"
              strokeWidth="1.5"
              className="pfn-ripple stroke-info [animation-delay:1.2s]"
            />
            <circle cx="28" cy="54" r="1.8" className="pfn-bubble fill-info" />
            <circle
              cx="38"
              cy="56"
              r="1.4"
              className="pfn-bubble fill-info [animation-delay:0.8s]"
            />
            <circle
              cx="45"
              cy="54"
              r="1.6"
              className="pfn-bubble fill-info [animation-delay:1.5s]"
            />
          </g>
        )}
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
