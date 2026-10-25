/**
 * Humidifier controls for a `DeviceType.Humidifier` device.
 *
 * Reads the `humidifier` cap status slice (on / current / target /
 * mode / action / bounds) and renders:
 *   - HumidifierInlineControl (device-list row): a compact on/off
 *     tap-toggle + a small `current%→target%` readout. Row-narrow.
 *   - HumidifierHeroCard (device-detail hero): a bespoke state-tinted
 *     droplet + rising-mist SVG in the framed-box language, an on/off
 *     toggle, a target-humidity range slider with a `%` readout, a
 *     current-humidity readout, and a mode `<select>` (only when modes
 *     are available).
 *
 * Mirrors the climate / valve controls' `useDeviceCapability` +
 * `useOptimisticSlice` pattern so the row and hero never diverge.
 * Controls are gated on `available`. The decorative SVG is aria-hidden.
 */
import { useUiText } from '../../contexts/ui-text'
import { useId, type ReactNode } from 'react'
import { Power } from 'lucide-react'
import type { HumidifierStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

/** The mutations the `humidifier` cap exposes (deviceId injected by the proxy). */
interface HumidifierCap {
  readonly setOn: (input: { on: boolean }) => Promise<void>
  readonly setTargetHumidity: (input: { humidity: number }) => Promise<void>
  readonly setMode: (input: { mode: string }) => Promise<void>
}

/** The `action` HA attribute drives the droplet / mist tint. */
export type HumidifierAction = 'humidifying' | 'drying' | 'idle' | 'off'

export interface HumidifierTint {
  /** Tailwind class for the wash behind the droplet. */
  readonly glow: string
  /** Tailwind text token driving the droplet via currentColor. */
  readonly accent: string
  /** Whether to render the upward mist dashes (actively humidifying). */
  readonly misting: boolean
}

/**
 * Pure helper — maps the device's on-state + HA `action` to a tint.
 * Exhaustive over the known action strings; an unknown / null action
 * falls back to on/off heuristics.
 *
 *   humidifying → primary (blue)
 *   drying      → warning
 *   idle / off  → muted
 */
export function humidifierTint(on: boolean, action: string | null): HumidifierTint {
  switch (action) {
    case 'humidifying':
      return { glow: 'bg-primary/15', accent: 'text-primary', misting: true }
    case 'drying':
      return { glow: 'bg-warning/10', accent: 'text-warning', misting: false }
    case 'idle':
      return { glow: 'bg-transparent', accent: 'text-foreground-subtle', misting: false }
    case 'off':
      return { glow: 'bg-transparent', accent: 'text-foreground-subtle', misting: false }
    default:
      // No `action` surface — derive from on/off.
      return on
        ? { glow: 'bg-primary/10', accent: 'text-primary', misting: true }
        : { glow: 'bg-transparent', accent: 'text-foreground-subtle', misting: false }
  }
}

function useHumidifier(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<HumidifierCap, HumidifierStatus>({
    trpc,
    deviceId,
    cap: (d) => d.humidifier as HumidifierCap | undefined,
    slice: (d) => d.state.humidifier,
  })
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * HumidifierInlineControl — compact on/off toggle + current→target readout
 * for a device-list row. Must NOT blow out the row width.
 */
export function HumidifierInlineControl({
  trpc,
  deviceId,
  optimistic,
}: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useHumidifier(trpc, deviceId)
  const { display, applyOptimistic } = useOptimisticSlice<HumidifierStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null

  const busy = !available
  const on = display?.on ?? false

  const toggle = (): void => {
    if (busy) return
    applyOptimistic({ on: !on })
    void cap.setOn({ on: !on })
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={
          on
            ? t('uiLibrary.humidifier.turnOff', 'Turn off')
            : t('uiLibrary.humidifier.turnOn', 'Turn on')
        }
        title={
          on
            ? t('uiLibrary.humidifier.turnOff', 'Turn off')
            : t('uiLibrary.humidifier.turnOn', 'Turn on')
        }
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded text-xs transition-colors',
          on
            ? 'bg-primary text-primary-foreground'
            : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
          busy && 'opacity-40 cursor-not-allowed',
        )}
      >
        <Power className="h-3.5 w-3.5" />
      </button>
      {display !== undefined && display.targetHumidity !== null && (
        <span className="tabular-nums text-xs text-foreground-subtle">
          {display.currentHumidity !== null && (
            <>
              {display.currentHumidity}%<span className="mx-0.5">→</span>
            </>
          )}
          {display.targetHumidity}%
        </span>
      )}
    </div>
  )
}

// ── Droplet graphic ─────────────────────────────────────────────────────────

interface HumidifierGraphicProps {
  /** 0..100 — drives the droplet water-fill level. */
  readonly fillPct: number
  readonly tint: HumidifierTint
}

/**
 * HumidifierGraphic — a framed droplet illustration in the SAME visual
 * language as the valve / cover graphic (w-28 h-36 rounded bordered box,
 * gradient bg, overflow-hidden, inset white shadow).
 *
 * A large water droplet whose internal fill rises with `fillPct`; mist
 * dashes animate UPWARD above the droplet when the device is actively
 * humidifying. State-tinted via `humidifierTint`. Decorative — aria-hidden.
 */
function HumidifierGraphic({ fillPct, tint }: HumidifierGraphicProps): ReactNode {
  // Droplet bounding box within the viewBox spans y≈26..82 (height 56).
  // The fill clip rises from the bottom as fillPct grows.
  const fillTop = 82 - (Math.min(100, Math.max(0, fillPct)) / 100) * 56

  // Unique per-instance clipPath id — a document-global static id would
  // collide if two humidifier graphics render in the same DOM.
  const uid = useId()
  const clipId = `humidifier-droplet-clip-${uid}`

  return (
    <div
      data-testid="humidifier-graphic"
      aria-hidden="true"
      className="relative w-28 h-36 rounded border-2 border-border bg-gradient-to-b from-surface-hover to-surface overflow-hidden flex-shrink-0"
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.06)' }}
    >
      <div className={cn('absolute inset-0 transition-colors duration-300', tint.glow)} />

      <div className={cn('absolute inset-0 flex items-center justify-center', tint.accent)}>
        <svg viewBox="0 0 100 100" className="w-24 h-28" fill="none">
          <defs>
            <clipPath id={clipId}>
              {/* Droplet silhouette: rounded teardrop. */}
              <path d="M50 26 C50 26 30 52 30 66 a20 20 0 0 0 40 0 C70 52 50 26 50 26 Z" />
            </clipPath>
          </defs>

          {/* Rising mist dashes above the droplet (humidifying only) */}
          {tint.misting && (
            <g className="animate-pulse" opacity="0.55">
              <line
                x1="42"
                y1="20"
                x2="42"
                y2="8"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="3 5"
              />
              <line
                x1="50"
                y1="18"
                x2="50"
                y2="4"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="3 5"
              />
              <line
                x1="58"
                y1="20"
                x2="58"
                y2="8"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="3 5"
              />
            </g>
          )}

          {/* Droplet outline */}
          <path
            d="M50 26 C50 26 30 52 30 66 a20 20 0 0 0 40 0 C70 52 50 26 50 26 Z"
            fill="currentColor"
            fillOpacity="0.08"
            stroke="currentColor"
            strokeWidth="2.5"
          />

          {/* Water fill inside the droplet, clipped to the silhouette */}
          <g clipPath={`url(#${clipId})`}>
            <rect
              x="28"
              y={fillTop}
              width="44"
              height="60"
              fill="currentColor"
              fillOpacity="0.4"
              className="transition-all duration-300"
            />
          </g>

          {/* Highlight sparkle */}
          <circle cx="43" cy="56" r="3" fill="currentColor" fillOpacity="0.5" />
        </svg>
      </div>
    </div>
  )
}

// ── Hero ────────────────────────────────────────────────────────────────────

/**
 * HumidifierHeroCard — full control surface for the device-detail hero.
 *
 * Bespoke droplet + mist graphic + a large target-humidity readout +
 * an on/off toggle + a target-humidity range slider (bounds from
 * min/maxHumidity ?? 0..100) + a current-humidity readout + a mode
 * `<select>` (only when modes are available). Gated on `available`.
 * Only hides when the device truly has no humidifier cap.
 */
export function HumidifierHeroCard({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useHumidifier(trpc, deviceId)
  const { display, applyOptimistic } = useOptimisticSlice<HumidifierStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null
  if (display === undefined) return null

  const busy = !available
  const tint = humidifierTint(display.on, display.action)
  const min = display.minHumidity ?? 0
  const max = display.maxHumidity ?? 100
  const target = display.targetHumidity
  const current = display.currentHumidity
  // Droplet fill prefers the current reading, falling back to the target.
  const fillPct = current ?? target ?? 0

  const toggle = (): void => {
    if (busy) return
    applyOptimistic({ on: !display.on })
    void cap.setOn({ on: !display.on })
  }

  const setTarget = (humidity: number): void => {
    if (busy) return
    applyOptimistic({ targetHumidity: humidity })
    void cap.setTargetHumidity({ humidity })
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      {/* ── Visual + state ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-6">
        <HumidifierGraphic fillPct={fillPct} tint={tint} />

        <div className="flex flex-col gap-3 flex-1">
          {/* Target humidity — large readable label */}
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums text-foreground">
              {target !== null ? target : '—'}
            </span>
            <span className="text-base text-foreground-subtle">%</span>
            <span className="text-xs text-foreground-subtle ml-1">
              {t('uiLibrary.humidifierControl.targetWord', 'target')}
            </span>
          </div>

          {/* Current humidity readout */}
          <div className="text-xs text-foreground-subtle tabular-nums">
            {t('uiLibrary.humidifier.current', 'Current: {{value}}', {
              value: current !== null ? `${current}%` : '—',
            })}
            {display.action !== null && <span className="ml-2 capitalize">· {display.action}</span>}
          </div>

          {/* On / off toggle */}
          <button
            type="button"
            aria-label={
              display.on
                ? t('uiLibrary.humidifier.turnOff', 'Turn off')
                : t('uiLibrary.humidifier.turnOn', 'Turn on')
            }
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
            className={cn(
              'inline-flex w-fit items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
              display.on
                ? 'bg-primary text-primary-foreground'
                : 'border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
              busy && 'opacity-40 cursor-not-allowed',
            )}
          >
            <Power className="h-4 w-4" />
            {display.on ? t('uiLibrary.humidifier.on', 'On') : t('uiLibrary.humidifier.off', 'Off')}
          </button>
        </div>
      </div>

      {/* ── Target-humidity slider ─────────────────────────────────────── */}
      <label className="flex items-center gap-2 text-xs text-foreground-subtle">
        <span className="w-12 shrink-0">{t('uiLibrary.humidifier.target', 'Target')}</span>
        <input
          aria-label={t('uiLibrary.humidifier.targetHumidity', 'Target humidity')}
          type="range"
          min={min}
          max={max}
          step={1}
          value={target ?? min}
          disabled={busy}
          className="flex-1"
          onChange={(e) => {
            setTarget(Number(e.target.value))
          }}
        />
        <span className="w-8 text-right tabular-nums">{target ?? '—'}%</span>
      </label>

      {/* ── Mode select (only when modes are available) ───────────────── */}
      {display.availableModes.length > 0 && (
        <select
          aria-label={t('uiLibrary.humidifier.mode', 'Mode')}
          value={display.mode ?? ''}
          disabled={busy}
          onChange={(e) => {
            e.stopPropagation()
            const mode = display.availableModes.find((m) => m === e.target.value)
            if (!busy && mode !== undefined) {
              applyOptimistic({ mode })
              void cap.setMode({ mode })
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
    </div>
  )
}
