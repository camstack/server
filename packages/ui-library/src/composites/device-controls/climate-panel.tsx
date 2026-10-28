import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice.js'
import { cn } from '../../lib/cn.js'
import { useUiText } from '../../contexts/ui-text.js'
import type { ControlPanelProps } from './types.js'
import type { ClimateControlStatus, HvacMode } from '@camstack/types'

/** Step size for target ± buttons; defaults to 1 °C when unset or invalid. */
export function resolveClimateTempStep(tempStep: number | null | undefined): number {
  if (typeof tempStep === 'number' && Number.isFinite(tempStep) && tempStep > 0) {
    return tempStep
  }
  return 1
}

const TARGET_FALLBACK_INT_DIGITS = 2
const TARGET_MAX_DECIMALS = 3

function decimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return 0
  for (let d = 0; d < TARGET_MAX_DECIMALS; d += 1) {
    if (Math.abs(n * 10 ** d - Math.round(n * 10 ** d)) < 1e-9) return d
  }
  return TARGET_MAX_DECIMALS
}

/**
 * Character count of the longest set-temperature the device can show, derived
 * from its range and step (5-30 step 0.5 reserves "30.5" = 4). The big target
 * number reserves this width so the − / + buttons do not move when the value
 * gains decimals or loses a digit.
 */
export function climateTargetWidthChars(
  display: Pick<ClimateControlStatus, 'tempStep' | 'minTemp' | 'maxTemp'>,
): number {
  const step = resolveClimateTempStep(display.tempStep)
  const bounds = [display.minTemp, display.maxTemp].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  )
  const intDigits =
    bounds.length === 0
      ? TARGET_FALLBACK_INT_DIGITS
      : Math.max(...bounds.map((v) => String(Math.trunc(Math.abs(v))).length))
  const sign = bounds.some((v) => v < 0) ? 1 : 0
  const decimals = Math.max(decimalPlaces(step), ...bounds.map(decimalPlaces))
  return sign + intDigits + (decimals > 0 ? 1 + decimals : 0)
}

/** Static class names so Tailwind generates them (no runtime-built classes). */
const TARGET_MIN_WIDTH_CLASS: Record<number, string> = {
  1: 'min-w-[1ch]',
  2: 'min-w-[2ch]',
  3: 'min-w-[3ch]',
  4: 'min-w-[4ch]',
  5: 'min-w-[5ch]',
  6: 'min-w-[6ch]',
  7: 'min-w-[7ch]',
  8: 'min-w-[8ch]',
}

/** `min-w-[Nch]` + right alignment for the big target number. */
export function climateTargetWidthClass(
  display: Pick<ClimateControlStatus, 'tempStep' | 'minTemp' | 'maxTemp'>,
): string {
  const chars = Math.min(Math.max(climateTargetWidthChars(display), 1), 8)
  return `${TARGET_MIN_WIDTH_CLASS[chars]} text-center`
}

export function nextClimateTarget(
  current: number,
  deltaSteps: number,
  display: Pick<ClimateControlStatus, 'tempStep' | 'minTemp' | 'maxTemp'>,
): number {
  const step = resolveClimateTempStep(display.tempStep)
  let next = current + deltaSteps * step
  const min = display.minTemp
  const max = display.maxTemp
  if (typeof min === 'number' && Number.isFinite(min)) next = Math.max(next, min)
  if (typeof max === 'number' && Number.isFinite(max)) next = Math.min(next, max)
  return next
}

/**
 * Exhaustive colour map — one entry per HvacMode. Build will fail if a
 * mode is added to the enum and not reflected here (Record<HvacMode, ...>
 * + `satisfies` means TypeScript enforces full coverage).
 */
export const MODE_COLOR: Record<HvacMode, string> = {
  heat: 'border-amber-400 bg-amber-50 dark:bg-amber-950',
  cool: 'border-blue-400 bg-blue-50 dark:bg-blue-950',
  auto: 'border-purple-400 bg-purple-50 dark:bg-purple-950',
  heat_cool: 'border-fuchsia-400 bg-fuchsia-50 dark:bg-fuchsia-950',
  fan_only: 'border-slate-400 bg-slate-50 dark:bg-slate-950',
  dry: 'border-cyan-400 bg-cyan-50 dark:bg-cyan-950',
  off: 'border-zinc-300 bg-zinc-50 dark:bg-zinc-900',
} satisfies Record<HvacMode, string>

/**
 * Mode text-accent colour — applied to the compact (inline) temperature value
 * as a subtle cue, replacing the old bordered/filled mode box so the control
 * matches the borderless cover/lock inline visual language.
 */
export const MODE_TEXT_COLOR: Record<HvacMode, string> = {
  heat: 'text-amber-600 dark:text-amber-400',
  cool: 'text-blue-600 dark:text-blue-400',
  auto: 'text-purple-600 dark:text-purple-400',
  heat_cool: 'text-fuchsia-600 dark:text-fuchsia-400',
  fan_only: 'text-slate-600 dark:text-slate-400',
  dry: 'text-cyan-600 dark:text-cyan-400',
  off: 'text-foreground',
} satisfies Record<HvacMode, string>

/** Active-mode button accent colour (applied to the pressed mode chip). */
export const MODE_CHIP_ACTIVE: Record<HvacMode, string> = {
  heat: 'bg-amber-400 text-amber-950',
  cool: 'bg-blue-400 text-blue-950',
  auto: 'bg-purple-400 text-purple-950',
  heat_cool: 'bg-fuchsia-400 text-fuchsia-950',
  fan_only: 'bg-slate-400 text-slate-950',
  dry: 'bg-cyan-400 text-cyan-950',
  off: 'bg-zinc-300 text-zinc-700',
} satisfies Record<HvacMode, string>

export function ClimatePanel({
  trpc,
  deviceId,
  features: _features,
  layout,
  optimistic,
}: ControlPanelProps): ReactNode {
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
        {/* ── Temperature: target prominent (mode-colour text accent), (current) muted ── */}
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

        {/* ── Stepper (only when there is a single target) ── */}
        {display.target !== null && (
          <>
            <button
              type="button"
              aria-label={t('uiLibrary.climatePanel.decreaseTarget', 'Decrease target')}
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
              aria-label={t('uiLibrary.climatePanel.increaseTarget', 'Increase target')}
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

        {/* ── Mode selector: compact dropdown ── */}
        <select
          aria-label={t('uiLibrary.climatePanel.mode', 'Mode')}
          value={display.mode}
          disabled={busy}
          onChange={(e) => {
            e.stopPropagation()
            const mode = e.target.value as HvacMode
            if (!busy) {
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
              {m}
            </option>
          ))}
        </select>
      </div>
    )
  }

  // ── Full layout (hero card) ──────────────────────────────────────────────────
  const showDualSetpoint =
    display.mode === 'heat_cool' || (display.targetLow !== null && display.targetHigh !== null)

  const showSingleTarget = !showDualSetpoint && display.target !== null

  return (
    <div
      data-mode={display.mode}
      className={cn(
        'inline-flex items-center gap-2 rounded border px-2 py-1 transition-colors',
        MODE_COLOR[display.mode],
        'flex-col items-stretch gap-3',
      )}
    >
      {/* ── Temperature display + stepper ──────────────────────────── */}
      <div className="inline-flex items-center gap-1 text-xs tabular-nums">
        {display.currentTemp !== null && (
          <span className="text-foreground-subtle">{display.currentTemp}°</span>
        )}
        {showSingleTarget && (
          <>
            <span className="text-foreground-subtle">→</span>
            <span className="font-medium">{display.target}°</span>
            <button
              type="button"
              aria-label={t('uiLibrary.climatePanel.decreaseTarget', 'Decrease target')}
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
                'inline-flex h-4 w-4 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              −
            </button>
            <button
              type="button"
              aria-label={t('uiLibrary.climatePanel.increaseTarget', 'Increase target')}
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
                'inline-flex h-4 w-4 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              +
            </button>
          </>
        )}
      </div>

      {/* ── Mode segmented selector ─────────────────────────────────── */}
      <div className="inline-flex items-center gap-0.5 rounded bg-surface-subtle p-0.5">
        {display.availableModes.map((m) => (
          <button
            key={m}
            type="button"
            aria-label={m}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              if (!busy) {
                applyOptimistic({ mode: m })
                void cap.setMode({ mode: m })
              }
            }}
            className={cn(
              'rounded px-1.5 py-0.5 text-xs transition-colors',
              m === display.mode
                ? MODE_CHIP_ACTIVE[m]
                : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
              busy && 'opacity-40 cursor-not-allowed',
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {/* ── Full-layout extras ──────────────────────────────────────── */}
      {/* Dual setpoint */}
      {showDualSetpoint && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <label className="flex items-center gap-1">
            <span>{t('uiLibrary.climatePanel.low', 'Low')}</span>
            <input
              aria-label={t('uiLibrary.climatePanel.targetLow', 'Target low')}
              type="number"
              step={0.5}
              value={display.targetLow ?? ''}
              disabled={busy}
              onChange={(e) => {
                if (!busy) {
                  const targetLow = Number(e.target.value)
                  const targetHigh = display.targetHigh ?? targetLow
                  applyOptimistic({ targetLow })
                  void cap.setTargetRange({ targetLow, targetHigh })
                }
              }}
              className="w-14 rounded border border-border bg-surface px-1 py-0.5 tabular-nums"
            />
          </label>
          <label className="flex items-center gap-1">
            <span>{t('uiLibrary.climatePanel.high', 'High')}</span>
            <input
              aria-label={t('uiLibrary.climatePanel.targetHigh', 'Target high')}
              type="number"
              step={0.5}
              value={display.targetHigh ?? ''}
              disabled={busy}
              onChange={(e) => {
                if (!busy) {
                  const targetHigh = Number(e.target.value)
                  const targetLow = display.targetLow ?? targetHigh
                  applyOptimistic({ targetHigh })
                  void cap.setTargetRange({ targetLow, targetHigh })
                }
              }}
              className="w-14 rounded border border-border bg-surface px-1 py-0.5 tabular-nums"
            />
          </label>
        </div>
      )}

      {/* Fan mode */}
      {display.availableFanModes.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span>{t('uiLibrary.climatePanel.fan', 'Fan')}</span>
          <select
            aria-label={t('uiLibrary.climatePanel.fanMode', 'Fan mode')}
            value={display.fanMode}
            disabled={busy}
            onChange={(e) => {
              const fanMode = e.target.value
              if (!busy && fanMode) {
                applyOptimistic({ fanMode })
                void cap.setFanMode({ fanMode })
              }
            }}
            className="rounded border border-border bg-surface px-1 py-0.5"
          >
            <option value="" disabled>
              —
            </option>
            {display.availableFanModes.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Preset */}
      {display.availablePresets.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span>{t('uiLibrary.climatePanel.preset', 'Preset')}</span>
          <select
            aria-label={t('uiLibrary.climatePanel.preset', 'Preset')}
            value={display.preset}
            disabled={busy}
            onChange={(e) => {
              const preset = e.target.value
              if (!busy && preset) {
                applyOptimistic({ preset })
                void cap.setPreset({ preset })
              }
            }}
            className="rounded border border-border bg-surface px-1 py-0.5"
          >
            <option value="" disabled>
              —
            </option>
            {display.availablePresets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Humidity setpoint */}
      {display.targetHumidity !== null && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span>{t('uiLibrary.climatePanel.humidity', 'Humidity')}</span>
          <input
            aria-label={t('uiLibrary.climatePanel.targetHumidity', 'Target humidity')}
            type="range"
            min={0}
            max={100}
            step={1}
            value={display.targetHumidity}
            disabled={busy}
            onChange={(e) => {
              const targetHumidity = Number(e.target.value)
              applyOptimistic({ targetHumidity })
              if (!busy) void cap.setTargetHumidity({ targetHumidity })
            }}
          />
          <span className="tabular-nums w-8 text-right">{display.targetHumidity}%</span>
        </label>
      )}
    </div>
  )
}
