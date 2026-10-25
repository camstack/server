import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { Fan, RefreshCw } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { FanControlStatus, SwitchStatus } from '@camstack/types'
import { DeviceFeature } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { RadialGauge } from './radial-gauge'
import { TapToggle } from './tap-toggle'

// ── Cap surfaces ──────────────────────────────────────────────────────────────

type SwitchCap = { setState: (i: { on: boolean }) => Promise<void> }
type FanControlCap = {
  setPercentage: (i: { percentage: number }) => Promise<void>
  setPreset: (i: { preset: string }) => Promise<void>
  setOscillating: (i: { oscillating: boolean }) => Promise<void>
}

/** Teal speed arc when on; muted track colour when off. */
const ARC_COLOR_ON = '#3aa6a0'
const ARC_COLOR_OFF = '#d4d4d8'

// ── FanHeroCard ───────────────────────────────────────────────────────────────

/**
 * FanHeroCard — radial speed-dial hero for Fan devices.
 *
 * Renders:
 *  - RadialGauge: draggable speed ArcKnob riding a 270° ring at the speed
 *    fraction (drag snaps to the device's percentageStep), centered fan glyph +
 *    percentage readout. The gauge is the sole speed control — no slider.
 *  - Preset selector (centered) — ONLY when the device advertises
 *    DeviceFeature.FanPreset AND the slice exposes a non-empty
 *    `availablePresets`.
 *  - TAP TOGGLE for on/off (Spec §3 — NOT a SlideToggle; slide is safety-only).
 *  - Oscillate toggle button — ONLY when the device advertises
 *    DeviceFeature.FanOscillating AND the slice exposes a non-null
 *    `oscillating` value.
 *
 * Composes two caps: `switch` (on/off) + `fan-control` (speed / oscillate).
 * Cap-gated on `switch` (always present on a Fan) — returns null without it.
 */
export function FanHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const t = useUiText()
  const sw = useDeviceCapability<SwitchCap, SwitchStatus>({
    trpc,
    deviceId,
    cap: (d) => d.switch as SwitchCap | undefined,
    slice: (d) => d.state.switch,
  })
  const fan = useDeviceCapability<FanControlCap, FanControlStatus>({
    trpc,
    deviceId,
    cap: (d) => d.fanControl as FanControlCap | undefined,
    slice: (d) => d.state.fanControl,
  })

  const swOpt = useOptimisticSlice<SwitchStatus>(sw.slice, { enabled: optimistic ?? true })
  const fanOpt = useOptimisticSlice<FanControlStatus>(fan.slice, { enabled: optimistic ?? true })

  // Cap-gate on switch — a Fan always exposes on/off.
  if (sw.cap === undefined) return null
  if (swOpt.display === undefined) return null

  const on = swOpt.display.on === true
  const swBusy = !sw.available

  const percentage = fanOpt.display?.percentage ?? 0
  const fanBusy = !fan.available
  const fraction = on ? percentage / 100 : 0
  const arcColor = on ? ARC_COLOR_ON : ARC_COLOR_OFF

  const supportsSpeed = features?.includes(DeviceFeature.FanSpeed) ?? false
  const supportsOscillate =
    (features?.includes(DeviceFeature.FanOscillating) ?? false) && fan.cap !== undefined
  const availablePresets = fanOpt.display?.availablePresets ?? []
  const supportsPreset =
    (features?.includes(DeviceFeature.FanPreset) ?? false) &&
    fan.cap !== undefined &&
    availablePresets.length > 0
  const activePreset = fanOpt.display?.preset ?? ''
  const oscillating = fanOpt.display?.oscillating === true

  const handleToggle = (): void => {
    if (swBusy) return
    const next = !on
    swOpt.applyOptimistic({ on: next })
    void sw.cap?.setState({ on: next })
  }

  const handleOscillate = (): void => {
    if (fanBusy) return
    const next = !oscillating
    fanOpt.applyOptimistic({ oscillating: next })
    void fan.cap?.setOscillating({ oscillating: next })
  }

  /** Drag the speed gauge: arc fraction → step-snapped 0..100 percentage. */
  const handleDragSpeed = (f: number): void => {
    if (fanBusy) return
    const slice = fanOpt.display
    if (slice === undefined) return
    const step =
      slice.percentageStep !== undefined && slice.percentageStep > 0 ? slice.percentageStep : 1
    const pct = Math.min(100, Math.max(0, Math.round((f * 100) / step) * step))
    fanOpt.applyOptimistic({ percentage: pct })
    void fan.cap?.setPercentage({ percentage: pct })
  }

  const handlePreset = (preset: string): void => {
    if (fanBusy || preset === '') return
    fanOpt.applyOptimistic({ preset })
    void fan.cap?.setPreset({ preset })
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      {/* ── Radial speed dial ──────────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-3">
        {supportsSpeed ? (
          <RadialGauge fraction={fraction} color={arcColor} onDragFraction={handleDragSpeed}>
            <div
              data-testid="speed-readout"
              className="text-3xl font-bold tabular-nums text-foreground leading-none"
            >
              {percentage}
              <span className="text-base text-foreground-subtle font-normal ml-0.5">%</span>
            </div>
            <Fan className="h-5 w-5 text-foreground-subtle" aria-hidden="true" />
          </RadialGauge>
        ) : (
          // Single-speed fan: no percentage to show — icon-only on/off treatment
          // (a 0% gauge would misrepresent a fan that is simply on).
          <div
            data-testid="fan-onoff-icon"
            className="flex h-[150px] w-[150px] items-center justify-center"
          >
            <Fan className="h-16 w-16" style={{ color: arcColor }} aria-hidden="true" />
          </div>
        )}
      </div>

      {/* ── Preset selector (centered, between gauge and toggle row) ────────── */}
      {supportsPreset && (
        <div className="flex justify-center">
          <label className="flex items-center gap-2 text-xs text-foreground-subtle">
            <span>{t('uiLibrary.fanHeroCard.preset', 'Preset')}</span>
            <select
              aria-label={t('uiLibrary.fanHeroCard.fanPreset', 'Fan preset')}
              value={activePreset}
              disabled={fanBusy}
              onChange={(e) => {
                e.stopPropagation()
                handlePreset(e.target.value)
              }}
              className={cn(
                'bg-surface border border-border rounded px-1 py-0.5',
                fanBusy && 'opacity-40 cursor-not-allowed',
              )}
            >
              <option value="" disabled>
                —
              </option>
              {availablePresets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* ── On/off TAP TOGGLE (NOT a slide) + oscillate ────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        {supportsOscillate ? (
          <button
            type="button"
            aria-label={t('uiLibrary.fanHeroCard.oscillate', 'Oscillate')}
            aria-pressed={oscillating}
            disabled={fanBusy}
            onClick={(e) => {
              e.stopPropagation()
              handleOscillate()
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
              oscillating
                ? 'border-success/50 bg-success/10 text-success'
                : 'border-border text-foreground-muted hover:bg-surface-hover',
              fanBusy && 'opacity-40 cursor-not-allowed',
            )}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('uiLibrary.fanHeroCard.oscillate', 'Oscillate')}
          </button>
        ) : (
          <span className="text-sm font-medium text-foreground-muted">
            {on ? t('uiLibrary.fanHeroCard.on', 'On') : t('uiLibrary.fanHeroCard.off', 'Off')}
          </span>
        )}
        <TapToggle on={on} busy={swBusy} onToggle={handleToggle} />
      </div>
    </div>
  )
}
