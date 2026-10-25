import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronUp, ChevronDown, Square } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import { type CoverStatus, DeviceFeature } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { coverHighlight, type CoverHighlightVariant } from './cover-inline'

// ── Hero button ──────────────────────────────────────────────────────────────

interface HeroButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly variant: CoverHighlightVariant
  readonly onClick: () => void
  readonly children: ReactNode
}

/**
 * Large button for the hero layout.  Uses the same real design-token classes
 * as CoverCtrlButton (sourced from button.tsx primary variant + stream-panel
 * active patterns):
 *   accent  → bg-primary text-primary-foreground   (transient motion, clearly lit)
 *   filled  → bg-primary/15 text-primary            (stable open/closed, subtler)
 *   neutral → default ghost style
 */
function HeroButton({ label, busy, variant, onClick, children }: HeroButtonProps): ReactNode {
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
        variant === 'accent' && 'bg-primary text-primary-foreground hover:bg-primary/90',
        variant === 'filled' && 'bg-primary/15 text-primary',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

// ── Window graphic ────────────────────────────────────────────────────────────

/**
 * Mullion cross lines for the window frame — shared between both variants.
 */
function WindowMullions(): ReactNode {
  return (
    <>
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-px -translate-x-px bg-white/60"
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 h-px -translate-y-px bg-white/60"
      />
    </>
  )
}

// ── Window with lever (position-% variant) ────────────────────────────────────

interface WindowWithLeverProps {
  /** 0–100: 0 = fully closed (slats fill frame), 100 = fully open (frame empty). */
  readonly position: number
  /** When true, the window becomes a vertical drag surface that sets position. */
  readonly interactive: boolean
  /** Called with the new (clamped, integer) position as the user drags. */
  readonly onSetPosition?: (pos: number) => void
}

/**
 * Window graphic with slats and a lever at the open/closed boundary.
 * Slats descend from the top to cover (100 - position)% of the frame.
 * The lever sits at the boundary and shows the current % value.
 *
 * The window uses a sky-blue gradient background (clear pane) with a slat
 * panel overlaid from the top.
 *
 * When `interactive` is true (positionable covers), the whole window is a
 * vertical drag surface: dragging the slat boundary / lever DOWN closes the
 * cover (lower position), UP opens it. The drag is ADDITIVE to the bottom
 * range slider, which remains for fine control + accessibility. When not
 * interactive the graphic is display-only with no pointer handlers and no
 * resize affordance — identical to the original behaviour.
 */
function WindowWithLever({
  position,
  interactive,
  onSetPosition,
}: WindowWithLeverProps): ReactNode {
  const t = useUiText()
  // slatFraction: 1.0 = fully closed (slats fill frame), 0.0 = fully open
  const slatFraction = 1 - position / 100
  const slatPct = slatFraction * 100

  const windowRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const lastEmittedRef = useRef<number | null>(null)

  // Map a pointer Y coordinate to a clamped, integer position.
  // boundaryY from top = (100 - position)% * height → position = 100 - (y/h)*100.
  // Dragging DOWN = more closed = lower position.
  const positionFromPointer = (clientY: number): number => {
    const el = windowRef.current
    if (el === null) return position
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) return position
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
      ref={windowRef}
      data-testid="cover-window"
      {...(interactive
        ? {
            'aria-label': t('uiLibrary.coverHeroCard.dragToSet', 'Drag to set position'),
            role: 'slider',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': position,
          }
        : { 'aria-hidden': 'true' })}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? endDrag : undefined}
      onPointerCancel={interactive ? endDrag : undefined}
      className={cn(
        'relative w-28 h-36 rounded border-2 border-amber-700/60 bg-gradient-to-b from-sky-200 to-sky-50 overflow-hidden flex-shrink-0',
        interactive && 'cursor-ns-resize touch-none select-none',
      )}
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.5)' }}
    >
      <WindowMullions />

      {/* Slat panel — descends from the top as cover closes */}
      <div
        className="absolute inset-x-0 top-0 transition-all duration-200"
        style={{
          height: `${slatPct}%`,
          background: 'repeating-linear-gradient(#c9cdd2, #c9cdd2 6px, #b7bcc2 6px, #b7bcc2 8px)',
          borderBottom: slatPct > 0 ? '1px solid #9aa' : 'none',
        }}
      />

      {/* Lever at the open/closed boundary — grabbable when interactive */}
      <div
        data-testid="cover-lever"
        className={cn(
          'absolute inset-x-0 h-4 flex items-center justify-center gap-1 z-10 transition-all duration-200',
          interactive && 'cursor-grab active:cursor-grabbing',
        )}
        style={{ top: `calc(${slatPct}% - 8px)` }}
      >
        <div className="absolute -inset-x-1.5 h-full rounded-lg bg-slate-600 shadow-md" />
        <span className="h-1 w-1 rounded-full bg-white/70 relative z-10" aria-hidden="true" />
        <span className="h-1 w-1 rounded-full bg-white/70 relative z-10" aria-hidden="true" />
        <span className="h-1 w-1 rounded-full bg-white/70 relative z-10" aria-hidden="true" />

        {/* % label to the right of the lever */}
        <span
          data-testid="cover-position-pct"
          className="absolute left-full ml-2 text-xs font-semibold text-foreground tabular-nums whitespace-nowrap"
        >
          {position}%
        </span>
      </div>
    </div>
  )
}

// ── Window state-only (open/close-only variant) ───────────────────────────────

interface WindowStateOnlyProps {
  /** Whether the cover is in an "open" state (open/opening) or closed (closed/closing/stopped). */
  readonly isOpen: boolean
}

/**
 * Window graphic for open/close-only covers — no lever, no %.
 * Shows a clear pane when open, full slats when closed, based on state.
 */
function WindowStateOnly({ isOpen }: WindowStateOnlyProps): ReactNode {
  return (
    <div
      data-testid="cover-window"
      aria-hidden="true"
      className="relative w-28 h-36 rounded border-2 border-amber-700/60 bg-gradient-to-b from-sky-200 to-sky-50 overflow-hidden flex-shrink-0"
      style={{ boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.5)' }}
    >
      <WindowMullions />

      {/* Full slats when closed; clear pane when open */}
      {!isOpen && (
        <div
          className="absolute inset-0"
          style={{
            background: 'repeating-linear-gradient(#c9cdd2, #c9cdd2 6px, #b7bcc2 6px, #b7bcc2 8px)',
          }}
        />
      )}
    </div>
  )
}

// ── CoverHeroCard ────────────────────────────────────────────────────────────

/**
 * CoverHeroCard — full control surface for the device-detail hero area.
 *
 * TWO VARIANTS based on whether the cover reports a position:
 *
 * With position (position !== null):
 *  - Window graphic with slats descending from top to (100-position)%
 *  - Visual (display-only) lever at the slat boundary with % label
 *  - Open / Stop / Close buttons with state-aware highlight
 *  - Interactive position range input (gated on CoverPositionable)
 *  - Tilt range input (gated on CoverTilt)
 *
 * Without position (open/close-only, position === null):
 *  - Window graphic showing state via clear pane (open) or full slats (closed)
 *  - NO lever, NO % label; the value slot shows the cover STATE text (no %)
 *  - Open / Stop / Close buttons with state-aware highlight
 *
 * Position support is detected via `CoverStatus.position !== null`.
 * The interactive setPosition slider is gated on `DeviceFeature.CoverPositionable`.
 *
 * Follows the same `useDeviceCapability` pattern as CoverPanel / CoverInlineControl.
 * Only hides when the device truly has no cover cap — a transient undefined slice
 * renders a neutral "unknown" state with all buttons still mounted.
 */
export function CoverHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<
    {
      open: (i: Record<string, never>) => Promise<void>
      close: (i: Record<string, never>) => Promise<void>
      stop: (i: Record<string, never>) => Promise<void>
      setPosition: (i: { position: number }) => Promise<void>
      setTiltPosition: (i: { tiltPosition: number }) => Promise<void>
    },
    CoverStatus
  >({
    trpc,
    deviceId,
    cap: (d) =>
      d.cover as
        | {
            open: (i: Record<string, never>) => Promise<void>
            close: (i: Record<string, never>) => Promise<void>
            stop: (i: Record<string, never>) => Promise<void>
            setPosition: (i: { position: number }) => Promise<void>
            setTiltPosition: (i: { tiltPosition: number }) => Promise<void>
          }
        | undefined,
    slice: (d) => d.state.cover,
  })

  const { display, applyOptimistic } = useOptimisticSlice<CoverStatus>(slice, {
    enabled: optimistic ?? true,
  })

  // Only hide entirely when the device has no cover cap at all.
  if (cap === undefined) return null

  const busy = !available
  const positionable = (features ?? []).includes(DeviceFeature.CoverPositionable)
  const tiltable = (features ?? []).includes(DeviceFeature.CoverTilt)

  // Treat undefined display as "unknown" — neutral highlight, buttons still mounted.
  const hl = coverHighlight(display?.state)

  // position !== null means this cover reports a position (CoverStatus.position field).
  // This is the REAL position-support detection from the cap schema.
  const position = display?.position ?? null
  const hasPosition = position !== null

  // Determine open/closed from state for the state-only variant
  const isOpenState = display?.state === 'open' || display?.state === 'opening'

  const press = (
    fn?: (input: Record<string, never>) => Promise<void>,
    patch?: Partial<CoverStatus>,
  ): void => {
    if (busy || !fn) return
    if (patch !== undefined) applyOptimistic(patch)
    void fn({})
  }

  const handleSetPosition = (pos: number): void => {
    if (busy) return
    applyOptimistic({ position: pos })
    void cap?.setPosition({ position: pos })
  }

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-4">
      {/* ── Visual + main buttons ─────────────────────────────────────────── */}
      <div className="flex items-center gap-6">
        {/* Window graphic — lever variant or state-only variant */}
        {hasPosition ? (
          <WindowWithLever
            position={position}
            interactive={positionable}
            onSetPosition={positionable ? handleSetPosition : undefined}
          />
        ) : (
          <WindowStateOnly isOpen={isOpenState} />
        )}

        <div className="flex flex-col gap-3 flex-1">
          {/* % open — large readable label (position-% variant only) */}
          {hasPosition && (
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold tabular-nums text-foreground">
                {position}
              </span>
              <span className="text-base text-foreground-subtle">%</span>
              <span className="text-xs text-foreground-subtle ml-1">
                {t('uiLibrary.coverHeroCard.openWord', 'open')}
              </span>
            </div>
          )}

          {/* State label when position is null (open/close-only) — NO % unit */}
          {!hasPosition && (
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-semibold capitalize text-foreground">
                {display?.state ?? '—'}
              </span>
            </div>
          )}

          {/* Open / Stop / Close */}
          <div className="flex items-center gap-2">
            <HeroButton
              label={t('uiLibrary.coverHeroCard.open', 'Open')}
              busy={busy}
              variant={hl.up}
              onClick={() => press(cap?.open, { state: 'opening' })}
            >
              <ChevronUp className="h-5 w-5" />
            </HeroButton>
            <HeroButton
              label={t('uiLibrary.coverHeroCard.stop', 'Stop')}
              busy={busy}
              variant={hl.stop}
              onClick={() => press(cap?.stop, { state: 'stopped' })}
            >
              <Square className="h-4 w-4" />
            </HeroButton>
            <HeroButton
              label={t('uiLibrary.coverHeroCard.close', 'Close')}
              busy={busy}
              variant={hl.down}
              onClick={() => press(cap?.close, { state: 'closing' })}
            >
              <ChevronDown className="h-5 w-5" />
            </HeroButton>
          </div>
        </div>
      </div>

      {/* ── Position slider (CoverPositionable) ─────────────────────────── */}
      {positionable && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span className="w-12 shrink-0">{t('uiLibrary.coverHeroCard.position', 'Position')}</span>
          <input
            aria-label={t('uiLibrary.coverHeroCard.position', 'Position')}
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

      {/* ── Read-only position indicator (no CoverPositionable) ─────────── */}
      {!positionable && position !== null && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span className="w-12 shrink-0">{t('uiLibrary.coverHeroCard.position', 'Position')}</span>
          <input
            aria-label={t('uiLibrary.coverHeroCard.position', 'Position')}
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

      {/* ── Tilt slider (CoverTilt) ──────────────────────────────────────── */}
      {tiltable && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span className="w-12 shrink-0">{t('uiLibrary.coverHeroCard.tilt', 'Tilt')}</span>
          <input
            aria-label={t('uiLibrary.coverHeroCard.tiltPosition', 'Tilt position')}
            type="range"
            min={0}
            max={100}
            step={1}
            value={display?.tiltPosition ?? 0}
            disabled={busy}
            className="flex-1"
            onChange={(e) => {
              const tp = Number(e.target.value)
              applyOptimistic({ tiltPosition: tp })
              if (!busy) void cap?.setTiltPosition({ tiltPosition: tp })
            }}
          />
          <span className="w-8 text-right tabular-nums">{display?.tiltPosition ?? '—'}%</span>
        </label>
      )}
    </div>
  )
}
