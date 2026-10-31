import {
  type HTMLAttributes,
  type JSX,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'

export interface TopLayerPortalProps extends HTMLAttributes<HTMLDivElement> {
  /** The trigger the surface belongs to; its enclosing `<dialog>`, if any, hosts the surface. */
  readonly anchor: RefObject<Element | null>
  /** The surface element, for the caller's outside-click and collision logic. */
  readonly surfaceRef?: RefObject<HTMLDivElement | null>
  readonly children?: ReactNode
}

/**
 * Where a floating surface (popover, dropdown, listbox) is mounted so it shows
 * above everything. A modal `<dialog>` sits in the browser's top layer, which
 * paints over anything in `document.body` and makes it inert — so a surface
 * portalled to the body opens "under" the dialog and cannot be clicked. The
 * surface is therefore mounted INSIDE the trigger's dialog (still interactive)
 * and itself promoted to the top layer with the native popover API, which also
 * frees it from the dialog's transform and overflow clipping: its `fixed`
 * coordinates stay viewport coordinates. Outside a dialog it goes to the body
 * as before. Where the popover API is missing it degrades to a plain `fixed`
 * element.
 */
export function TopLayerPortal({
  anchor,
  surfaceRef,
  className,
  children,
  ...props
}: TopLayerPortalProps): JSX.Element | null {
  const host = anchor.current?.closest('dialog') ?? document.body
  useLayoutEffect(() => {
    const el = surfaceRef?.current
    if (!el) return
    if (typeof el.showPopover !== 'function') return
    el.setAttribute('popover', 'manual')
    try {
      if (!el.matches(':popover-open')) el.showPopover()
    } catch {
      // Not connected yet or already shown: the element still renders as a fixed box.
    }
  }, [surfaceRef])
  return createPortal(
    <div ref={surfaceRef} className={cn('inset-auto m-0 text-foreground', className)} {...props}>
      {children}
    </div>,
    host,
  )
}
