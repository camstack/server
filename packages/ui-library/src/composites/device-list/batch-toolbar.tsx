import { useUiText } from '../../contexts/ui-text'
import { useState, type ReactNode } from 'react'
import { cn } from '../../lib/cn.js'

export interface DeviceBatchToolbarProps {
  readonly selectedIds: ReadonlySet<number>
  readonly onClear: () => void
  readonly remove: (input: { deviceId: number }) => void
  readonly disable: (input: { deviceId: number }) => void
  readonly enable: (input: { deviceId: number }) => void
}

export function DeviceBatchToolbar({
  selectedIds,
  onClear,
  remove,
  disable,
  enable,
}: DeviceBatchToolbarProps): ReactNode {
  const t = useUiText()
  const [pendingDelete, setPendingDelete] = useState(false)

  if (selectedIds.size === 0) return null

  const ids = [...selectedIds]
  const count = ids.length

  const handleDisable = (): void => {
    for (const id of ids) disable({ deviceId: id })
    onClear()
  }

  const handleEnable = (): void => {
    for (const id of ids) enable({ deviceId: id })
    onClear()
  }

  const handleDeleteFirst = (): void => {
    setPendingDelete(true)
  }

  const handleDeleteConfirm = (): void => {
    for (const id of ids) remove({ deviceId: id })
    setPendingDelete(false)
    onClear()
  }

  const handleDeleteCancel = (): void => {
    setPendingDelete(false)
  }

  const handleClear = (): void => {
    setPendingDelete(false)
    onClear()
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface-hover">
      <span className="text-xs font-medium text-foreground-subtle shrink-0">
        {t('uiLibrary.batchToolbar.selectedCount', '{{count}} selected', { count })}
      </span>

      <div className="h-3.5 w-px bg-border shrink-0" aria-hidden="true" />

      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={handleDisable}
          className={cn(
            'inline-flex items-center h-6 px-2.5 rounded-md border text-[10.5px] font-medium transition-colors',
            'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface',
          )}
        >
          {t('uiLibrary.batchToolbar.disable', 'Disable')}
        </button>

        <button
          type="button"
          onClick={handleEnable}
          className={cn(
            'inline-flex items-center h-6 px-2.5 rounded-md border text-[10.5px] font-medium transition-colors',
            'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface',
          )}
        >
          {t('uiLibrary.batchToolbar.enable', 'Enable')}
        </button>

        {pendingDelete ? (
          <>
            <button
              type="button"
              onClick={handleDeleteConfirm}
              className={cn(
                'inline-flex items-center h-6 px-2.5 rounded-md border text-[10.5px] font-medium transition-colors',
                'border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20',
              )}
            >
              {t('uiLibrary.batchToolbar.confirmDelete', 'Confirm delete {{count}}?', { count })}
            </button>
            <button
              type="button"
              onClick={handleDeleteCancel}
              className={cn(
                'inline-flex items-center h-6 px-2.5 rounded-md border text-[10.5px] font-medium transition-colors',
                'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface',
              )}
            >
              {t('uiLibrary.batchToolbar.cancel', 'Cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleDeleteFirst}
            className={cn(
              'inline-flex items-center h-6 px-2.5 rounded-md border text-[10.5px] font-medium transition-colors',
              'border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20',
            )}
          >
            {t('uiLibrary.batchToolbar.delete', 'Delete')}
          </button>
        )}

        <button
          type="button"
          onClick={handleClear}
          className={cn(
            'inline-flex items-center h-6 px-2.5 rounded-md border text-[10.5px] font-medium transition-colors',
            'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface',
          )}
        >
          {t('uiLibrary.batchToolbar.clear', 'Clear')}
        </button>
      </div>
    </div>
  )
}
