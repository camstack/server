/**
 * <PopoverRowAction> — generic icon-button → portal popover.
 *
 * Distilled from `PtzQuickAction` (device-item/actions.tsx): a 5x5
 * icon-button trigger that opens a fixed-position panel mounted on
 * `document.body` (so it escapes the table's `overflow` clip), anchored
 * under the trigger and clamped inside the viewport. Closes on a second
 * trigger click or an outside `mousedown`.
 *
 * Available for use by any composite that needs an icon-button → panel
 * popover pattern (e.g. PTZ quick-action, more-actions menu).
 */
import { useRef, useState, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

interface PopoverRowActionProps {
  readonly icon: LucideIcon
  readonly title: string
  readonly children: ReactNode
}

const PANEL_WIDTH = 240
const GAP = 6

export function PopoverRowAction({
  icon: Icon,
  title,
  children,
}: PopoverRowActionProps): ReactNode {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const isOpen = pos !== null
  const close = (): void => setPos(null)

  const openPanel = (): void => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const width = Math.min(PANEL_WIDTH, window.innerWidth - margin * 2)
    const left = Math.max(margin, Math.min(r.right - width, window.innerWidth - width - margin))
    setPos({ top: r.bottom + GAP, left, width })
  }

  useEffect(() => {
    if (!isOpen) return
    const onPointer = (e: globalThis.MouseEvent | globalThis.TouchEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      close()
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // Match the sibling popovers (PtzQuickAction / MoreActionsMenu): close on
    // outside pointer (mouse + touch) and on Escape for keyboard users.
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={(e) => {
          e.stopPropagation()
          if (isOpen) close()
          else openPanel()
        }}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0',
          isOpen && 'bg-surface-hover text-foreground',
        )}
      >
        <Icon className="h-3 w-3" />
      </button>
      {pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
            className="z-[9999] rounded-lg border border-border bg-surface shadow-lg shadow-black/30 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}
