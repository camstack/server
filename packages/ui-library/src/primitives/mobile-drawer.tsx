import { type ReactNode, useEffect, useRef, type JSX } from 'react'
import { cn } from '../lib/cn'

export interface MobileDrawerProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  /** Width of the drawer panel. Default: 'w-64' */
  width?: string
}

export function MobileDrawer({
  open,
  onClose,
  children,
  className,
  width = 'w-64',
}: MobileDrawerProps): JSX.Element | null {
  const drawerRef = useRef<HTMLDivElement>(null)

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

  // Nothing of the drawer stays mounted while closed. A closed `opacity-0`
  // backdrop and an off-screen `translate-x-full` panel are both still fixed,
  // composited layers above the page chrome: on iOS WebKit (installed PWA)
  // they dimmed and blurred the non-scrolling mobile top bar and left the
  // panel's rounded edge drawn on the left of the page.
  if (!open) return null

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 animate-in fade-in duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel — `fixed inset-y-0` pins it to the viewport edges
          (ignoring any parent padding), so the safe-area inset must be
          applied here directly. Without it, the drawer header / first
          row sits under the iOS notch / Android status bar on an
          installed PWA. Bottom inset keeps the last item clear of the
          iOS home indicator. */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col bg-surface border-r border-border shadow-2xl animate-in slide-in-from-left duration-200 ease-out pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
          width,
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}
