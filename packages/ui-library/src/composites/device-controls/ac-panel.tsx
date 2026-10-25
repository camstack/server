import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  Ban,
  ChevronDown,
  Droplets,
  Fan,
  Feather,
  Flame,
  Heater,
  Leaf,
  type LucideIcon,
  Moon,
  MoveHorizontal,
  MoveVertical,
  Power,
  Snowflake,
  Sparkles,
  Thermometer,
  Wind,
  Zap,
} from 'lucide-react'
import type { ClimateControlStatus, HvacMode } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice.js'
import { cn } from '../../lib/cn.js'
import type { ControlPanelProps } from './types.js'
import {
  MODE_COLOR,
  MODE_TEXT_COLOR,
  nextClimateTarget,
  resolveClimateTempStep,
} from './climate-panel.js'

/** Modes that mean the device can cool, dry, or move air — an air conditioner. */
const COOLING_MODES: ReadonlySet<HvacMode> = new Set(['cool', 'heat_cool', 'dry', 'fan_only'])

/** A heater offers heat (and maybe auto/off) and none of the cooling modes. */
export function climateOffersCooling(modes: readonly HvacMode[]): boolean {
  return modes.some((mode) => COOLING_MODES.has(mode))
}

/** Setpoint track bounds. Absent when the integration did not report both ends. */
export function climateSetpointBounds(
  status: Pick<ClimateControlStatus, 'minTemp' | 'maxTemp'>,
): { readonly min: number; readonly max: number } | null {
  const min = status.minTemp
  const max = status.maxTemp
  if (typeof min !== 'number' || typeof max !== 'number') return null
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null
  return { min, max }
}

/** Map a 0–1 drag fraction onto the setpoint, snapped to `tempStep`. */
export function climateTargetFromFraction(
  fraction: number,
  bounds: { readonly min: number; readonly max: number },
  tempStep: number | null | undefined,
): number {
  const step = resolveClimateTempStep(tempStep)
  const clamped = Math.min(1, Math.max(0, fraction))
  const raw = bounds.min + clamped * (bounds.max - bounds.min)
  const steps = Math.round((raw - bounds.min) / step)
  const snapped = bounds.min + steps * step
  const rounded = Math.round(snapped * 1000) / 1000
  return Math.min(bounds.max, Math.max(bounds.min, rounded))
}

/** AC-appropriate short mode labels. Exhaustive over HvacMode. */
function modeLabel(t: UiTextFn, mode: HvacMode): string {
  switch (mode) {
    case 'cool':
      return t('uiLibrary.acPanel.modeCool', 'Cool')
    case 'heat':
      return t('uiLibrary.acPanel.modeHeat', 'Heat')
    case 'auto':
      return t('uiLibrary.acPanel.modeAuto', 'Auto')
    case 'heat_cool':
      return t('uiLibrary.acPanel.modeHeatCool', 'Heat·Cool')
    case 'fan_only':
      return t('uiLibrary.acPanel.modeFan', 'Fan')
    case 'dry':
      return t('uiLibrary.acPanel.modeDry', 'Dry')
    case 'off':
      return t('uiLibrary.acPanel.modeOff', 'Off')
  }
}

/** Per-mode icon (lucide). Exhaustive over HvacMode. */
const MODE_ICON: Record<HvacMode, LucideIcon> = {
  cool: Snowflake,
  heat: Flame,
  auto: Sparkles,
  heat_cool: Thermometer,
  fan_only: Fan,
  dry: Droplets,
  off: Power,
} satisfies Record<HvacMode, LucideIcon>

/** Mode accent hex — drives the airflow particles, the glow, and the target
 *  value colour. Mirrors the thermostat gauge palette. Exhaustive. */
const MODE_ACCENT: Record<HvacMode, string> = {
  heat: '#f59e0b',
  cool: '#60a5fa',
  auto: '#c084fc',
  heat_cool: '#e879f9',
  fan_only: '#94a3b8',
  dry: '#22d3ee',
  off: '#a1a1aa',
} satisfies Record<HvacMode, string>

/** Title-case a snake/lower token for a selector option ('medium_low' → 'Medium
 *  low', 'turbo' → 'Turbo'). Shared by the fan + preset selectors. */
function fanLabel(token: string): string {
  const spaced = token.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Preset → icon. Unknown presets fall back to a neutral sparkle. */
function presetIcon(preset: string): LucideIcon {
  switch (preset) {
    case 'turbo':
      return Zap
    case 'quiet':
      return Feather
    case 'sleep':
      return Moon
    case 'eco':
      return Leaf
    case '8c_heat':
      return Snowflake
    case 'none':
      return Ban
    default:
      return Sparkles
  }
}

/**
 * Fan level → airflow animation period. Higher speed ⇒ shorter period. Unknown
 * strings fall back to a medium pace. Turbo (a preset) shortens it further.
 */
function airflowPeriodSec(fanMode: string): number {
  switch (fanMode) {
    case 'high':
      return 1.0
    case 'medium_high':
      return 1.3
    case 'medium':
      return 1.6
    case 'medium_low':
      return 1.9
    case 'low':
      return 2.2
    default:
      return 1.8
  }
}

// Scoped keyframes — transform/opacity only (compositor-cheap).
const KEYFRAMES = `
@keyframes acv-fall { 0%{transform:translateY(-1.75rem);opacity:0} 18%{opacity:.7} 82%{opacity:.7} 100%{transform:translateY(7.5rem);opacity:0} }
@keyframes acv-rise { 0%{transform:translateY(7.5rem);opacity:0} 18%{opacity:.7} 82%{opacity:.7} 100%{transform:translateY(-1.75rem);opacity:0} }
@keyframes acv-sway { 0%,100%{transform:translateX(-9%)} 50%{transform:translateX(9%)} }
@keyframes acv-swing-h { 0%,100%{transform:translateX(-22%)} 50%{transform:translateX(22%)} }
@keyframes acv-swing-v { 0%,100%{transform:translateY(-22%)} 50%{transform:translateY(22%)} }
@keyframes acv-spin { to { transform:rotate(360deg) } }
@keyframes acv-glow { 0%,100%{opacity:.35;transform:scale(1)} 50%{opacity:.6;transform:scale(1.06)} }
@media (prefers-reduced-motion: reduce) {
  .acv-streak, .acv-fan, .acv-sway-wrap, .acv-glow, .acv-swing { animation: none !important; }
}
`

export function AcPanel({ trpc, deviceId, layout, optimistic }: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.climateControl,
    slice: (d) => d.state.climateControl,
  })

  const { display, applyOptimistic } = useOptimisticSlice<ClimateControlStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null
  if (display === undefined) return null

  const busy = !available

  // ── Compact layout (device-row inline) ──────────────────────────────────────
  if (layout === 'compact') {
    return (
      <div data-mode={display.mode} className="inline-flex items-center gap-1">
        <span className={cn('text-xs tabular-nums font-medium', MODE_TEXT_COLOR[display.mode])}>
          {display.target !== null ? (
            <>
              {display.target}°
              {display.currentTemp !== null && (
                <span className="text-foreground-subtle font-normal">
                  {' '}
                  ({display.currentTemp}°)
                </span>
              )}
            </>
          ) : display.currentTemp !== null ? (
            <span className="text-foreground-subtle">{display.currentTemp}°</span>
          ) : null}
        </span>

        {display.target !== null && (
          <>
            <button
              type="button"
              aria-label={t('uiLibrary.acPanel.decrease', 'Decrease target')}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy && display.target !== null) {
                  const next = nextClimateTarget(display.target, -1, display)
                  applyOptimistic({ target: next })
                  void cap.setTarget({ target: next })
                }
              }}
              className={cn(
                'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors text-xs',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              −
            </button>
            <button
              type="button"
              aria-label={t('uiLibrary.acPanel.increase', 'Increase target')}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy && display.target !== null) {
                  const next = nextClimateTarget(display.target, 1, display)
                  applyOptimistic({ target: next })
                  void cap.setTarget({ target: next })
                }
              }}
              className={cn(
                'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors text-xs',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              +
            </button>
          </>
        )}

        <select
          aria-label={t('uiLibrary.acPanel.mode', 'Mode')}
          value={display.mode}
          disabled={busy}
          onChange={(e) => {
            e.stopPropagation()
            const mode = display.availableModes.find((m) => m === e.target.value)
            if (!busy && mode) {
              applyOptimistic({ mode })
              void cap.setMode({ mode })
            }
          }}
          className={cn(
            'bg-transparent px-0.5 text-xs text-foreground-subtle hover:text-foreground cursor-pointer',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        >
          {display.availableModes.map((m) => (
            <option key={m} value={m}>
              {modeLabel(t, m)}
            </option>
          ))}
        </select>
      </div>
    )
  }

  // ── Full layout (hero card) ──────────────────────────────────────────────────
  const accent = MODE_ACCENT[display.mode]
  const on = display.mode !== 'off'
  const heatingOnly = !climateOffersCooling(display.availableModes)
  const setpointBounds = climateSetpointBounds(display)
  const CurrentPresetIcon = presetIcon(display.preset)
  const boost = display.preset === 'turbo'
  const period = Math.max(0.55, airflowPeriodSec(display.fanMode) * (boost ? 0.6 : 1))

  // Swing exposure is gated on the LIVE status field (null ⇒ hidden). The
  // provider's per-device filter nulls a hidden axis, so this reflects the
  // operator's choice immediately without relying on the (slower) features meta.
  const showVSwing = display.swingVertical !== null
  const showHSwing = display.swingHorizontal !== null
  const swaying = on && (display.swingVertical === true || display.swingHorizontal === true)

  return (
    <div
      data-mode={display.mode}
      className={cn(
        'relative flex flex-col items-stretch gap-2.5 overflow-hidden rounded-lg border p-3 transition-colors',
        MODE_COLOR[display.mode],
      )}
    >
      <style>{KEYFRAMES}</style>

      {/* ── Climate hero: mode airflow backdrop + current/target temperature ─ */}
      <div className="relative z-10 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-border/50 bg-surface/30 px-3 py-3">
        {/* Animated mode airflow, dimmed as a backdrop */}
        <div className="pointer-events-none absolute inset-0 opacity-60">
          {heatingOnly && !on ? (
            <RadiatorFins />
          ) : (
            <AirflowViz
              mode={display.mode}
              accent={accent}
              periodSec={period}
              swaying={swaying}
              forceRising={heatingOnly}
            />
          )}
        </div>
        {/* Legibility scrim + mode glow */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-surface/50 via-transparent to-surface/50" />
        {on && (
          <span
            aria-hidden
            className="acv-glow pointer-events-none absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full blur-2xl"
            style={{ background: accent, animation: 'acv-glow 3.2s ease-in-out infinite' }}
          />
        )}

        {/* Mode + live readings */}
        <div
          className="relative z-10 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: accent }}
        >
          <ModeIcon mode={display.mode} heatingOnly={heatingOnly} className="h-3.5 w-3.5" />
          {modeLabel(t, display.mode)}
          {display.currentTemp !== null && (
            <span className="normal-case text-foreground-subtle">
              {t('uiLibrary.acPanel.now', '· {{temp}}° now', { temp: display.currentTemp })}
            </span>
          )}
          {display.currentHumidity !== null && (
            <span className="inline-flex items-center gap-0.5 normal-case text-foreground-subtle">
              <Droplets className="h-3 w-3" />
              {display.currentHumidity}%
            </span>
          )}
        </div>

        {/* Target control (or current-temp readout when there is no setpoint) */}
        {display.target !== null ? (
          <>
            <div className="relative z-10 flex items-center gap-3">
              <RoundStep
                label={t('uiLibrary.acPanel.decrease', 'Decrease target')}
                symbol="−"
                disabled={busy}
                onClick={() => {
                  if (busy || display.target === null) return
                  const next = nextClimateTarget(display.target, -1, display)
                  applyOptimistic({ target: next })
                  void cap.setTarget({ target: next })
                }}
              />
              <div className="flex items-baseline gap-0.5">
                <span
                  className="text-4xl font-bold leading-none tabular-nums"
                  style={{ color: accent }}
                >
                  {display.target}
                </span>
                <span className="text-lg text-foreground-subtle">°</span>
              </div>
              <RoundStep
                label={t('uiLibrary.acPanel.increase', 'Increase target')}
                symbol="+"
                disabled={busy}
                onClick={() => {
                  if (busy || display.target === null) return
                  const next = nextClimateTarget(display.target, 1, display)
                  applyOptimistic({ target: next })
                  void cap.setTarget({ target: next })
                }}
              />
            </div>
            {setpointBounds !== null && (
              <div className="relative z-10 w-full px-1">
                <RangeTrack
                  value={display.target}
                  min={setpointBounds.min}
                  max={setpointBounds.max}
                  step={display.tempStep}
                  accent={accent}
                  disabled={busy}
                  label={t('uiLibrary.acPanel.setpoint', 'Setpoint')}
                  onPreview={(next) => {
                    applyOptimistic({ target: next })
                  }}
                  onCommit={(next) => {
                    applyOptimistic({ target: next })
                    void cap.setTarget({ target: next })
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="relative z-10 flex items-baseline gap-0.5">
            <span className="text-4xl font-bold leading-none tabular-nums text-foreground">
              {display.currentTemp ?? '—'}
            </span>
            <span className="text-lg text-foreground-subtle">°</span>
          </div>
        )}
      </div>

      {/* ── Mode / Fan / Preset — three compact selectors in one row ──────── */}
      <div className="relative z-10 grid grid-cols-3 gap-2">
        <CompactSelect
          label={t('uiLibrary.acPanel.mode', 'Mode')}
          icon={
            <span style={{ color: accent }} className="flex">
              <ModeIcon mode={display.mode} heatingOnly={heatingOnly} className="h-4 w-4" />
            </span>
          }
          value={display.mode}
          options={display.availableModes.map((m) => ({ value: m, label: modeLabel(t, m) }))}
          disabled={busy}
          onChange={(v) => {
            const mode = display.availableModes.find((m) => m === v)
            if (mode) {
              applyOptimistic({ mode })
              void cap.setMode({ mode })
            }
          }}
        />
        {display.availableFanModes.length > 0 && (
          <CompactSelect
            label={t('uiLibrary.acPanel.fan', 'Fan')}
            icon={<Wind className="h-4 w-4 text-sky-500" />}
            value={display.fanMode}
            options={display.availableFanModes.map((f) => ({ value: f, label: fanLabel(f) }))}
            disabled={busy}
            onChange={(v) => {
              applyOptimistic({ fanMode: v })
              void cap.setFanMode({ fanMode: v })
            }}
          />
        )}
        {display.availablePresets.length > 0 && (
          <CompactSelect
            label={t('uiLibrary.acPanel.preset', 'Preset')}
            icon={<CurrentPresetIcon className="h-4 w-4 text-emerald-500" />}
            value={display.preset}
            options={display.availablePresets.map((p) => ({ value: p, label: fanLabel(p) }))}
            disabled={busy}
            onChange={(v) => {
              applyOptimistic({ preset: v })
              void cap.setPreset({ preset: v })
            }}
          />
        )}
      </div>

      {/* ── Swing (independent V / H toggles, gated on live status) ────────── */}
      {(showVSwing || showHSwing) && (
        <Field label={t('uiLibrary.acPanel.swing', 'Swing')}>
          <div className="grid grid-cols-2 gap-1">
            {showVSwing && (
              <SwingToggle
                axis="vertical"
                on={display.swingVertical ?? false}
                busy={busy}
                onToggle={(next) => {
                  applyOptimistic({ swingVertical: next })
                  void cap.setSwingVertical({ on: next })
                }}
              />
            )}
            {showHSwing && (
              <SwingToggle
                axis="horizontal"
                on={display.swingHorizontal ?? false}
                busy={busy}
                onToggle={(next) => {
                  applyOptimistic({ swingHorizontal: next })
                  void cap.setSwingHorizontal({ on: next })
                }}
              />
            )}
          </div>
        </Field>
      )}
    </div>
  )
}

// ── Small building blocks ─────────────────────────────────────────────────────

/** Labelled control group — a small uppercase header above its control. */
function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="relative z-10 flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
        {label}
      </span>
      {children}
    </div>
  )
}

function ModeIcon({
  mode,
  heatingOnly = false,
  className,
}: {
  readonly mode: HvacMode
  readonly heatingOnly?: boolean
  readonly className?: string
}): ReactNode {
  const Icon = heatingOnly && mode === 'heat' ? Heater : MODE_ICON[mode]
  return <Icon className={className} aria-hidden />
}

/** Compact labelled dropdown — a leading icon + native `<select>` + chevron,
 *  used for the Mode / Fan / Preset selectors so all three fit in one row. */
function CompactSelect({
  label,
  icon,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly icon: ReactNode
  readonly value: string
  readonly options: readonly { value: string; label: string }[]
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
        {label}
      </span>
      <div
        className={cn(
          'flex items-center gap-1 overflow-hidden rounded-lg border border-border/60 bg-surface-subtle px-1.5 py-1.5',
          disabled && 'opacity-40',
        )}
      >
        <span className="flex shrink-0">{icon}</span>
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            e.stopPropagation()
            if (!disabled) onChange(e.target.value)
          }}
          className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-xs font-medium text-foreground outline-none"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="h-3 w-3 shrink-0 text-foreground-subtle" />
      </div>
    </div>
  )
}

/** Circular ± button for the target. */
function RoundStep({
  label,
  symbol,
  disabled,
  onClick,
}: {
  readonly label: string
  readonly symbol: string
  readonly disabled: boolean
  readonly onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-lg leading-none text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground active:scale-95',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      {symbol}
    </button>
  )
}

/** Setpoint track. Drag previews; the command is sent when the pointer is released. */
function RangeTrack({
  value,
  min,
  max,
  step,
  accent,
  disabled,
  label,
  onPreview,
  onCommit,
}: {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number | null | undefined
  readonly accent: string
  readonly disabled: boolean
  readonly label: string
  readonly onPreview: (next: number) => void
  readonly onCommit: (next: number) => void
}): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const frac = Math.min(1, Math.max(0, (shown - min) / (max - min)))
  const pct = `${frac * 100}%`

  const tempAt = (clientX: number): number => {
    const el = trackRef.current
    if (el === null) return value
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return value
    return climateTargetFromFraction((clientX - rect.left) / rect.width, { min, max }, step)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled) return
    event.stopPropagation()
    event.preventDefault()
    draggingRef.current = true
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    const next = tempAt(event.clientX)
    setDraft(next)
    onPreview(next)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || !draggingRef.current) return
    event.stopPropagation()
    const next = tempAt(event.clientX)
    setDraft(next)
    onPreview(next)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    event.stopPropagation()
    draggingRef.current = false
    const next = tempAt(event.clientX)
    setDraft(null)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onCommit(next)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const current = draft ?? value
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      onCommit(nextClimateTarget(current, 1, { tempStep: step, minTemp: min, maxTemp: max }))
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      onCommit(nextClimateTarget(current, -1, { tempStep: step, minTemp: min, maxTemp: max }))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onCommit(min)
    } else if (event.key === 'End') {
      event.preventDefault()
      onCommit(max)
    }
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={cn(
        'mt-1 w-full touch-none select-none py-2',
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-ew-resize',
      )}
    >
      <div className="relative h-1.5 w-full rounded-full bg-surface-subtle">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: pct, background: accent }}
        />
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface shadow"
          style={{ left: pct, background: accent }}
        />
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] tabular-nums text-foreground-subtle">
        <span>{min}°</span>
        <span>{max}°</span>
      </div>
    </div>
  )
}

/** Fan strength meter — 5 ascending bars (fill = level) or a wind glyph for
 *  auto; the active bars pulse subtly via the spinning fan in the airflow. */
interface AirflowVizProps {
  readonly mode: HvacMode
  readonly accent: string
  readonly periodSec: number
  readonly swaying: boolean
  /** Heater: the same streaks always rise, including auto. */
  readonly forceRising?: boolean
}

/**
 * Animated centerpiece. `fan_only` renders a spinning fan; `off` a dim static
 * vent; every active mode renders drifting particles that FALL (cool/dry/auto)
 * or RISE (heat), with a horizontal sweep overlaid when a swing axis is active.
 */
function AirflowViz({
  mode,
  accent,
  periodSec,
  swaying,
  forceRising = false,
}: AirflowVizProps): ReactNode {
  const columns = [0, 1, 2, 3, 4, 5]
  const rising = forceRising || mode === 'heat'
  const isDroplet = mode === 'dry'

  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      {mode === 'off' ? (
        <div className="flex h-full items-center justify-center gap-2 opacity-30">
          {columns.map((i) => (
            <span key={i} className="h-8 w-1 rounded-full bg-foreground-subtle opacity-40" />
          ))}
        </div>
      ) : mode === 'fan_only' ? (
        <div className="flex h-full items-center justify-center">
          <FanBlades color={accent} periodSec={Math.max(0.5, periodSec * 0.7)} size={56} />
        </div>
      ) : (
        <div
          data-testid={forceRising ? 'climate-heat-rise' : undefined}
          className={cn('acv-sway-wrap absolute inset-0', swaying && 'acv-sway')}
          style={swaying ? { animation: 'acv-sway 2.6s ease-in-out infinite' } : undefined}
        >
          {columns.map((i) => {
            const streakStyle: CSSProperties = {
              left: `${8 + i * 15}%`,
              width: isDroplet ? '0.4rem' : '0.3rem',
              height: isDroplet ? '0.4rem' : '1.9rem',
              background: accent,
              boxShadow: `0 0 6px ${accent}`,
              animationName: rising ? 'acv-rise' : 'acv-fall',
              animationTimingFunction: 'linear',
              animationIterationCount: 'infinite',
              animationDuration: `${periodSec}s`,
              animationDelay: `${(i % 3) * (periodSec / 3) + i * 0.05}s`,
            }
            return <span key={i} className="acv-streak absolute rounded-full" style={streakStyle} />
          })}
        </div>
      )}
    </div>
  )
}

/** Still radiator fins — the off state of a heating-only climate. */
function RadiatorFins(): ReactNode {
  return (
    <div
      data-testid="climate-radiator"
      aria-hidden
      className="flex h-full items-end justify-center gap-1.5 px-8 pb-3 opacity-40"
    >
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <span key={i} className="h-10 w-1.5 rounded-t-full bg-foreground-subtle" />
      ))}
    </div>
  )
}

/** Big spinning fan for `fan_only` mode. */
function FanBlades({
  color,
  periodSec,
  size,
}: {
  readonly color: string
  readonly periodSec: number
  readonly size: number
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="acv-fan"
      style={{ animation: `acv-spin ${periodSec}s linear infinite`, transformOrigin: '50% 50%' }}
      aria-hidden
    >
      {[0, 120, 240].map((deg) => (
        <path
          key={deg}
          d="M50 50 C 58 30, 78 26, 84 12 C 66 20, 54 34, 50 50 Z"
          fill={color}
          opacity={0.85}
          transform={`rotate(${deg} 50 50)`}
        />
      ))}
      <circle cx="50" cy="50" r="7" fill={color} />
    </svg>
  )
}

interface SwingToggleProps {
  readonly axis: 'vertical' | 'horizontal'
  readonly on: boolean
  readonly busy: boolean
  readonly onToggle: (next: boolean) => void
}

/** Swing axis toggle — a card with a MoveVertical/Horizontal glyph that
 *  oscillates along its axis when on. On/off is non-destructive → plain tap. */
function SwingToggle({ axis, on, busy, onToggle }: SwingToggleProps): ReactNode {
  const t = useUiText()
  const label =
    axis === 'vertical'
      ? t('uiLibrary.acPanel.vertical', 'Vertical')
      : t('uiLibrary.acPanel.horizontal', 'Horizontal')
  const Icon = axis === 'vertical' ? MoveVertical : MoveHorizontal
  const anim = axis === 'vertical' ? 'acv-swing-v' : 'acv-swing-h'
  return (
    <button
      type="button"
      aria-label={t('uiLibrary.acPanel.swingAxis', '{{axis}} swing', { axis: label })}
      aria-pressed={on}
      disabled={busy}
      onClick={() => {
        if (!busy) onToggle(!on)
      }}
      className={cn(
        'flex items-center justify-center gap-2 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors',
        on
          ? 'border-transparent bg-indigo-400 text-indigo-950 shadow-sm'
          : 'border-border/60 bg-surface-subtle text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      <Icon
        className="acv-swing h-4 w-4"
        aria-hidden
        style={on ? { animation: `${anim} 1.4s ease-in-out infinite` } : undefined}
      />
      {label}
    </button>
  )
}
