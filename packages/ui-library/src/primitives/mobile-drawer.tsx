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
}: MobileDrawerProps): JSX.Element {
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

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
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
          'fixed inset-y-0 left-0 z-50 flex flex-col bg-surface border-r border-border shadow-2xl transition-transform duration-200 ease-out pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
          width,
          open ? 'translate-x-0' : '-translate-x-full',
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}
