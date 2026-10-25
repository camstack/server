/**
 * <DeviceBatchActionsBar> — responsive wrapper around <DeviceBatchToolbar>.
 *
 * Surfaces the available bulk actions once devices are selected:
 *   - L2+ (`sm` and up): the toolbar renders inline as a row of buttons.
 *   - L1 (`< sm`): a compact "Actions · N" trigger opens a popover that
 *     hosts the SAME <DeviceBatchToolbar>, so the action logic (inline
 *     delete-confirm, clear) is reused verbatim — never forked.
 *
 * Renders nothing while the selection is empty (delegated to the toolbar).
 */
import { useUiText } from '../../contexts/ui-text'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { DeviceBatchToolbar } from './batch-toolbar'

export interface DeviceBatchActionsBarProps {
  readonly selectedIds: ReadonlySet<number>
  readonly onClear: () => void
  readonly remove: (input: { deviceId: number }) => void
  readonly disable: (input: { deviceId: number }) => void
  readonly enable: (input: { deviceId: number }) => void
}

export function DeviceBatchActionsBar(props: DeviceBatchActionsBarProps): ReactNode {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const count = props.selectedIds.size

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent | TouchEvent): void => {
      const target = e.target instanceof Node ? e.target : null
      if (target && rootRef.current && !rootRef.current.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('touchstart', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('touchstart', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (count === 0) return null

  return (
    <>
      {/* L2+ — full toolbar row. Hidden below sm. */}
      <div className="hidden sm:block">
        <DeviceBatchToolbar {...props} />
      </div>

      {/* L1 — compact menu. Hidden at sm+. */}
      <div ref={rootRef} data-testid="batch-actions-compact" className="relative sm:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-primary/40 bg-primary/15 text-[10.5px] font-medium text-primary"
        >
          <span>
            {t('uiLibrary.deviceBatchActionsBar.actions', 'Actions · {{count}}', { count })}
          </span>
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div
            role="menu"
            className="absolute left-0 top-full mt-1 z-30 rounded-lg border border-border bg-surface shadow-md"
          >
            <DeviceBatchToolbar {...props} />
          </div>
        )}
      </div>
    </>
  )
}
