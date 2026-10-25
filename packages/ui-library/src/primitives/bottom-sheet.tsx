import { type ReactNode, useEffect, type JSX } from 'react'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  className?: string
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  className,
}: BottomSheetProps): JSX.Element {
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
          'fixed inset-0 z-40 bg-black/50 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          // `bottom-0` is the VIEWPORT bottom, which under `viewport-fit=cover`
          // sits behind the iOS home indicator. The sheet must stay flush with
          // that edge (its background fills the gap), so the inset is absorbed
          // as padding — without it the sheet's last row is under the
          // indicator and effectively untappable. Collapses to 0 elsewhere.
          'fixed inset-x-0 bottom-0 z-50 flex flex-col bg-background-elevated border-t border-border rounded-t-xl shadow-2xl transition-transform duration-200 ease-out pb-[env(safe-area-inset-bottom)]',
          'max-h-[80dvh]',
          open ? 'translate-y-0' : 'translate-y-full',
          className,
        )}
      >
        {/* Handle bar */}
        <div className="flex justify-center pt-2 pb-1">
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
