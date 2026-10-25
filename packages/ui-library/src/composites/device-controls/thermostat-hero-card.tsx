import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { ClimateControlStatus, HvacMode } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { ArcKnob, KNOB_HALF_PX, Stepper } from './atoms'
import { MODE_COLOR } from './climate-panel'
import { HeatingValveReadout } from './heating-valve-readout'

/**
 * Default temperature range (Celsius) used to normalize the setpoint fraction
 * when the provider's getOptions range is not available from the status slice.
 * Covers the practical range for residential HVAC setpoints.
 * All setpoints in the climate-control cap schema are stored in Celsius.
 */
const DEFAULT_TEMP_MIN = 5
const DEFAULT_TEMP_MAX = 35

/** Compute a 0..1 fraction clamped within [min, max]. */
function toFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

/** Map a 0..1 arc fraction back to a whole-degree setpoint within [min, max]. */
function fractionToTemp(fraction: number, min: number, max: number): number {
  return Math.round(min + fraction * (max - min))
}

// ── SVG gauge constants ───────────────────────────────────────────────────────

/** Gauge dimensions — the SVG viewBox is 176×176, radius 76, stroke-width 12. */
const GAUGE_SIZE = 176
const GAUGE_RADIUS = 76
/** Arc circumference = 2π × r. The visible arc spans 270° (gap 90° at bottom). */
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS
/** 270 / 360 of the full circumference — the visible arc length. */
const GAUGE_ARC_LENGTH = GAUGE_CIRCUMFERENCE * (270 / 360)
/** Distance from the rotating knob container's top edge to the knob's top edge,
 *  seating the knob centre on the ring centre radius (88 − 76 − 10 = 2). */
const THERMOSTAT_KNOB_TOP_PX = GAUGE_SIZE / 2 - GAUGE_RADIUS - KNOB_HALF_PX

// ── Gauge SVG ─────────────────────────────────────────────────────────────────

type GaugeRingProps =
  | { readonly mode: 'fill'; readonly fraction: number; readonly color: string }
  | {
      readonly mode: 'band'
      readonly band: { readonly from: number; readonly to: number }
      readonly color: string
    }

/**
 * SVG ring gauge — 270° arc with a filled portion representing the setpoint fraction.
 * The SVG is rotated 135° so the gap sits at the bottom.
 *
 * Single-setpoint: use `mode="fill" fraction={0..1}`.
 * Dual-setpoint: use `mode="band" band={{ from: fractionLow, to: fractionHigh }}`.
 * The discriminated union ensures exactly one set of props is required at each call site.
 */
function GaugeRing(props: GaugeRingProps): ReactNode {
  const cx = GAUGE_SIZE / 2
  const cy = GAUGE_SIZE / 2
  const gap = GAUGE_CIRCUMFERENCE - GAUGE_ARC_LENGTH

  const fillDasharray =
    props.mode === 'band'
      ? (() => {
          const startOffset = props.band.from * GAUGE_ARC_LENGTH
          const bandLength = Math.max(0, (props.band.to - props.band.from) * GAUGE_ARC_LENGTH)
          return {
            dasharray: `${bandLength} ${GAUGE_CIRCUMFERENCE - bandLength}`,
            dashoffset: -startOffset,
          }
        })()
      : (() => {
          const fillLength = props.fraction * GAUGE_ARC_LENGTH
          return {
            dasharray: `${fillLength} ${GAUGE_CIRCUMFERENCE - fillLength}`,
            dashoffset: undefined,
          }
        })()

  return (
    <svg
      width={GAUGE_SIZE}
      height={GAUGE_SIZE}
      viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
      aria-hidden="true"
      className="absolute inset-0"
      style={{ transform: 'rotate(135deg)' }}
    >
      {/* Track */}
      <circle
        cx={cx}
        cy={cy}
        r={GAUGE_RADIUS}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={12}
        strokeDasharray={`${GAUGE_ARC_LENGTH} ${gap}`}
        strokeLinecap="round"
      />
      {/* Fill / band */}
      <circle
        cx={cx}
        cy={cy}
        r={GAUGE_RADIUS}
        fill="none"
        stroke={props.color}
        strokeWidth={12}
        strokeDasharray={fillDasharray.dasharray}
        {...(fillDasharray.dashoffset !== undefined
          ? { strokeDashoffset: fillDasharray.dashoffset }
          : {})}
        strokeLinecap="round"
      />
    </svg>
  )
}

// ── Mode colour helpers ───────────────────────────────────────────────────────

/**
 * Exhaustive hex colour map for the arc fill and knob border — one entry per
 * HvacMode. TypeScript enforces full coverage: adding a new HvacMode member
 * without updating this map is a compile error.
 */
const MODE_ARC_COLOR = {
  heat: '#f59e0b', // amber-400
  cool: '#60a5fa', // blue-400
  auto: '#c084fc', // purple-400
  heat_cool: '#e879f9', // fuchsia-400
  fan_only: '#94a3b8', // slate-400
  dry: '#22d3ee', // cyan-400
  off: '#d4d4d8', // zinc-300
} satisfies Record<HvacMode, string>

// ── ThermostatHeroCard ────────────────────────────────────────────────────────

/**
 * ThermostatHeroCard — circular gauge hero for thermostat / HVAC devices.
 *
 * Renders:
 *  - SVG ring gauge: track + fill arc representing the setpoint fraction
 *  - Centered current temperature (large, prominent)
 *  - ArcKnob(s) at the setpoint fraction(s) riding the ring
 *    - Single knob for heat / cool / auto / dry modes
 *    - Two knobs (low + high) with a band fill for heat_cool mode
 *  - Stepper (single) or "Low / High" display (range) for the setpoint
 *  - Mode select
 *
 * Cap-gated: returns null when the device has no climateControl cap.
 */
export function ThermostatHeroCard({
  trpc,
  deviceId,
  features: _features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const t = useUiText()
  const climate = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.climateControl,
    slice: (d) => d.state.climateControl,
  })
  const valve = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.heatingValve,
    slice: (d) => d.state.heatingValve,
  })

  const { display, applyOptimistic } = useOptimisticSlice<ClimateControlStatus>(climate.slice, {
    enabled: optimistic ?? true,
  })

  const hasClimate = climate.cap !== undefined && display !== undefined
  const hasValve = valve.cap !== undefined

  if (!hasClimate && !hasValve) return null

  if (!hasClimate && hasValve) {
    return (
      <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border bg-surface p-4">
        <HeatingValveReadout trpc={trpc} deviceId={deviceId} layout="full" />
      </div>
    )
  }

  if (climate.cap === undefined || display === undefined) return null

  const cap = climate.cap
  const available = climate.available

  const busy = !available
  const color = MODE_ARC_COLOR[display.mode]

  const isRange =
    display.mode === 'heat_cool' || (display.targetLow !== null && display.targetHigh !== null)

  // Compute fraction(s) using the default range (provider getOptions not in the slice)
  const min = DEFAULT_TEMP_MIN
  const max = DEFAULT_TEMP_MAX

  const singleFraction =
    !isRange && display.target !== null ? toFraction(display.target, min, max) : 0

  const fractionLow =
    isRange && display.targetLow !== null ? toFraction(display.targetLow, min, max) : 0

  const fractionHigh =
    isRange && display.targetHigh !== null ? toFraction(display.targetHigh, min, max) : 0

  return (
    <div
      data-mode={display.mode}
      className={cn(
        'flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4 transition-colors',
        MODE_COLOR[display.mode],
      )}
    >
      {/* ── Circular gauge ────────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-3">
        <div className="relative" style={{ width: GAUGE_SIZE, height: GAUGE_SIZE }}>
          {/* SVG ring track + fill */}
          {isRange ? (
            <GaugeRing mode="band" band={{ from: fractionLow, to: fractionHigh }} color={color} />
          ) : (
            <GaugeRing mode="fill" fraction={singleFraction} color={color} />
          )}

          {/* ArcKnob(s) riding the ring. Drag reports a new arc fraction; this
              card owns the value (optimistic) and re-renders the knob. */}
          {isRange ? (
            <>
              <div data-testid="arc-knob">
                <ArcKnob
                  fraction={fractionLow}
                  color={color}
                  knobTopPx={THERMOSTAT_KNOB_TOP_PX}
                  onDragFraction={(f) => {
                    if (busy || display.targetHigh === null) return
                    const next = Math.min(fractionToTemp(f, min, max), display.targetHigh)
                    applyOptimistic({ targetLow: next })
                    void cap.setTargetRange({ targetLow: next, targetHigh: display.targetHigh })
                  }}
                />
              </div>
              <div data-testid="arc-knob">
                <ArcKnob
                  fraction={fractionHigh}
                  color={color}
                  knobTopPx={THERMOSTAT_KNOB_TOP_PX}
                  onDragFraction={(f) => {
                    if (busy || display.targetLow === null) return
                    const next = Math.max(fractionToTemp(f, min, max), display.targetLow)
                    applyOptimistic({ targetHigh: next })
                    void cap.setTargetRange({ targetLow: display.targetLow, targetHigh: next })
                  }}
                />
              </div>
            </>
          ) : (
            <div data-testid="arc-knob">
              <ArcKnob
                fraction={singleFraction}
                color={color}
                knobTopPx={THERMOSTAT_KNOB_TOP_PX}
                onDragFraction={(f) => {
                  if (busy) return
                  const next = fractionToTemp(f, min, max)
                  applyOptimistic({ target: next })
                  void cap.setTarget({ target: next })
                }}
              />
            </div>
          )}

          {/* Current temperature — centered label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 pointer-events-none">
            <div
              data-testid="current-temp"
              className="text-4xl font-bold tabular-nums text-foreground leading-none"
            >
              {display.currentTemp !== null ? display.currentTemp : '—'}
              <span className="text-lg text-foreground-subtle font-normal ml-0.5">°</span>
            </div>
            {/* Setpoint hint below the temp */}
            {!isRange && display.target !== null && (
              <div className="text-xs font-semibold" style={{ color }}>
                {t('uiLibrary.thermostatHeroCard.setTo', 'set {{value}}°', {
                  value: display.target,
                })}
              </div>
            )}
            {isRange && display.targetLow !== null && display.targetHigh !== null && (
              <div className="text-xs font-semibold" style={{ color }}>
                {display.targetLow}° – {display.targetHigh}°
              </div>
            )}
          </div>
        </div>

        {/* ── Setpoint control ─────────────────────────────────────────── */}
        {!isRange && display.target !== null && (
          <div className="w-[200px]">
            <Stepper
              value={`${display.target}°`}
              onDelta={(d) => {
                if (busy || display.target === null) return
                const next = display.target + d
                applyOptimistic({ target: next })
                void cap.setTarget({ target: next })
              }}
            />
          </div>
        )}
      </div>

      {hasValve ? <HeatingValveReadout trpc={trpc} deviceId={deviceId} layout="full" /> : null}

      {/* ── Mode select ──────────────────────────────────────────────────── */}
      <select
        aria-label={t('uiLibrary.thermostatHeroCard.mode', 'Mode')}
        value={display.mode}
        disabled={busy}
        onChange={(e) => {
          e.stopPropagation()
          // Type narrowing: we trust availableModes is a subset of HvacMode.
          // Using a validated cast via the cap method which validates server-side.
          const mode = e.target.value
          if (!busy && mode) {
            // applyOptimistic accepts Partial<ClimateControlStatus> — mode is a valid key
            applyOptimistic({
              mode: display.availableModes.find((m) => m === mode) ?? display.mode,
            })
            void cap.setMode({
              mode: display.availableModes.find((m) => m === mode) ?? display.mode,
            })
          }
        }}
        className={cn(
          'w-full rounded border border-border bg-surface px-3 py-1.5 text-sm',
          busy && 'opacity-40 cursor-not-allowed',
        )}
      >
        {display.availableModes.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  )
}
