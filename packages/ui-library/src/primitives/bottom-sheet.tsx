import { type CSSProperties, type PointerEvent, type ReactNode, useEffect, useRef, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  className?: string
}

/** Downward travel of the handle, in px, past which releasing it dismisses the sheet. */
export const DISMISS_DRAG_PX = 80

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  className,
}: BottomSheetProps): JSX.Element | null {
  const [dragY, setDragY] = useState(0)
  const dragStart = useRef<number | null>(null)

  const onHandleDown = (e: PointerEvent<HTMLDivElement>): void => {
    dragStart.current = e.clientY
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onHandleMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragStart.current === null) return
    setDragY(Math.max(0, e.clientY - dragStart.current))
  }
  const onHandleUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragStart.current === null) return
    const travelled = e.clientY - dragStart.current
    dragStart.current = null
    setDragY(0)
    if (travelled >= DISMISS_DRAG_PX) onClose()
  }

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  // Mounted only while open: a closed, transparent full-screen backdrop and an
  // off-screen sheet remain composited fixed layers above the page chrome and
  // dim/blur the non-scrolling top bar on iOS WebKit (installed PWA).
  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 animate-in fade-in duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        // ui-check-ok: the sheet follows the dragged handle; a transform is geometry, not a token
        style={dragY > 0 ? ({ transform: `translateY(${dragY}px)` } satisfies CSSProperties) : undefined}
        className={cn(
          // `bottom-0` is the VIEWPORT bottom, which under `viewport-fit=cover`
          // sits behind the iOS home indicator. The sheet must stay flush with
          // that edge (its background fills the gap), so the inset is absorbed
          // as padding — without it the sheet's last row is under the
          // indicator and effectively untappable. Collapses to 0 elsewhere.
          'fixed inset-x-0 bottom-0 z-50 flex flex-col bg-background-elevated border-t border-border rounded-t-xl shadow-2xl animate-in slide-in-from-bottom duration-200 ease-out pb-[env(safe-area-inset-bottom)]',
          'max-h-[80dvh]',
          className,
        )}
      >
        {/* Handle bar */}
        <div
          data-testid="bottom-sheet-handle"
          className="flex touch-none cursor-grab justify-center pt-2 pb-3"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={() => {
            dragStart.current = null
            setDragY(0)
          }}
        >
          <div className="h-1 w-8 rounded-full bg-foreground-subtle/30" />
        </div>

        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-4 pb-2">
            <span className="text-sm font-medium text-foreground">{title}</span>
            <button
              onClick={onClose}
              className="p-1 rounded-md hover:bg-surface-hover text-foreground-muted transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">{children}</div>
      </div>
    </>
  )
}
