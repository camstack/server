/**
 * Swipe actions — a row's secondary actions behind a sideways swipe.
 *
 * On a phone a list row shows its identity, its one main control and its
 * status; everything else the row offers (open, delete, …) sits in a tray past
 * the row's right edge and slides in when the row is swiped left.
 *
 *   const swipe = useSwipeActions()
 *   <tr {...swipe.rowProps}>
 *     <td className={SWIPE_CELL_CLASS}>…</td>
 *     <td className={cn(SWIPE_CELL_CLASS, 'relative')}>
 *       …
 *       <SwipeActionsTray swipe={swipe} label="Row actions" actions={[…]} />
 *     </td>
 *   </tr>
 *
 * The tray decides where swiping exists: give it a breakpoint class
 * (`md:hidden`) and the gesture is off wherever the tray is not displayed, so
 * a wide layout keeps its inline buttons and nothing here runs.
 *
 * Besides its `actions`, the tray takes two slots for controls that already
 * exist as components (a run/stop control, a confirmed reboot): `lead` comes
 * before the actions, `children` after them. A slot whose content renders
 * nothing takes no room.
 *
 * Without a touch screen: the tray's buttons are ordinary buttons in the tab
 * order, and focusing one opens the tray, so the keyboard and a screen reader
 * reach every action without the gesture. Escape closes it.
 *
 * Discoverability: a row that passes `hint` may peek open a few pixels and
 * settle. Every row of a list can pass it: the first one to mount claims the
 * hint, and it plays once per browser — never again after that.
 */
import {
  type ComponentType,
  type CSSProperties,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/cn'

/** A drag shorter than this is a tap, not a swipe. */
const SWIPE_SLOP_PX = 8
/** The fraction of the tray that must be uncovered for a release to open it. */
const SWIPE_OPEN_FRACTION = 0.35

/** How far the hinted row peeks, and for how long, the one time it does. */
const SWIPE_HINT_PEEK_PX = 24
const SWIPE_HINT_DELAY_MS = 600
const SWIPE_HINT_HOLD_MS = 700
/** Set once the hint has played in this browser. */
const SWIPE_HINT_STORAGE_KEY = 'camstack.swipe-actions.hint-seen'

/** Storage can be blocked or absent; then the hint simply does not play. */
function claimSwipeHint(): boolean {
  try {
    if (window.localStorage.getItem(SWIPE_HINT_STORAGE_KEY) !== null) return false
    window.localStorage.setItem(SWIPE_HINT_STORAGE_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** Every cell of a swipeable row carries this, so the row moves as one. */
export const SWIPE_CELL_CLASS =
  '[transform:translateX(var(--swipe-x,0px))] motion-safe:transition-transform motion-safe:duration-150' as const

export interface SwipeAction {
  /** Stable id for React keys and tests. */
  readonly id: string
  /** The action's name: its accessible name and the caption under the icon. */
  readonly label: string
  readonly icon: ComponentType<{ className?: string }>
  readonly onClick: () => void
  /** The destructive accent. */
  readonly danger?: boolean
  readonly disabled?: boolean
}

type SwipeRowStyle = CSSProperties & { readonly '--swipe-x'?: string }

export interface SwipeRowProps {
  readonly style: SwipeRowStyle
  readonly 'data-swipe-open': '' | undefined
  readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void
  readonly onPointerMove: (e: PointerEvent<HTMLElement>) => void
  readonly onPointerUp: (e: PointerEvent<HTMLElement>) => void
  readonly onPointerCancel: (e: PointerEvent<HTMLElement>) => void
  readonly onClickCapture: (e: MouseEvent<HTMLElement>) => void
  readonly onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  readonly onBlur: (e: FocusEvent<HTMLElement>) => void
}

export interface SwipeActionsState {
  /** Spread on the row element. */
  readonly rowProps: SwipeRowProps
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  /** Internal: the tray registers itself here so its width bounds the swipe. */
  readonly trayRef: RefObject<HTMLDivElement | null>
}

interface DragState {
  readonly startX: number
  readonly startY: number
  readonly base: number
  readonly swiping: boolean
}

export interface SwipeActionsOptions {
  /** Turns the gesture off (a busy row). */
  readonly disabled?: boolean
  /** This row may play the one-time peek (the first row to ask gets it). */
  readonly hint?: boolean
}

/** The swipe state of ONE row. */
export function useSwipeActions(options?: SwipeActionsOptions): SwipeActionsState {
  const disabled = options?.disabled ?? false
  const hint = options?.hint ?? false
  const trayRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<DragState | null>(null)
  const swallowClick = useRef(false)
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState<number | null>(null)

  /** 0 when the tray is not displayed (a wide layout): the gesture is then off. */
  const trayWidth = (): number => trayRef.current?.offsetWidth ?? 0

  // An open row closes when the operator touches anything outside it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.PointerEvent): void => {
      const row = trayRef.current?.closest('[data-swipe-open]')
      if (row && e.target instanceof Node && row.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // The one-time peek. It needs a displayed tray (so never on a wide layout)
  // and is claimed in storage before it plays, so two lists on one page, or a
  // remount, cannot play it twice.
  useEffect(() => {
    if (!hint || disabled || trayWidth() === 0) return
    let settle: ReturnType<typeof setTimeout> | null = null
    const peek = setTimeout(() => {
      if (drag.current !== null || !claimSwipeHint()) return
      setOffset(-SWIPE_HINT_PEEK_PX)
      settle = setTimeout(() => setOffset(null), SWIPE_HINT_HOLD_MS)
    }, SWIPE_HINT_DELAY_MS)
    return () => {
      clearTimeout(peek)
      if (settle !== null) clearTimeout(settle)
    }
  }, [hint, disabled])

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>): void => {
      if (disabled || trayWidth() === 0) return
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        base: open ? -trayWidth() : 0,
        swiping: false,
      }
    },
    [disabled, open],
  )

  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>): void => {
    const current = drag.current
    if (current === null) return
    const dx = e.clientX - current.startX
    const dy = e.clientY - current.startY
    if (!current.swiping) {
      if (Math.abs(dx) < SWIPE_SLOP_PX) return
      // A mostly vertical move is the page scrolling: leave it alone.
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        return
      }
      drag.current = { ...current, swiping: true }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    setOffset(Math.min(0, Math.max(-trayWidth(), current.base + dx)))
  }, [])

  const finish = useCallback((): void => {
    const current = drag.current
    drag.current = null
    if (current === null || !current.swiping) return
    swallowClick.current = true
    setOffset((value) => {
      const width = trayWidth()
      setOpen(width > 0 && value !== null && -value > width * SWIPE_OPEN_FRACTION)
      return null
    })
  }, [])

  const rowProps: SwipeRowProps = {
    style: {
      '--swipe-x': offset !== null ? `${offset}px` : open ? `-${trayWidth()}px` : '0px',
      touchAction: 'pan-y',
    },
    'data-swipe-open': open ? '' : undefined,
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: finish,
    // The click that ends a swipe must not also activate the row.
    onClickCapture: (e) => {
      if (!swallowClick.current) return
      swallowClick.current = false
      e.stopPropagation()
      e.preventDefault()
    },
    onKeyDown: (e) => {
      if (e.key === 'Escape' && open) setOpen(false)
    },
    onBlur: (e) => {
      if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
        setOpen(false)
      }
    },
  }
  return { rowProps, open, setOpen, trayRef }
}

export interface SwipeActionsTrayProps {
  readonly swipe: SwipeActionsState
  readonly actions: readonly SwipeAction[]
  /** Accessible name of the group, e.g. "Actions for Kitchen window". */
  readonly label: string
  /** Existing controls shown BEFORE the actions (the row's leading action). */
  readonly lead?: ReactNode
  /** Existing controls shown AFTER the actions. */
  readonly children?: ReactNode
  /** Where the tray exists, e.g. `md:hidden`. */
  readonly className?: string
}

/** A slot of the tray; takes no room while its content renders nothing. */
const SWIPE_SLOT_CLASS =
  'flex items-center gap-1.5 border-l border-border bg-surface-hover px-2 empty:hidden' as const

/**
 * The tray. It sits in the row's LAST cell (which must be `relative` and carry
 * {@link SWIPE_CELL_CLASS}), parked just past the row's right edge; the list's
 * container must clip sideways (`overflow-x-clip`) so the parked tray never
 * widens the page.
 */
export function SwipeActionsTray({
  swipe,
  actions,
  label,
  lead,
  children,
  className,
}: SwipeActionsTrayProps): JSX.Element | null {
  const hasLead = lead !== undefined && lead !== null && lead !== false
  const hasRest = children !== undefined && children !== null && children !== false
  if (actions.length === 0 && !hasLead && !hasRest) return null
  return (
    <div
      ref={swipe.trayRef}
      role="group"
      aria-label={label}
      data-swipe-tray=""
      onFocus={() => swipe.setOpen(true)}
      onClick={(e) => e.stopPropagation()}
      className={cn('absolute inset-y-0 left-full flex items-stretch', className)}
    >
      {hasLead && (
        <div data-swipe-slot="lead" className={SWIPE_SLOT_CLASS}>
          {lead}
        </div>
      )}
      {actions.map((action) => {
        const Icon = action.icon
        return (
          <button
            key={action.id}
            type="button"
            disabled={action.disabled}
            onClick={() => {
              swipe.setOpen(false)
              action.onClick()
            }}
            className={cn(
              'flex w-16 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium leading-tight',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
              'disabled:opacity-50',
              action.danger
                ? 'bg-danger/15 text-danger'
                : 'bg-surface-hover text-foreground border-l border-border',
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="max-w-full truncate">{action.label}</span>
          </button>
        )
      })}
      {hasRest && (
        <div data-swipe-slot="rest" className={SWIPE_SLOT_CLASS}>
          {children}
        </div>
      )}
    </div>
  )
}
