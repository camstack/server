/**
 * Water-heater controls for a `DeviceType.WaterHeater` device.
 *
 * Reads the `water-heater` cap status slice (current / target temp /
 * operation mode / away / bounds) and renders:
 *   - WaterHeaterInlineControl (device-list row): a compact
 *     `current°→target°` readout + a tiny mode hint. Row-narrow.
 *   - WaterHeaterHeroCard (device-detail hero): a bespoke state-tinted
 *     tank / boiler SVG (water fill + heating-element glow when actively
 *     heating) in the framed-box language, a target-temp stepper with
 *     min/max clamp, an operation-mode `<select>`, an "Away" toggle
 *     (only when `away !== null`), and the current-temp readout.
 *
 * Mirrors the climate / valve controls' `useDeviceCapability` +
 * `useOptimisticSlice` pattern. Controls are gated on `available`. The
 * decorative SVG is aria-hidden.
 */
import { useId, type ReactNode } from 'react'
import { Power } from 'lucide-react'
import type { WaterHeaterStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'
import { Stepper } from './atoms'

/** The mutations the `water-heater` cap exposes (deviceId injected by the proxy). */
interface WaterHeaterCap {
  readonly setTargetTemp: (input: { temp: number }) => Promise<void>
  readonly setOperationMode: (input: { mode: string }) => Promise<void>
  readonly setAway: (input: { on: boolean }) => Promise<void>
}

/** Heating phase derived from the slice — drives the tank tint + element glow. */
export type WaterHeaterPhase = 'heating' | 'idle' | 'off'

export interface WaterHeaterTint {
  /** Tailwind class for the wash behind the tank. */
  readonly glow: string
  /** Tailwind text token driving the tank via currentColor. */
  readonly accent: string
  /** Whether to render the heating-element glow. */
  readonly heating: boolean
}

/**
 * Pure helper — maps a phase to a tint. Exhaustive over WaterHeaterPhase
 * (a new member fails the build).
 *
 *   heating → warning (element glow)
 *   idle    → primary (warm but settled)
 *   off     → muted
 */
export function waterHeaterTint(phase: WaterHeaterPhase): WaterHeaterTint {
  switch (phase) {
    case 'heating':
      return { glow: 'bg-warning/10', accent: 'text-warning', heating: true }
    case 'idle':
      return { glow: 'bg-primary/10', accent: 'text-primary', heating: false }
    case 'off':
      return { glow: 'bg-transparent', accent: 'text-foreground-subtle', heating: false }
  }
}

/**
 * Heuristic heating phase: off when the operation mode is 'off' (or null);
 * heating when current < target (actively warming); otherwise idle.
 */
export function waterHeaterPhase(
  operationMode: string | null,
  currentTemp: number | null,
  targetTemp: number | null,
): WaterHeaterPhase {
  if (operationMode === null || operationMode === 'off') return 'off'
  if (currentTemp !== null && targetTemp !== null && currentTemp < targetTemp) return 'heating'
  return 'idle'
}

function useWaterHeater(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<WaterHeaterCap, WaterHeaterStatus>({
    trpc,
    deviceId,
    cap: (d) => d.waterHeater as WaterHeaterCap | undefined,
    slice: (d) => d.state.waterHeater,
  })
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * WaterHeaterInlineControl — compact current→target readout + mode hint
 * for a device-list row. Must NOT blow out the row width.
 */
export function WaterHeaterInlineControl({
  trpc,
  deviceId,
  optimistic,
}: DeviceControlProps): ReactNode {
  const { cap, slice } = useWaterHeater(trpc, deviceId)
  const { display } = useOptimisticSlice<WaterHeaterStatus>(slice, { enabled: optimistic ?? true })

  if (cap === undefined) return null
  if (display === undefined) return null

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-foreground-subtle">
      <span className="tabular-nums">
        {display.currentTemp !== null && (
          <>
            {display.currentTemp}°<span className="mx-0.5">→</span>
          </>
        )}
        {display.targetTemp !== null ? `${display.targetTemp}°` : '—'}
      </span>
      {display.operationMode !== null && (
        <span className="capitalize text-foreground-subtle/80">
          · {display.operationMode.replace(/_/g, ' ')}
        </span>
      )}
    </div>
  )
}

// ── Tank graphic ────────────────────────────────────────────────────────────

interface WaterHeaterGraphicProps {
  /** 0..100 — drives the water-fill level (current/target fraction). */
  readonly fillPct: number
  readonly tint: WaterHeaterTint
}

/**
 * WaterHeaterGraphic — a framed cylindrical tank / boiler illustration in
 * the SAME visual language as the valve / humidifier graphic (w-28 h-36
 * rounded bordered box, gradient bg, overflow-hidden, inset white shadow).
 *
 * A vertical cylinder with a water-fill level that rises with `fillPct`;
 * a heating-element coil at the base glows when actively heating.
 * State-tinted via `waterHeaterTint`. Decorative — aria-hidden.
 */
function WaterHeaterGraphic({ fillPct, tint }: WaterHeaterGraphicProps): ReactNode {
  // Tank body spans y≈18..86 (height 68). Fill rises from the bottom.
  const fillTop = 86 - (Math.min(100, Math.max(0, fillPct)) / 100) * 68

  // Unique per-instance clipPath id — a document-global static id would
  // collide if two water-heater graphics render in the same DOM.
  const uid = useId()
  const clipId = `water-heater-tank-clip-${uid}`

  return (
    <div
      data-testid="water-heater-graphic"
      aria-hidden="true"
      className="relative w-28 h-36 rounded border-2 border-border bg-gradient-to-b from-surface-hover to-surface overflow-hidden flex-shrink-0"
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.06)' }}
    >
      <div className={cn('absolute inset-0 transition-colors duration-300', tint.glow)} />

      <div className={cn('absolute inset-0 flex items-center justify-center', tint.accent)}>
        <svg viewBox="0 0 100 100" className="w-24 h-28" fill="none">
          <defs>
            <clipPath id={clipId}>
              <rect x="30" y="18" width="40" height="68" rx="14" />
            </clipPath>
          </defs>

          {/* Water fill inside the tank, clipped to the cylinder */}
          <g clipPath={`url(#${clipId})`}>
            <rect
              x="28"
              y={fillTop}
              width="44"
              height="72"
              fill="currentColor"
              fillOpacity="0.32"
              className="transition-all duration-300"
            />
          </g>

          {/* Tank outline */}
          <rect
            x="30"
            y="18"
            width="40"
            height="68"
            rx="14"
            fill="currentColor"
            fillOpacity="0.06"
            stroke="currentColor"
            strokeWidth="2.5"
          />

          {/* Top cap / inlet pipe */}
          <line
            x1="50"
            y1="18"
            x2="50"
            y2="8"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <rect x="40" y="6" width="20" height="5" rx="2" fill="currentColor" fillOpacity="0.6" />

          {/* Heating-element coil at the base */}
          <g
            className={tint.heating ? 'animate-pulse' : undefined}
            opacity={tint.heating ? 0.9 : 0.35}
          >
            <path
              d="M38 74 q4 -6 8 0 q4 6 8 0 q4 -6 8 0"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </g>

          {/* Temperature gauge dot */}
          <circle
            cx="62"
            cy="34"
            r="3.5"
            stroke="currentColor"
            strokeWidth="2"
            fill={tint.heating ? 'currentColor' : 'none'}
            fillOpacity="0.6"
          />
        </svg>
      </div>
    </div>
  )
}

// ── Hero ────────────────────────────────────────────────────────────────────

/**
 * WaterHeaterHeroCard — full control surface for the device-detail hero.
 *
 * Bespoke tank graphic + a large current-temp readout + a target-temp
 * stepper (clamped to min/maxTemp) + an operation-mode `<select>` + an
 * "Away" toggle (only when `away !== null`) + the current-temp readout.
 * Gated on `available`. Only hides when the device truly has no
 * water-heater cap.
 */
export function WaterHeaterHeroCard({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useWaterHeater(trpc, deviceId)
  const { display, applyOptimistic } = useOptimisticSlice<WaterHeaterStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null
  if (display === undefined) return null

  const busy = !available
  const phase = waterHeaterPhase(display.operationMode, display.currentTemp, display.targetTemp)
  const tint = waterHeaterTint(phase)
  const current = display.currentTemp
  const target = display.targetTemp
  const min = display.minTemp
  const max = display.maxTemp

  // Fill fraction prefers current/target ratio; falls back to a half tank.
  const fillPct =
    current !== null && target !== null && target > 0
      ? Math.min(100, (current / target) * 100)
      : current !== null && max !== null && max > 0
        ? Math.min(100, (current / max) * 100)
        : 50

  const clamp = (t: number): number => {
    let next = t
    if (min !== null) next = Math.max(min, next)
    if (max !== null) next = Math.min(max, next)
    return next
  }

  const stepTarget = (delta: 1 | -1): void => {
    if (busy || target === null) return
    const next = clamp(target + delta)
    applyOptimistic({ targetTemp: next })
    void cap.setTargetTemp({ temp: next })
  }

  const toggleAway = (): void => {
    if (busy || display.away === null) return
    applyOptimistic({ away: !display.away })
    void cap.setAway({ on: !display.away })
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      {/* ── Visual + state ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-6">
        <WaterHeaterGraphic fillPct={fillPct} tint={tint} />

        <div className="flex flex-col gap-3 flex-1">
          {/* Current temperature — large readable label */}
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums text-foreground">
              {current !== null ? current : '—'}
            </span>
            <span className="text-base text-foreground-subtle">°</span>
          </div>

          {/* Target + phase hint */}
          <div className="text-xs text-foreground-subtle tabular-nums">
            {t('uiLibrary.waterHeaterControl.target', 'Target: {{value}}', {
              value: target !== null ? `${target}°` : '—',
            })}
            <span className="ml-2 capitalize">· {phase}</span>
          </div>

          {/* Target-temp stepper */}
          {target !== null && (
            <div className="w-[180px]">
              <Stepper value={target} unit="°" onDelta={stepTarget} />
            </div>
          )}
        </div>
      </div>

      {/* ── Operation-mode select ─────────────────────────────────────── */}
      {display.availableModes.length > 0 && (
        <select
          aria-label={t('uiLibrary.waterHeaterControl.operationMode', 'Operation mode')}
          value={display.operationMode ?? ''}
          disabled={busy}
          onChange={(e) => {
            e.stopPropagation()
            const mode = display.availableModes.find((m) => m === e.target.value)
            if (!busy && mode !== undefined) {
              applyOptimistic({ operationMode: mode })
              void cap.setOperationMode({ mode })
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
      )}

      {/* ── Away toggle (only when supported) ─────────────────────────── */}
      {display.away !== null && (
        <button
          type="button"
          aria-label={
            display.away
              ? t('uiLibrary.waterHeaterControl.disableAway', 'Disable away mode')
              : t('uiLibrary.waterHeaterControl.enableAway', 'Enable away mode')
          }
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            toggleAway()
          }}
          className={cn(
            'inline-flex w-fit items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
            display.away
              ? 'bg-primary text-primary-foreground'
              : 'border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        >
          <Power className="h-4 w-4" />
          {display.away
            ? t('uiLibrary.waterHeaterControl.awayOn', 'Away on')
            : t('uiLibrary.waterHeaterControl.awayOff', 'Away off')}
        </button>
      )}
    </div>
  )
}
