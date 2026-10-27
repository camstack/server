import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { useConfirm } from '../confirm-dialog'
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
  const confirm = useConfirm()

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

  const handleDelete = async (): Promise<void> => {
    const accepted = await confirm({
      title: t('uiLibrary.batchToolbar.deleteTitle', 'Delete {{count}} devices?', { count }),
      message: t(
        'uiLibrary.batchToolbar.deleteMessage',
        '{{count}} selected devices will be deleted. This cannot be undone.',
        { count },
      ),
      confirmLabel: t('uiLibrary.batchToolbar.delete', 'Delete'),
      variant: 'danger',
    })
    if (!accepted) return
    for (const id of ids) remove({ deviceId: id })
    onClear()
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface-hover">
      <span className="text-xs font-medium text-foreground-subtle shrink-0">
        {t('uiLibrary.batchToolbar.selectedCount', '{{count}} selected', {
          count,
        })}
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

        <button
          type="button"
          onClick={() => void handleDelete()}
          className={cn(
            'inline-flex items-center h-6 px-2.5 rounded-md border text-[10.5px] font-medium transition-colors',
            'border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
          )}
        >
          {t('uiLibrary.batchToolbar.delete', 'Delete')}
        </button>

        <button
          type="button"
          onClick={onClear}
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
