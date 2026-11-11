import { Select } from '../../primitives/select'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { type CSSProperties, type ReactNode } from 'react'
import type { ClimateControlStatus, HvacMode } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice.js'
import { cn } from '../../lib/cn.js'
import type { ControlPanelProps } from './types.js'
import { MODE_TEXT_COLOR, nextClimateTarget, resolveClimateTempStep } from './climate-panel.js'

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

// Scoped keyframes — transform/opacity only (compositor-cheap).
export const KEYFRAMES = `
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

export function AcPanel({ trpc, deviceId, optimistic }: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.climateControl,
    slice: (d) => d.state.climateControl,
  })

  const { display, applyOptimisticAction } = useOptimisticSlice<ClimateControlStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null
  if (display === undefined) return null

  const busy = !available

  // ── Compact layout (device-row inline) ──────────────────────────────────────
  return (
    <div data-mode={display.mode} className="inline-flex items-center gap-1">
      <span className={cn('text-xs tabular-nums font-medium', MODE_TEXT_COLOR[display.mode])}>
        {display.target !== null ? (
          <>
            {display.target}°
            {display.currentTemp !== null && (
              <span className="text-foreground-subtle font-normal"> ({display.currentTemp}°)</span>
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
                applyOptimisticAction({ target: next }, () => cap.setTarget({ target: next }))
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
                applyOptimisticAction({ target: next }, () => cap.setTarget({ target: next }))
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

      <Select
        aria-label={t('uiLibrary.acPanel.mode', 'Mode')}
        bare
        value={display.mode}
        disabled={busy}
        onChange={(e) => {
          e.stopPropagation()
          const mode = display.availableModes.find((m) => m === e.target.value)
          if (!busy && mode) {
            applyOptimisticAction({ mode }, () => cap.setMode({ mode }))
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
      </Select>
    </div>
  )
}

// ── Small building blocks ─────────────────────────────────────────────────────

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
export function AirflowViz({
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

/** Big spinning fan for `fan_only` mode. `color` may be `currentColor`, so a
 *  caller can tint it with a theme text-token class (HeroScene does). */
export function FanBlades({
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
      style={{
        animation: `acv-spin ${periodSec}s linear infinite`,
        transformOrigin: '50% 50%',
      }}
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
