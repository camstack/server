/**
 * Valve controls for a `DeviceType.Valve` device.
 *
 * Reads the `valve` cap status slice (state / position) and renders:
 *   - ValveInlineControl (device-list row): compact Open / Stop / Close
 *     icon-buttons with state-aware highlight + a small position % badge.
 *   - ValveHeroCard (device-detail hero): a bespoke state-tinted pipe +
 *     gate-valve SVG that doubles as a vertical drag surface when the
 *     valve is positionable, the full action set (Open / Stop / Close),
 *     and a position slider gated on `ValvePositionable`.
 *
 * Mirrors the cover controls' `useDeviceCapability` + `useOptimisticSlice`
 * pattern so the row and hero never diverge. The button highlight reuses
 * `coverHighlight` — the valve state enum is identical to the cover one.
 * Buttons are gated on `available`.
 */
import { useUiText, defaultUiText, type UiTextFn } from '../../contexts/ui-text'
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronUp, ChevronDown, Square } from 'lucide-react'
import { type ValveStatus, type ValveState, DeviceFeature } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'
import { coverHighlight, type CoverHighlightVariant } from './cover-inline'

/** The mutations the `valve` cap exposes (deviceId injected by the proxy). */
interface ValveCap {
  readonly open: (input: Record<string, never>) => Promise<void>
  readonly close: (input: Record<string, never>) => Promise<void>
  readonly stop: (input: Record<string, never>) => Promise<void>
  readonly setPosition: (input: { position: number }) => Promise<void>
}

export interface ValveStateMeta {
  readonly label: string
  /** Tailwind text-colour token for the state label. */
  readonly tone: string
}

/**
 * Pure helper — maps a ValveState (or undefined when no slice yet) to a
 * human label + colour tone. Exhaustive switch: a new enum member fails
 * the build.
 */
export function valveStateMeta(
  state: ValveState | undefined,
  t: UiTextFn = defaultUiText,
): ValveStateMeta {
  switch (state) {
    case 'open':
      return { label: t('uiLibrary.valveControl.open', 'Open'), tone: 'text-primary' }
    case 'opening':
      return { label: t('uiLibrary.valveControl.opening', 'Opening'), tone: 'text-primary' }
    case 'closing':
      return { label: t('uiLibrary.valveControl.closing', 'Closing'), tone: 'text-warning' }
    case 'closed':
      return {
        label: t('uiLibrary.valveControl.closed', 'Closed'),
        tone: 'text-foreground-subtle',
      }
    case 'stopped':
      return { label: t('uiLibrary.valveControl.stopped', 'Stopped'), tone: 'text-warning' }
    case undefined:
      return {
        label: t('uiLibrary.valveControl.unknown', 'Unknown'),
        tone: 'text-foreground-subtle',
      }
  }
}

function useValve(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<ValveCap, ValveStatus>({
    trpc,
    deviceId,
    cap: (d) => d.valve as ValveCap | undefined,
    slice: (d) => d.state.valve,
  })
}

// ── Inline button ─────────────────────────────────────────────────────────────

interface ValveCtrlButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly variant: CoverHighlightVariant
  readonly onClick: () => void
  readonly children: ReactNode
}

function valveHighlightClass(variant: CoverHighlightVariant): string {
  switch (variant) {
    case 'accent':
      return 'bg-primary text-primary-foreground'
    case 'filled':
      return 'bg-primary/15 text-primary'
    case 'neutral':
      return ''
  }
}

function ValveCtrlButton({
  label,
  busy,
  variant,
  onClick,
  children,
}: ValveCtrlButtonProps): ReactNode {
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
        'inline-flex h-5 w-5 items-center justify-center rounded text-xs text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
        valveHighlightClass(variant),
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

/**
 * ValveInlineControl — compact, state-aware valve controls for a
 * device-list row. Open ▲ Stop ■ Close ▼ + optional position % badge.
 * Mirrors `CoverInlineControl` exactly. Must NOT blow out the row width.
 */
export function ValveInlineControl({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useValve(trpc, deviceId)
  const { display, applyOptimistic } = useOptimisticSlice<ValveStatus>(slice, {
    enabled: optimistic ?? true,
  })

  // Only hide entirely when the device has no valve cap at all. A transient
  // undefined slice must NOT remove the buttons.
  if (cap === undefined) return null

  const busy = !available
  const hl = coverHighlight(display?.state)

  const press = (
    fn?: (input: Record<string, never>) => Promise<void>,
    patch?: Partial<ValveStatus>,
  ): void => {
    if (busy || !fn) return
    if (patch !== undefined) applyOptimistic(patch)
    void fn({})
  }

  return (
    <div className="inline-flex items-center gap-1">
      <ValveCtrlButton
        label={t('uiLibrary.valveControl.open', 'Open')}
        busy={busy}
        variant={hl.up}
        onClick={() => press(cap.open, { state: 'opening' })}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </ValveCtrlButton>
      <ValveCtrlButton
        label={t('uiLibrary.valveControl.stop', 'Stop')}
        busy={busy}
        variant={hl.stop}
        onClick={() => press(cap.stop, { state: 'stopped' })}
      >
        <Square className="h-3 w-3" />
      </ValveCtrlButton>
      <ValveCtrlButton
        label={t('uiLibrary.valveControl.close', 'Close')}
        busy={busy}
        variant={hl.down}
        onClick={() => press(cap.close, { state: 'closing' })}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </ValveCtrlButton>
      {display !== undefined && display.position !== null && (
        <span className="tabular-nums text-xs text-foreground-subtle ml-1">
          {display.position}%
        </span>
      )}
    </div>
  )
}

// ── Valve graphic ──────────────────────────────────────────────────────────

/** Per-state visual tint tokens for the framed valve graphic. */
export interface ValveGraphicTint {
  /** Tailwind class for the flow-glow wash over the pipe. */
  readonly glow: string
  /** Tailwind text token driving the valve body via currentColor. */
  readonly accent: string
  /** Whether to render the animated flow dashes (open / opening). */
  readonly flowing: boolean
  /** Whether to render the transient-motion activity pulse. */
  readonly active: boolean
}

export function valveGraphicTint(state: ValveState | undefined): ValveGraphicTint {
  switch (state) {
    case 'open':
      return { glow: 'bg-primary/15', accent: 'text-primary', flowing: true, active: false }
    case 'opening':
      return { glow: 'bg-primary/10', accent: 'text-primary', flowing: true, active: true }
    case 'closing':
      return { glow: 'bg-warning/10', accent: 'text-warning', flowing: false, active: true }
    case 'closed':
      return {
        glow: 'bg-transparent',
        accent: 'text-foreground-subtle',
        flowing: false,
        active: false,
      }
    case 'stopped':
      return { glow: 'bg-warning/10', accent: 'text-warning', flowing: false, active: false }
    case undefined:
      return {
        glow: 'bg-transparent',
        accent: 'text-foreground-subtle',
        flowing: false,
        active: false,
      }
  }
}

/**
 * gateFraction for the STATE-ONLY case (no numeric position): 1 = fully
 * closed (gate seals the bore), 0 = fully open (flow). Exhaustive switch so a
 * new ValveState member fails the build. open/opening read as open; everything
 * else (closed/closing/stopped/undefined) reads as closed.
 */
function gateFractionFromState(state: ValveState | undefined): number {
  switch (state) {
    case 'open':
      return 0
    case 'opening':
      return 0
    case 'closed':
      return 1
    case 'closing':
      return 1
    case 'stopped':
      return 1
    case undefined:
      return 1
  }
}

interface ValveGraphicProps {
  /** Live valve state, drives the tint AND the gate when position is null. */
  readonly state: ValveState | undefined
  /** 0–100 — 0 = fully closed (gate seals the pipe), 100 = fully open. Null for open/close-only valves (gate derives from `state`). */
  readonly position: number | null
  /** When true, the graphic becomes a vertical drag surface that sets position. */
  readonly interactive: boolean
  /** Called with the new (clamped, integer) position as the user drags. */
  readonly onSetPosition?: (pos: number) => void
}

/**
 * ValveGraphic — a framed pipe + gate-valve illustration in the SAME
 * visual language as the cover window / vacuum graphic (w-28 h-36 rounded
 * bordered box, gradient bg, overflow-hidden, inset white shadow).
 *
 * A vertical pipe runs the full height; a circular valve body sits in the
 * middle with a gate disc that descends into the bore as the valve closes
 * (gateFraction = 1 - position/100). A handle on top rotates with the
 * position. Flow dashes animate through the bore when the valve is open.
 * State-tinted via `valveGraphicTint`.
 *
 * When `interactive` is true (positionable valves), the whole box is a
 * vertical drag surface: dragging UP opens the valve (higher position),
 * DOWN closes it. The drag is ADDITIVE to the bottom range slider, which
 * remains for fine control + accessibility. The decorative SVG is
 * `aria-hidden`; the drag surface carries the slider a11y.
 */
function ValveGraphic({
  state,
  position,
  interactive,
  onSetPosition,
}: ValveGraphicProps): ReactNode {
  const t = useUiText()
  const tint = valveGraphicTint(state)
  // gateFraction: 1.0 = fully closed (gate seals bore), 0.0 = fully open.
  // With a numeric position, derive from it; otherwise (open/close-only) drive
  // the gate from STATE so an open valve shows an OPEN gate matching the label.
  const gateFraction = position !== null ? 1 - position / 100 : gateFractionFromState(state)
  // Gate disc Y within the bore (bore spans y≈40..60 around the valve body).
  const gateTop = 41 + gateFraction * 8
  // Handle rotation: closed (gateFraction 1) = horizontal, open (0) = vertical-ish.
  // Follows the same opening fraction as the gate so the handle always matches.
  const handleAngle = -90 * (1 - gateFraction)

  const boxRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const lastEmittedRef = useRef<number | null>(null)

  // Map a pointer Y coordinate to a clamped, integer position.
  // Dragging UP (smaller y) = more open = higher position. Dragging is only
  // ever enabled when `position` is a number (see caller gating), so the
  // null-safe fallback simply reuses the current numeric position or 0.
  const positionFromPointer = (clientY: number): number => {
    const fallback = position ?? 0
    const el = boxRef.current
    if (el === null) return fallback
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) return fallback
    const ratio = (clientY - rect.top) / rect.height
    const next = Math.round(100 - ratio * 100)
    return Math.min(100, Math.max(0, next))
  }

  const emit = (clientY: number): void => {
    if (onSetPosition === undefined) return
    const next = positionFromPointer(clientY)
    if (lastEmittedRef.current === next) return
    lastEmittedRef.current = next
    onSetPosition(next)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive) return
    e.stopPropagation()
    e.preventDefault()
    draggingRef.current = true
    lastEmittedRef.current = null
    e.currentTarget.setPointerCapture(e.pointerId)
    emit(e.clientY)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive || !draggingRef.current) return
    e.stopPropagation()
    emit(e.clientY)
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive || !draggingRef.current) return
    e.stopPropagation()
    draggingRef.current = false
    lastEmittedRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <div
      ref={boxRef}
      data-testid="valve-graphic"
      {...(interactive
        ? {
            'aria-label': t('uiLibrary.valveControl.drag', 'Drag to set position'),
            role: 'slider',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': position ?? 0,
          }
        : { 'aria-hidden': 'true' })}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? endDrag : undefined}
      onPointerCancel={interactive ? endDrag : undefined}
      className={cn(
        'relative w-28 h-36 rounded border-2 border-border bg-gradient-to-b from-surface-hover to-surface overflow-hidden flex-shrink-0',
        interactive && 'cursor-ns-resize touch-none select-none',
      )}
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.06)' }}
    >
      {/* Flow glow wash over the pipe */}
      <div className={cn('absolute inset-0 transition-colors duration-300', tint.glow)} />

      <div
        className={cn('absolute inset-0 flex items-center justify-center', tint.accent)}
        aria-hidden="true"
      >
        <svg viewBox="0 0 100 100" className="w-24 h-28" fill="none">
          {/* Pipe walls (vertical) */}
          <rect
            x="40"
            y="4"
            width="20"
            height="92"
            rx="3"
            fill="currentColor"
            fillOpacity="0.06"
            stroke="currentColor"
            strokeWidth="2.5"
          />

          {/* Flow dashes through the bore (animate when open/opening) */}
          {tint.flowing && (
            <line
              x1="50"
              y1="8"
              x2="50"
              y2="92"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="4 8"
              opacity="0.5"
              className="animate-pulse"
            />
          )}

          {/* Activity pulse ring on the valve body (transient motion) */}
          {tint.active && (
            <circle
              cx="50"
              cy="50"
              r="22"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.4"
              className="animate-ping"
              style={{ transformOrigin: 'center' }}
            />
          )}

          {/* Valve body (circular gate housing) */}
          <circle
            cx="50"
            cy="50"
            r="17"
            fill="currentColor"
            fillOpacity="0.12"
            stroke="currentColor"
            strokeWidth="2.5"
          />

          {/* Gate disc — descends into the bore as the valve closes */}
          <rect
            x="43"
            y={gateTop}
            width="14"
            height="6"
            rx="1.5"
            fill="currentColor"
            fillOpacity="0.55"
            className="transition-all duration-200"
          />

          {/* Stem + rotating handle on top of the body */}
          <line
            x1="50"
            y1="33"
            x2="50"
            y2="22"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <g
            style={{
              transform: `rotate(${handleAngle}deg)`,
              transformOrigin: '50px 20px',
              transition: 'transform 200ms',
            }}
          >
            <rect
              x="34"
              y="17"
              width="32"
              height="6"
              rx="3"
              fill="currentColor"
              fillOpacity="0.7"
            />
          </g>
        </svg>
      </div>
    </div>
  )
}

// ── Hero button ───────────────────────────────────────────────────────────────

interface ValveHeroButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly variant: CoverHighlightVariant
  readonly onClick: () => void
  readonly children: ReactNode
}

function ValveHeroButton({
  label,
  busy,
  variant,
  onClick,
  children,
}: ValveHeroButtonProps): ReactNode {
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
        valveHighlightClass(variant),
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

/**
 * ValveHeroCard — full control surface for the device-detail hero area.
 *
 * Bespoke pipe + gate-valve graphic (drag surface when positionable) +
 * a large position % (or capitalized state when position is null) +
 * Open / Stop / Close hero buttons + a position slider gated on
 * `ValvePositionable` (additive to drag), and a read-only range when a
 * position is reported but not settable.
 *
 * Position support is detected via `ValveStatus.position !== null`; the
 * interactive setPosition surface is gated on `DeviceFeature.ValvePositionable`.
 * Only hides when the device truly has no valve cap.
 */
export function ValveHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useValve(trpc, deviceId)
  const { display, applyOptimistic } = useOptimisticSlice<ValveStatus>(slice, {
    enabled: optimistic ?? true,
  })

  // Only hide entirely when the device has no valve cap at all.
  if (cap === undefined) return null

  const busy = !available
  const positionable = (features ?? []).includes(DeviceFeature.ValvePositionable)
  const hl = coverHighlight(display?.state)
  const meta = valveStateMeta(display?.state, t)

  const position = display?.position ?? null
  const hasPosition = position !== null

  const press = (
    fn?: (input: Record<string, never>) => Promise<void>,
    patch?: Partial<ValveStatus>,
  ): void => {
    if (busy || !fn) return
    if (patch !== undefined) applyOptimistic(patch)
    void fn({})
  }

  const handleSetPosition = (pos: number): void => {
    if (busy) return
    applyOptimistic({ position: pos })
    void cap.setPosition({ position: pos })
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      {/* ── Visual + main buttons ─────────────────────────────────────────── */}
      <div className="flex items-center gap-6">
        <ValveGraphic
          state={display?.state}
          position={position}
          interactive={positionable && hasPosition}
          onSetPosition={positionable && hasPosition ? handleSetPosition : undefined}
        />

        <div className="flex flex-col gap-3 flex-1">
          {/* % open — large readable label (position variant only) */}
          {hasPosition && (
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold tabular-nums text-foreground">
                {position}
              </span>
              <span className="text-base text-foreground-subtle">%</span>
              <span className="text-xs text-foreground-subtle ml-1">
                {t('uiLibrary.valveControl.openSuffix', 'open')}
              </span>
            </div>
          )}

          {/* State label when position is null (open/close-only) */}
          {!hasPosition && (
            <div className="flex items-baseline gap-1">
              <span className={cn('text-3xl font-semibold', meta.tone)}>{meta.label}</span>
            </div>
          )}

          {/* Open / Stop / Close */}
          <div className="flex items-center gap-2">
            <ValveHeroButton
              label={t('uiLibrary.valveControl.open', 'Open')}
              busy={busy}
              variant={hl.up}
              onClick={() => press(cap.open, { state: 'opening' })}
            >
              <ChevronUp className="h-5 w-5" />
            </ValveHeroButton>
            <ValveHeroButton
              label={t('uiLibrary.valveControl.stop', 'Stop')}
              busy={busy}
              variant={hl.stop}
              onClick={() => press(cap.stop, { state: 'stopped' })}
            >
              <Square className="h-4 w-4" />
            </ValveHeroButton>
            <ValveHeroButton
              label={t('uiLibrary.valveControl.close', 'Close')}
              busy={busy}
              variant={hl.down}
              onClick={() => press(cap.close, { state: 'closing' })}
            >
              <ChevronDown className="h-5 w-5" />
            </ValveHeroButton>
          </div>
        </div>
      </div>

      {/* ── Position slider (ValvePositionable) ─────────────────────────── */}
      {/* Gated on `positionable` alone (matches cover): a positionable valve
          shows the editable slider immediately, even before the first
          `current_position` push lands. The drag surface stays gated on a
          known numeric position (dragging needs a position to set). */}
      {positionable && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span className="w-12 shrink-0">{t('uiLibrary.valveControl.position', 'Position')}</span>
          <input
            aria-label={t('uiLibrary.valveControl.position', 'Position')}
            type="range"
            min={0}
            max={100}
            step={1}
            value={position ?? 0}
            disabled={busy}
            className="flex-1"
            onChange={(e) => {
              handleSetPosition(Number(e.target.value))
            }}
          />
          <span className="w-8 text-right tabular-nums">{position ?? '—'}%</span>
        </label>
      )}

      {/* ── Read-only position indicator (reported but not settable) ─────── */}
      {!positionable && hasPosition && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span className="w-12 shrink-0">{t('uiLibrary.valveControl.position', 'Position')}</span>
          <input
            aria-label={t('uiLibrary.valveControl.position', 'Position')}
            type="range"
            min={0}
            max={100}
            step={1}
            value={position}
            disabled
            readOnly
            className="flex-1 opacity-60"
          />
          <span className="w-8 text-right tabular-nums">{position}%</span>
        </label>
      )}
    </div>
  )
}
