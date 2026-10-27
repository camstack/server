/**
 * Robotic lawn-mower controls for a `DeviceType.LawnMower` device.
 *
 * Reads the `lawn-mower-control` cap status slice (activity /
 * batteryLevel) and renders:
 *   - LawnMowerInlineControl (device-list row): compact Mow / Pause /
 *     Dock buttons with activity-aware highlight + a battery % badge.
 *   - LawnMowerHeroCard (device-detail hero): an activity label, the
 *     full action set (Start mowing / Pause / Dock), and the battery
 *     readout.
 *
 * Mirrors the vacuum/cover controls' `useDeviceCapability` pattern so the
 * row and hero never diverge. Buttons are gated on `available`.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Play, Pause, Home, BatteryMedium, AlertTriangle } from 'lucide-react'
import type { LawnMowerControlStatus, LawnMowerActivity, DeviceCodeSeverity } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

/** The mutations the `lawn-mower-control` cap exposes (deviceId injected by the proxy). */
interface LawnMowerCap {
  readonly startMowing: (input: Record<string, never>) => Promise<void>
  readonly pause: (input: Record<string, never>) => Promise<void>
  readonly dock: (input: Record<string, never>) => Promise<void>
}

export interface LawnMowerActivityMeta {
  readonly label: string
  /** Tailwind text-colour token for the activity label. */
  readonly tone: string
}

/**
 * Pure helper — maps a LawnMowerActivity (or undefined when no slice
 * yet) to a human label + colour tone. Exhaustive switch: a new enum
 * member fails the build.
 */
export function lawnMowerActivityMeta(
  activity: LawnMowerActivity | undefined,
  t: UiTextFn = defaultUiText,
): LawnMowerActivityMeta {
  switch (activity) {
    case 'mowing':
      return { label: t('uiLibrary.lawnMowerControl.mowing', 'Mowing'), tone: 'text-primary' }
    case 'paused':
      return { label: t('uiLibrary.lawnMowerControl.paused', 'Paused'), tone: 'text-warning' }
    case 'docked':
      return { label: t('uiLibrary.lawnMowerControl.docked', 'Docked'), tone: 'text-success' }
    case 'idle':
      return { label: t('uiLibrary.lawnMowerControl.idle', 'Idle'), tone: 'text-foreground-subtle' }
    case 'error':
      return { label: t('uiLibrary.lawnMowerControl.error', 'Error'), tone: 'text-destructive' }
    case undefined:
      return {
        label: t('uiLibrary.lawnMowerControl.unknown', 'Unknown'),
        tone: 'text-foreground-subtle',
      }
  }
}

function useLawnMower(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<LawnMowerCap, LawnMowerControlStatus>({
    trpc,
    deviceId,
    cap: (d) => d.lawnMowerControl as LawnMowerCap | undefined,
    slice: (d) => d.state.lawnMowerControl,
  })
}

// ── Lawn-mower graphic ──────────────────────────────────────────────────────

/** Per-activity visual tint tokens for the framed mower graphic. */
interface LawnMowerGraphicTint {
  /** Tailwind class for the grass glow overlay tint. */
  readonly glow: string
  /** Tailwind text token driving the mower body via currentColor. */
  readonly accent: string
  /** Whether to render the charging dock under the mower. */
  readonly docked: boolean
  /** Whether to render motion lines / clippings (mowing). */
  readonly active: boolean
}

function lawnMowerGraphicTint(activity: LawnMowerActivity | undefined): LawnMowerGraphicTint {
  switch (activity) {
    case 'mowing':
      return { glow: 'bg-primary/15', accent: 'text-primary', docked: false, active: true }
    case 'docked':
      return { glow: 'bg-success/10', accent: 'text-success', docked: true, active: false }
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

// Scoped state-animation keyframes for the mower graphic (transform/opacity).
const MOWER_KEYFRAMES = `
@keyframes rg-breathe { 0%,100%{opacity:.78;transform:scale(1)} 50%{opacity:1;transform:scale(1.05)} }
@keyframes rg-zzz { 0%{opacity:0;transform:translateY(3px)} 30%{opacity:.85} 100%{opacity:0;transform:translateY(-9px)} }
@keyframes rg-spark { 0%,100%{opacity:.25;transform:scale(.9)} 50%{opacity:1;transform:scale(1.1)} }
@keyframes rg-pulse { 0%,100%{opacity:.35} 50%{opacity:.85} }
@keyframes rg-blink { 0%,49%{opacity:1} 50%,100%{opacity:.3} }
@keyframes rg-spin { to { transform:rotate(360deg) } }
@media (prefers-reduced-motion: reduce) { .rg-a { animation: none !important; } }
`

/**
 * LawnMowerGraphic — a framed robot-lawn-mower illustration in the SAME visual
 * style as the cover window (w-28 h-36 rounded bordered box, gradient bg,
 * overflow-hidden, inset white shadow), over a grass-green gradient. Tinted by
 * `lawnMowerGraphicTint` and state-ANIMATED: it breathes + emits "Zzz" when
 * dormant on the dock, shows a pulsing electricity bolt while charging, blinks
 * on error, and spins its cutting deck + streams clippings while mowing.
 * Decorative only (`aria-hidden`).
 */
function LawnMowerGraphic({
  activity,
  batteryLevel,
}: {
  readonly activity: LawnMowerActivity | undefined
  readonly batteryLevel?: number | null
}): ReactNode {
  const tint = lawnMowerGraphicTint(activity)
  const charging = tint.docked && batteryLevel != null && batteryLevel < 100
  const sleeping = tint.docked && !charging
  const erroring = activity === 'error'
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
      className="relative w-28 h-36 rounded border-2 border-border bg-gradient-to-b from-emerald-700/40 to-emerald-900/30 overflow-hidden flex-shrink-0"
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.06)' }}
    >
      <style>{MOWER_KEYFRAMES}</style>
      {/* Activity glow wash over the grass */}
      <div className={cn('absolute inset-0 transition-colors duration-300', tint.glow)} />

      <div className={cn('absolute inset-0 flex items-center justify-center', tint.accent)}>
        <svg viewBox="0 0 100 100" className="w-20 h-20" fill="none">
          {/* Charging dock base (docked only) — glows while charging */}
          {tint.docked && (
            <rect
              x="30"
              y="78"
              width="40"
              height="9"
              rx="2"
              fill="currentColor"
              opacity="0.35"
              className={cn(charging && 'rg-a')}
              style={charging ? { animation: 'rg-pulse 1.2s ease-in-out infinite' } : undefined}
            />
          )}

          {/* Motion / clipping lines (mowing only) */}
          {tint.active && (
            <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.5">
              <line x1="18" y1="36" x2="10" y2="36" className="animate-pulse" />
              <line x1="18" y1="50" x2="6" y2="50" className="animate-pulse" />
              <line x1="18" y1="64" x2="10" y2="64" className="animate-pulse" />
            </g>
          )}

          {/* Mower body (breathes when dormant, blinks on error) */}
          <g className={cn((sleeping || erroring) && 'rg-a')} style={bodyStyle}>
            <rect
              x="28"
              y="34"
              width="44"
              height="34"
              rx="8"
              fill="currentColor"
              fillOpacity="0.14"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            {/* Cutting-deck hint */}
            <line
              x1="34"
              y1="60"
              x2="66"
              y2="60"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.5"
            />
            {/* Cutting blade — spins while mowing */}
            <g
              className={cn(tint.active && 'rg-a')}
              style={
                tint.active
                  ? {
                      animation: 'rg-spin 0.9s linear infinite',
                      transformBox: 'fill-box',
                      transformOrigin: 'center',
                    }
                  : undefined
              }
            >
              <circle cx="50" cy="48" r="5" stroke="currentColor" strokeWidth="2" opacity="0.6" />
              <line
                x1="45"
                y1="48"
                x2="55"
                y2="48"
                stroke="currentColor"
                strokeWidth="2"
                opacity="0.7"
              />
            </g>
            {/* Two wheels */}
            <circle
              cx="34"
              cy="68"
              r="6"
              fill="currentColor"
              fillOpacity="0.3"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle
              cx="66"
              cy="68"
              r="6"
              fill="currentColor"
              fillOpacity="0.3"
              stroke="currentColor"
              strokeWidth="2"
            />
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

/** Tailwind text tone for a device-code severity. */
function severityTone(severity: DeviceCodeSeverity): string {
  switch (severity) {
    case 'error':
      return 'text-destructive'
    case 'warning':
      return 'text-warning'
    case 'info':
      return 'text-foreground-subtle'
  }
}

/** Mowing-progress bar + % — shown only when a progress value is present. */
function ProgressBar({ percent }: { readonly percent: number }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded bg-surface-hover overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-foreground-subtle">{Math.round(percent)}%</span>
    </div>
  )
}

/** Current device/event code line — tinted by severity; an icon for warn/error. */
function CodeLine({
  code,
  label,
  severity,
}: {
  readonly code: number
  readonly label: string | null
  readonly severity: DeviceCodeSeverity
}): ReactNode {
  const t = useUiText()
  return (
    <div className={cn('inline-flex items-center gap-1 text-xs', severityTone(severity))}>
      {severity !== 'info' && <AlertTriangle className="h-3.5 w-3.5" />}
      <span>{label ?? t('uiLibrary.lawnMowerControl.code', 'Code {{code}}', { code })}</span>
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

// ── Inline button ─────────────────────────────────────────────────────────────

interface LawnMowerIconButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}

function LawnMowerIconButton({
  label,
  busy,
  active,
  onClick,
  children,
}: LawnMowerIconButtonProps): ReactNode {
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

/**
 * LawnMowerInlineControl — compact, activity-aware mower controls for a
 * device-list row. Mow / Pause / Dock + battery badge.
 */
export function LawnMowerInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useLawnMower(trpc, deviceId)
  if (cap === undefined) return null

  const busy = !available
  const activity = slice?.activity

  const press = (fn?: (input: Record<string, never>) => Promise<void>): void => {
    if (busy || fn === undefined) return
    void fn({})
  }

  return (
    <div className="inline-flex items-center gap-1">
      <LawnMowerIconButton
        label={t('uiLibrary.lawnMowerControl.mow', 'Mow')}
        busy={busy}
        active={activity === 'mowing'}
        onClick={() => press(cap.startMowing)}
      >
        <Play className="h-3 w-3" />
      </LawnMowerIconButton>
      <LawnMowerIconButton
        label={t('uiLibrary.lawnMowerControl.pause', 'Pause')}
        busy={busy}
        active={activity === 'paused'}
        onClick={() => press(cap.pause)}
      >
        <Pause className="h-3 w-3" />
      </LawnMowerIconButton>
      <LawnMowerIconButton
        label={t('uiLibrary.lawnMowerControl.dock', 'Dock')}
        busy={busy}
        active={activity === 'docked'}
        onClick={() => press(cap.dock)}
      >
        <Home className="h-3.5 w-3.5" />
      </LawnMowerIconButton>
      {slice?.batteryLevel != null && (
        <span className="ml-1">
          <BatteryBadge level={slice.batteryLevel} />
        </span>
      )}
    </div>
  )
}

// ── Hero button ───────────────────────────────────────────────────────────────

interface LawnMowerHeroButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}

function LawnMowerHeroButton({
  label,
  busy,
  active,
  onClick,
  children,
}: LawnMowerHeroButtonProps): ReactNode {
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
 * LawnMowerHeroCard — full control surface for the device-detail hero
 * area. Activity label + action buttons + battery readout.
 */
export function LawnMowerHeroCard({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useLawnMower(trpc, deviceId)
  if (cap === undefined) return null

  const busy = !available
  const activity = slice?.activity
  const meta = lawnMowerActivityMeta(activity, t)

  const press = (fn?: (input: Record<string, never>) => Promise<void>): void => {
    if (busy || fn === undefined) return
    void fn({})
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-6">
        {/* Activity-tinted mower graphic */}
        <LawnMowerGraphic activity={activity} batteryLevel={slice?.batteryLevel ?? null} />

        <div className="flex flex-col gap-3 flex-1">
          {/* Activity + battery */}
          <div className="flex items-center justify-between">
            <span className={cn('text-3xl font-semibold', meta.tone)}>{meta.label}</span>
            {slice?.batteryLevel != null && <BatteryBadge level={slice.batteryLevel} />}
          </div>

          {/* Mowing progress (only while a task is in progress) */}
          {slice?.progress != null && <ProgressBar percent={slice.progress} />}

          {/* Current device/event code */}
          {slice?.currentCode != null && (
            <CodeLine
              code={slice.currentCode}
              label={slice.currentCodeLabel}
              severity={slice.severity}
            />
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <LawnMowerHeroButton
              label={t('uiLibrary.lawnMowerControl.startMowing', 'Start mowing')}
              busy={busy}
              active={activity === 'mowing'}
              onClick={() => press(cap.startMowing)}
            >
              <Play className="h-5 w-5" />
            </LawnMowerHeroButton>
            <LawnMowerHeroButton
              label={t('uiLibrary.lawnMowerControl.pause', 'Pause')}
              busy={busy}
              active={activity === 'paused'}
              onClick={() => press(cap.pause)}
            >
              <Pause className="h-5 w-5" />
            </LawnMowerHeroButton>
            <LawnMowerHeroButton
              label={t('uiLibrary.lawnMowerControl.dock', 'Dock')}
              busy={busy}
              active={activity === 'docked'}
              onClick={() => press(cap.dock)}
            >
              <Home className="h-5 w-5" />
            </LawnMowerHeroButton>
          </div>
        </div>
      </div>
    </div>
  )
}
