import {
  type JSX,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/cn'
import { useIsMobile } from '../hooks/use-is-mobile'
import { BottomSheet } from './bottom-sheet'
import { TopLayerPortal } from './top-layer-portal'

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerId: string
  contentId: string
  triggerRef: RefObject<HTMLButtonElement | null>
}

const PopoverContext = createContext<PopoverContextValue | null>(null)

function usePopoverContext() {
  const ctx = useContext(PopoverContext)
  if (!ctx) throw new Error('Popover compound components must be used within <Popover>')
  return ctx
}

/* ── Root ── */

interface PopoverProps {
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Popover({
  children,
  open: controlledOpen,
  onOpenChange,
}: PopoverProps): JSX.Element | null {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const triggerId = useId()
  const contentId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const setOpen = useCallback(
    (next: boolean) => {
      onOpenChange?.(next)
      if (controlledOpen === undefined) setUncontrolledOpen(next)
    },
    [controlledOpen, onOpenChange],
  )

  return (
    <PopoverContext.Provider value={{ open, setOpen, triggerId, contentId, triggerRef }}>
      <div className="relative inline-block">{children}</div>
    </PopoverContext.Provider>
  )
}

/* ── Trigger ── */

export function PopoverTrigger({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element | null {
  const { open, setOpen, triggerId, contentId, triggerRef } = usePopoverContext()
  return (
    <button
      type="button"
      ref={triggerRef}
      id={triggerId}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      onClick={() => setOpen(!open)}
      {...props}
    >
      {children}
    </button>
  )
}

/* ── Content ── */

interface PopoverContentCoords {
  top: number
  left: number
  minWidth: number
  /** The trigger's edges, for collision handling. */
  triggerTop: number
  triggerBottom: number
}

/** Breathing room kept between a popover and the viewport edge. */
const VIEWPORT_MARGIN_PX = 8

export interface PopoverPlacement {
  readonly side: 'below' | 'above'
  /** Cap on the content height; the content scrolls inside it. */
  readonly maxHeight: number
}

/**
 * Where a popover goes so it stays inside the viewport: below the trigger
 * unless it does not fit there and there is more room above, and never taller
 * than the room on the chosen side.
 */
export function placePopover(input: {
  readonly triggerTop: number
  readonly triggerBottom: number
  readonly contentHeight: number
  readonly viewportHeight: number
  readonly offset: number
}): PopoverPlacement {
  const below = input.viewportHeight - input.triggerBottom - input.offset - VIEWPORT_MARGIN_PX
  const above = input.triggerTop - input.offset - VIEWPORT_MARGIN_PX
  const side = input.contentHeight > below && above > below ? 'above' : 'below'
  return { side, maxHeight: Math.max(0, side === 'above' ? above : below) }
}

interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Horizontal alignment relative to the trigger. Default: 'start' (left-aligned). */
  align?: 'start' | 'end'
  /** Pixel offset between trigger and content. Default: 4. */
  offset?: number
}

export function PopoverContent({
  className,
  children,
  align = 'start',
  offset = 4,
  ...props
}: PopoverContentProps): JSX.Element | null {
  const { open, setOpen, contentId, triggerId, triggerRef } = usePopoverContext()
  const isMobile = useIsMobile()
  const ref = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<PopoverContentCoords | null>(null)
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)

  useLayoutEffect(() => {
    if (!open || isMobile) {
      setCoords(null)
      return
    }
    const compute = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const left = align === 'end' ? rect.right : rect.left
      setCoords({
        top: rect.bottom + offset,
        left,
        minWidth: rect.width,
        triggerTop: rect.top,
        triggerBottom: rect.bottom,
      })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open, isMobile, align, offset, triggerRef])

  // Collision handling: measured after the content is in the DOM, before paint.
  useLayoutEffect(() => {
    const el = ref.current
    if (!coords || !el) {
      setPlacement(null)
      return
    }
    setPlacement(
      placePopover({
        triggerTop: coords.triggerTop,
        triggerBottom: coords.triggerBottom,
        contentHeight: el.scrollHeight,
        viewportHeight: window.innerHeight,
        offset,
      }),
    )
  }, [coords, offset])

  useEffect(() => {
    if (!open || isMobile) return
    const handler = (e: MouseEvent) => {
      const el = ref.current
      const trigger = triggerRef.current
      if (el && !el.contains(e.target as Node) && !trigger?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const escHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Closes the popover only: without this a dialog around it would close too.
      e.preventDefault()
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', escHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', escHandler)
    }
  }, [open, setOpen, triggerRef, isMobile])

  if (!open) return null

  if (isMobile) {
    return (
      <TopLayerPortal
        anchor={triggerRef}
        surfaceRef={sheetRef}
        className="pointer-events-none fixed inset-0 h-dvh w-dvw max-w-none overflow-visible border-0 bg-transparent p-0 [&>*]:pointer-events-auto"
      >
        <BottomSheet open={open} onClose={() => setOpen(false)}>
          {children}
        </BottomSheet>
      </TopLayerPortal>
    )
  }

  if (!coords || typeof document === 'undefined') return null

  const above = placement?.side === 'above'
  const style: CSSProperties = {
    position: 'fixed',
    ...(above ? { bottom: window.innerHeight - coords.triggerTop + offset } : { top: coords.top }),
    ...(placement ? { maxHeight: placement.maxHeight } : {}),
    ...(align === 'end' ? { right: window.innerWidth - coords.left } : { left: coords.left }),
    minWidth: coords.minWidth,
  }

  return (
    <TopLayerPortal
      anchor={triggerRef}
      surfaceRef={ref}
      id={contentId}
      role="dialog"
      aria-labelledby={triggerId}
      // ui-check-ok: fixed portal anchor from trigger getBoundingClientRect (same as DropdownContent)
      style={style}
      className={cn(
        'z-50 overflow-y-auto bg-background-elevated border border-border rounded-lg shadow-lg p-3',
        className,
      )}
      {...props}
    >
      {children}
    </TopLayerPortal>
  )
}
