/**
 * Robot-vacuum controls for a `DeviceType.Vacuum` device.
 *
 * Reads the `vacuum-control` cap status slice (state / batteryLevel /
 * fanSpeed / availableFanSpeeds) and renders:
 *   - VacuumInlineControl (device-list row): compact Start / Pause /
 *     Return-to-base buttons with state-aware highlight + a battery %
 *     badge.
 *   - VacuumHeroCard (device-detail hero): a state glyph + label, the
 *     full action set (Start / Pause / Stop / Return / Locate), a
 *     fan-speed selector built from `availableFanSpeeds`, and the
 *     battery readout.
 *
 * Mirrors the cover/update controls' `useDeviceCapability` pattern so the
 * row and hero never diverge. Buttons are gated on `available`.
 */
import { useUiText, defaultUiText, type UiTextFn } from '../../contexts/ui-text'
import type { CSSProperties, ReactNode } from 'react'
import { Play, Pause, Square, Home, Megaphone, BatteryMedium, AlertTriangle } from 'lucide-react'
import type { VacuumControlStatus, VacuumState } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

/** The mutations the `vacuum-control` cap exposes (deviceId injected by the proxy). */
interface VacuumCap {
  readonly start: (input: Record<string, never>) => Promise<void>
  readonly pause: (input: Record<string, never>) => Promise<void>
  readonly stop: (input: Record<string, never>) => Promise<void>
  readonly returnToBase: (input: Record<string, never>) => Promise<void>
  readonly locate: (input: Record<string, never>) => Promise<void>
  readonly setFanSpeed: (input: { speed: string }) => Promise<void>
}

export interface VacuumStateMeta {
  readonly label: string
  /** Tailwind text-colour token for the state label. */
  readonly tone: string
}

/**
 * Pure helper — maps a VacuumState (or undefined when no slice yet) to a
 * human label + colour tone. Exhaustive switch: a new enum member fails
 * the build.
 */
export function vacuumStateMeta(
  state: VacuumState | undefined,
  t: UiTextFn = defaultUiText,
): VacuumStateMeta {
  switch (state) {
    case 'cleaning':
      return { label: t('uiLibrary.vacuum.cleaning', 'Cleaning'), tone: 'text-primary' }
    case 'paused':
      return { label: t('uiLibrary.vacuum.paused', 'Paused'), tone: 'text-warning' }
    case 'returning':
      return { label: t('uiLibrary.vacuum.returning', 'Returning'), tone: 'text-primary' }
    case 'docked':
      return { label: t('uiLibrary.vacuum.docked', 'Docked'), tone: 'text-success' }
    case 'drying':
      return { label: t('uiLibrary.vacuum.drying', 'Drying'), tone: 'text-warning' }
    case 'idle':
      return { label: t('uiLibrary.vacuum.idle', 'Idle'), tone: 'text-foreground-subtle' }
    case 'error':
      return { label: t('uiLibrary.vacuum.error', 'Error'), tone: 'text-destructive' }
    case undefined:
      return { label: t('uiLibrary.vacuum.unknown', 'Unknown'), tone: 'text-foreground-subtle' }
  }
}

function useVacuum(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<VacuumCap, VacuumControlStatus>({
    trpc,
    deviceId,
    cap: (d) => d.vacuumControl as VacuumCap | undefined,
    slice: (d) => d.state.vacuumControl,
  })
}

// ── Inline button ─────────────────────────────────────────────────────────────

interface VacuumIconButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}

function VacuumIconButton({
  label,
  busy,
  active,
  onClick,
  children,
}: VacuumIconButtonProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
        active && 'bg-primary text-primary-foreground',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

// ── Vacuum graphic ──────────────────────────────────────────────────────────

/** Per-state visual tint tokens for the framed vacuum graphic. */
interface VacuumGraphicTint {
  /** Tailwind class for the floor gradient overlay tint. */
  readonly glow: string
  /** Tailwind text token driving the robot body via currentColor. */
  readonly accent: string
  /** Whether to render the charging dock under the robot. */
  readonly docked: boolean
  /** Whether to render the animated activity ring (cleaning/returning). */
  readonly active: boolean
}

function vacuumGraphicTint(state: VacuumState | undefined): VacuumGraphicTint {
  switch (state) {
    case 'cleaning':
      return { glow: 'bg-primary/15', accent: 'text-primary', docked: false, active: true }
    case 'returning':
      return { glow: 'bg-primary/10', accent: 'text-primary', docked: false, active: true }
    case 'docked':
      return { glow: 'bg-success/10', accent: 'text-success', docked: true, active: false }
    case 'drying':
      return { glow: 'bg-warning/10', accent: 'text-warning', docked: true, active: false }
    case 'paused':
      return { glow: 'bg-warning/10', accent: 'text-warning', docked: false, active: false }
    case 'error':
      return { glow: 'bg-destructive/10', accent: 'text-destructive', docked: false, active: false }
    case 'idle':
      return {
        glow: 'bg-transparent',
        accent: 'text-foreground-subtle',
        docked: false,
        active: false,
      }
    case undefined:
      return {
        glow: 'bg-transparent',
        accent: 'text-foreground-subtle',
        docked: false,
        active: false,
      }
  }
}

// Scoped state-animation keyframes for the robot graphics (transform/opacity).
const ROBOT_KEYFRAMES = `
@keyframes rg-breathe { 0%,100%{opacity:.78;transform:scale(1)} 50%{opacity:1;transform:scale(1.05)} }
@keyframes rg-zzz { 0%{opacity:0;transform:translateY(3px)} 30%{opacity:.85} 100%{opacity:0;transform:translateY(-9px)} }
@keyframes rg-spark { 0%,100%{opacity:.25;transform:scale(.9)} 50%{opacity:1;transform:scale(1.1)} }
@keyframes rg-pulse { 0%,100%{opacity:.35} 50%{opacity:.85} }
@keyframes rg-blink { 0%,49%{opacity:1} 50%,100%{opacity:.3} }
@keyframes rg-spin { to { transform:rotate(360deg) } }
@media (prefers-reduced-motion: reduce) { .rg-a { animation: none !important; } }
`

/**
 * VacuumGraphic — a framed, top-down robot-vacuum illustration in the SAME
 * visual style as the cover window (w-28 h-36 rounded bordered box, gradient
 * bg, overflow-hidden, inset white shadow). State-tinted via `vacuumGraphicTint`
 * and state-ANIMATED: it breathes + emits "Zzz" when dormant on the dock, shows
 * a pulsing electricity bolt while charging, blinks on error, and keeps the
 * expanding activity ring + a spinning turret while cleaning / returning.
 * Decorative only (`aria-hidden`); the textual state label lives in the hero.
 */
function VacuumGraphic({
  state,
  batteryLevel,
}: {
  readonly state: VacuumState | undefined
  readonly batteryLevel?: number | null
}): ReactNode {
  const tint = vacuumGraphicTint(state)
  const charging = tint.docked && batteryLevel != null && batteryLevel < 100
  const sleeping = tint.docked && !charging
  const erroring = state === 'error'
  const bodyStyle: CSSProperties | undefined = sleeping
    ? {
        animation: 'rg-breathe 3.4s ease-in-out infinite',
        transformBox: 'fill-box',
        transformOrigin: 'center',
      }
    : erroring
      ? { animation: 'rg-blink 1s steps(1) infinite' }
      : undefined

  return (
    <div
      aria-hidden="true"
      className="relative w-28 h-36 rounded border-2 border-border bg-gradient-to-b from-surface-hover to-surface overflow-hidden flex-shrink-0"
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.06)' }}
    >
      <style>{ROBOT_KEYFRAMES}</style>
      {/* State glow wash over the floor */}
      <div className={cn('absolute inset-0 transition-colors duration-300', tint.glow)} />

      <div className={cn('absolute inset-0 flex items-center justify-center', tint.accent)}>
        <svg viewBox="0 0 100 100" className="w-20 h-20" fill="none">
          {/* Charging dock base (docked only) — glows while charging */}
          {tint.docked && (
            <rect
              x="34"
              y="80"
              width="32"
              height="8"
              rx="2"
              fill="currentColor"
              opacity="0.35"
              className={cn(charging && 'rg-a')}
              style={charging ? { animation: 'rg-pulse 1.2s ease-in-out infinite' } : undefined}
            />
          )}

          {/* Activity ring (cleaning/returning) */}
          {tint.active && (
            <circle
              cx="50"
              cy="50"
              r="44"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.4"
              className="animate-ping"
              style={{ transformOrigin: 'center' }}
            />
          )}

          {/* Robot body (breathes when dormant, blinks on error) */}
          <g className={cn((sleeping || erroring) && 'rg-a')} style={bodyStyle}>
            <circle
              cx="50"
              cy="50"
              r="34"
              fill="currentColor"
              fillOpacity="0.12"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            {/* Bumper arc (front) */}
            <path
              d="M 24 42 A 34 34 0 0 1 76 42"
              stroke="currentColor"
              strokeWidth="3"
              opacity="0.55"
              strokeLinecap="round"
            />
            {/* Sensor dome / turret — spins while cleaning / returning */}
            <g
              className={cn(tint.active && 'rg-a')}
              style={
                tint.active
                  ? {
                      animation: 'rg-spin 3s linear infinite',
                      transformBox: 'fill-box',
                      transformOrigin: 'center',
                    }
                  : undefined
              }
            >
              <circle
                cx="50"
                cy="50"
                r="9"
                fill="currentColor"
                fillOpacity="0.25"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle cx="50" cy="43" r="2.4" fill="currentColor" />
            </g>
          </g>

          {/* "Zzz" sleep wisp (dormant on dock) */}
          {sleeping && (
            <g fill="currentColor" fontFamily="sans-serif" fontWeight="700">
              <text
                x="64"
                y="30"
                fontSize="13"
                opacity="0.7"
                className="rg-a"
                style={{ animation: 'rg-zzz 3.4s ease-in-out infinite' }}
              >
                z
              </text>
              <text
                x="73"
                y="23"
                fontSize="10"
                opacity="0.6"
                className="rg-a"
                style={{ animation: 'rg-zzz 3.4s ease-in-out .7s infinite' }}
              >
                z
              </text>
              <text
                x="80"
                y="17"
                fontSize="8"
                opacity="0.5"
                className="rg-a"
                style={{ animation: 'rg-zzz 3.4s ease-in-out 1.4s infinite' }}
              >
                z
              </text>
            </g>
          )}

          {/* Electricity bolt (charging) */}
          {charging && (
            <path
              d="M53 20 L44 40 L50 40 L46 56 L60 34 L53 34 Z"
              fill="#fbbf24"
              stroke="#f59e0b"
              strokeWidth="1"
              className="rg-a"
              style={{
                animation: 'rg-spark 1s ease-in-out infinite',
                transformBox: 'fill-box',
                transformOrigin: 'center',
              }}
            />
          )}
        </svg>
      </div>
    </div>
  )
}

/** Battery % badge — shared between inline + hero. */
function BatteryBadge({ level }: { readonly level: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-0.5 tabular-nums text-xs text-foreground-subtle">
      <BatteryMedium className="h-3.5 w-3.5" />
      {level}%
    </span>
  )
}

/**
 * VacuumInlineControl — compact, state-aware vacuum controls for a
 * device-list row. Start / Pause / Return-to-base + battery badge.
 */
export function VacuumInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useVacuum(trpc, deviceId)
  if (cap === undefined) return null

  const busy = !available
  const state = slice?.state
  const cleaning = state === 'cleaning'

  const press = (fn?: (input: Record<string, never>) => Promise<void>): void => {
    if (busy || fn === undefined) return
    void fn({})
  }

  return (
    <div className="inline-flex items-center gap-1">
      <VacuumIconButton
        label={t('uiLibrary.vacuum.start', 'Start')}
        busy={busy}
        active={cleaning}
        onClick={() => press(cap.start)}
      >
        <Play className="h-3 w-3" />
      </VacuumIconButton>
      <VacuumIconButton
        label={t('uiLibrary.vacuum.pause', 'Pause')}
        busy={busy}
        active={state === 'paused'}
        onClick={() => press(cap.pause)}
      >
        <Pause className="h-3 w-3" />
      </VacuumIconButton>
      <VacuumIconButton
        label={t('uiLibrary.vacuum.returnToBase', 'Return to base')}
        busy={busy}
        active={state === 'returning' || state === 'docked'}
        onClick={() => press(cap.returnToBase)}
      >
        <Home className="h-3.5 w-3.5" />
      </VacuumIconButton>
      {slice?.batteryLevel != null && (
        <span className="ml-1">
          <BatteryBadge level={slice.batteryLevel} />
        </span>
      )}
    </div>
  )
}

// ── Hero button ───────────────────────────────────────────────────────────────

interface VacuumHeroButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}

function VacuumHeroButton({
  label,
  busy,
  active,
  onClick,
  children,
}: VacuumHeroButtonProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'inline-flex h-10 w-10 items-center justify-center rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
        active && 'bg-primary text-primary-foreground hover:bg-primary/90',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

/**
 * VacuumHeroCard — full control surface for the device-detail hero area.
 * State label + action buttons + fan-speed selector + battery readout.
 */
export function VacuumHeroCard({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useVacuum(trpc, deviceId)
  if (cap === undefined) return null

  const busy = !available
  const state = slice?.state
  const meta = vacuumStateMeta(state, t)
  const fanSpeeds = slice?.availableFanSpeeds ?? []

  const press = (fn?: (input: Record<string, never>) => Promise<void>): void => {
    if (busy || fn === undefined) return
    void fn({})
  }

  const onFanSpeed = (speed: string): void => {
    if (busy || speed === '') return
    void cap.setFanSpeed({ speed })
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-6">
        {/* State-tinted robot graphic */}
        <VacuumGraphic state={state} batteryLevel={slice?.batteryLevel ?? null} />

        <div className="flex flex-col gap-3 flex-1">
          {/* State + battery */}
          <div className="flex items-center justify-between">
            <span className={cn('text-3xl font-semibold', meta.tone)}>{meta.label}</span>
            {slice?.batteryLevel != null && <BatteryBadge level={slice.batteryLevel} />}
          </div>

          {/* Cleaning progress (only while a task is in progress) */}
          {slice?.progress != null && (
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded bg-surface-hover overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-500"
                  style={{ width: `${Math.max(0, Math.min(100, slice.progress))}%` }}
                />
              </div>
              <span className="tabular-nums text-xs text-foreground-subtle">
                {Math.round(slice.progress)}%
              </span>
            </div>
          )}

          {/* Error code (only when present) */}
          {slice?.errorCode != null && slice.errorCode !== 0 && (
            <div className="inline-flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>
                {slice.errorLabel ??
                  t('uiLibrary.vacuum.errorCode', 'Error {{code}}', { code: slice.errorCode })}
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <VacuumHeroButton
              label={t('uiLibrary.vacuum.start', 'Start')}
              busy={busy}
              active={state === 'cleaning'}
              onClick={() => press(cap.start)}
            >
              <Play className="h-5 w-5" />
            </VacuumHeroButton>
            <VacuumHeroButton
              label={t('uiLibrary.vacuum.pause', 'Pause')}
              busy={busy}
              active={state === 'paused'}
              onClick={() => press(cap.pause)}
            >
              <Pause className="h-5 w-5" />
            </VacuumHeroButton>
            <VacuumHeroButton
              label={t('uiLibrary.vacuum.stop', 'Stop')}
              busy={busy}
              active={false}
              onClick={() => press(cap.stop)}
            >
              <Square className="h-4 w-4" />
            </VacuumHeroButton>
            <VacuumHeroButton
              label={t('uiLibrary.vacuum.returnToBase', 'Return to base')}
              busy={busy}
              active={state === 'returning' || state === 'docked'}
              onClick={() => press(cap.returnToBase)}
            >
              <Home className="h-5 w-5" />
            </VacuumHeroButton>
            <VacuumHeroButton
              label={t('uiLibrary.vacuum.locate', 'Locate')}
              busy={busy}
              active={false}
              onClick={() => press(cap.locate)}
            >
              <Megaphone className="h-5 w-5" />
            </VacuumHeroButton>
          </div>
        </div>
      </div>

      {/* Fan-speed selector — only when the vacuum advertises speeds */}
      {fanSpeeds.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span className="w-16 shrink-0">{t('uiLibrary.vacuum.fanSpeed', 'Fan speed')}</span>
          <select
            aria-label={t('uiLibrary.vacuum.fanSpeed', 'Fan speed')}
            value={slice?.fanSpeed ?? ''}
            disabled={busy}
            onChange={(e) => {
              onFanSpeed(e.target.value)
            }}
            onClick={(e) => {
              e.stopPropagation()
            }}
            className="flex-1 rounded border border-border bg-surface px-2 py-1 text-foreground disabled:opacity-50"
          >
            {slice?.fanSpeed == null && <option value="">—</option>}
            {fanSpeeds.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
