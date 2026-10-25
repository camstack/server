/**
 * StepDetailDock — where a step's settings open from the step matrix
 * (D757): docked to the page's scroll container, never inside the scrolling
 * content.
 *
 * Desktop: a side panel `position: fixed` over the RIGHT edge of the nearest
 * scroll container (its top, bottom and right are measured from that box), so
 * it stays where it is while the matrix scrolls under it, and its header and
 * save bar are always on screen. It overlays — it never reserves width, so the
 * matrix does not reflow (the slide-over before D756 reserved 360 px, the
 * matrix re-measured into a single-node layout, and the clicked cell slid
 * under the panel). The matrix uses {@link STEP_DOCK_WIDTH_PX} to scroll the
 * selected column clear of it.
 *
 * Phone: a full-screen `Dialog` sheet.
 */
import { type ReactNode, type RefObject, useLayoutEffect, useState, type JSX } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useUiText } from '../../contexts/ui-text'
import { Dialog, DialogContent } from '../../primitives/dialog'
import { useIsMobile } from '../../hooks/use-is-mobile'

/** Width of the desktop dock — what the matrix keeps clear of it. */
export const STEP_DOCK_WIDTH_PX = 432

/** The dock's viewport box, from its scroll container's box. */
export function dockBox(input: {
  readonly scroller: { readonly top: number; readonly bottom: number; readonly right: number }
  readonly viewportWidth: number
  readonly widthPx: number
}): {
  readonly top: number
  readonly height: number
  readonly right: number
  readonly width: number
} {
  const right = Math.max(0, input.viewportWidth - input.scroller.right)
  const width = Math.min(input.widthPx, input.scroller.right)
  return {
    top: Math.max(0, input.scroller.top),
    height: Math.max(0, input.scroller.bottom - Math.max(0, input.scroller.top)),
    right,
    width,
  }
}

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p !== null; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

function useDockBox(anchor: RefObject<HTMLElement | null>, enabled: boolean) {
  const [box, setBox] = useState<ReturnType<typeof dockBox> | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const scroller = scrollParentOf(anchor.current)
    const measure = (): void => {
      const r = scroller?.getBoundingClientRect() ?? {
        top: 0,
        bottom: window.innerHeight,
        right: window.innerWidth,
      }
      setBox(
        dockBox({ scroller: r, viewportWidth: window.innerWidth, widthPx: STEP_DOCK_WIDTH_PX }),
      )
    }
    measure()
    const RO = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (scroller) RO?.observe(scroller)
    window.addEventListener('resize', measure)
    return () => {
      RO?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [anchor, enabled])
  return box
}

export interface StepDetailDockProps {
  readonly open: boolean
  /** An element inside the page's scroll container (the matrix) — the dock measures from it. */
  readonly anchor: RefObject<HTMLElement | null>
  /** The phone sheet was dismissed (Escape, back). */
  readonly onClose: () => void
  /** Accessible name of the dock region. */
  readonly label: string
  readonly children: ReactNode
}

export function StepDetailDock({
  open,
  anchor,
  onClose,
  label,
  children,
}: StepDetailDockProps): JSX.Element | null {
  const isMobile = useIsMobile()
  const box = useDockBox(anchor, open && !isMobile)
  if (isMobile) {
    return (
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent
          placement="sheet-on-mobile"
          scroll="body"
          aria-label={label}
          className="h-[100dvh] max-h-none w-full max-w-full rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        >
          {open && children}
        </DialogContent>
      </Dialog>
    )
  }
  if (!open) return null
  return (
    <aside
      aria-label={label}
      data-step-dock
      className="fixed z-30 flex flex-col border-l border-border bg-surface shadow-2xl"
      style={
        box !== null
          ? { top: box.top, height: box.height, right: box.right, width: box.width }
          : { top: 0, bottom: 0, right: 0, width: STEP_DOCK_WIDTH_PX }
      }
    >
      {children}
    </aside>
  )
}

/** "‹ Steps" — the phone sheet's way back to the matrix. */
export function BackToStepsButton({
  onClick,
}: {
  readonly onClick: () => void
}): JSX.Element | null {
  const t = useUiText()
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-0.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-surface-hover"
    >
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      {t('uiLibrary.stepDetailDock.steps', 'Steps')}
    </button>
  )
}
