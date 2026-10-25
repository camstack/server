import { useTranslation } from 'react-i18next'
/**
 * Shared list chrome for Notification Center sections (Rules, Summaries,
 * Timelapses — and any sibling that wants the same table look).
 *
 * One loading / empty / table / row-controls / delete contract so the tabs do
 * not drift: the operator scans by COLUMN, the page never scrolls sideways,
 * a row opens the editor, and delete asks through the shared confirm dialog.
 */

import type { DataColumn } from '@camstack/ui-library'
import { Badge, Card, DataTable, TABLE_SCROLL_MAX_H, useConfirm } from '@camstack/ui-library'
import { Loader2, Trash2 } from 'lucide-react'
import { type MouseEvent, type ReactNode } from 'react'

/** A cell's controls, fenced off from the row: the row opens the editor, and a
 *  switch or a button inside it must do its own thing and nothing else. */
export function NcListRowControls({ children, className }: NcListRowControlsProps) {
  return (
    <span className={className} onClick={(e: MouseEvent) => e.stopPropagation()}>
      {children}
    </span>
  )
}

interface NcListRowControlsProps {
  readonly children: ReactNode
  readonly className?: string
}

/** Centered spinner — the loading body of every NC list section. */
export function NcListLoading() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  )
}

/** Empty list copy — hub answered, zero rows. */
export function NcListEmpty({ children, testId }: NcListEmptyProps) {
  return (
    <div
      className="text-xs text-foreground-subtle text-center py-16"
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
    >
      {children}
    </div>
  )
}

interface NcListEmptyProps {
  readonly children: ReactNode
  readonly testId?: string
}

interface NcListTableProps<TRow> {
  readonly columns: readonly DataColumn<TRow>[]
  readonly rows: readonly TRow[]
  readonly rowKey: (row: TRow) => string
  readonly minWidthPx: number
  /** Absent when the row is not an edit target (read-only lists). */
  readonly onRowClick?: (row: TRow) => void
}

/**
 * Card + DataTable with the NC list defaults: real table at every width, body
 * scrolls inside the card, header pinned, page never scrolls sideways.
 */
export function NcListTable<TRow>({
  columns,
  rows,
  rowKey,
  minWidthPx,
  onRowClick,
}: NcListTableProps<TRow>) {
  return (
    <Card>
      <DataTable<TRow>
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        minWidthPx={minWidthPx}
        bordered={false}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        {...(onRowClick !== undefined ? { onRowClick } : {})}
      />
    </Card>
  )
}

interface NcListNameCellProps {
  readonly name: string
  readonly enabled: boolean
  /** When set, the name is a real button (keyboard path to open the row). */
  readonly onOpen?: () => void
  readonly badges?: ReactNode
  readonly openTestId?: string
}

/** Name + optional disabled badge + extra badges — the first column of every
 *  NC list. The name is a button when the row is editable so the keyboard can
 *  open it too (row click is mouse-only). */
export function NcListNameCell({ name, enabled, onOpen, badges, openTestId }: NcListNameCellProps) {
  const { t } = useTranslation()
  return (
    <span className="flex flex-wrap items-center gap-2">
      {onOpen !== undefined ? (
        <NcListRowControls>
          <button
            type="button"
            onClick={onOpen}
            className="truncate rounded text-left text-sm font-medium text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            {...(openTestId !== undefined ? { 'data-testid': openTestId } : {})}
          >
            {name}
          </button>
        </NcListRowControls>
      ) : (
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
      )}
      {!enabled && <Badge variant="warning">{t('common.disabled')}</Badge>}
      {badges}
    </span>
  )
}

interface NcListDeleteButtonProps {
  readonly disabled?: boolean
  readonly pending?: boolean
  readonly title: string
  readonly message: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly ariaLabel: string
  readonly testId?: string
  readonly onConfirm: () => void
}

/**
 * Trash → shared centered confirm (`useConfirm`). Same control Rules and the
 * device table use — never an in-row Confirm / Cancel pair.
 */
export function NcListDeleteButton({
  disabled = false,
  pending = false,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  ariaLabel,
  testId,
  onConfirm,
}: NcListDeleteButtonProps) {
  const confirm = useConfirm()

  const requestDelete = async (): Promise<void> => {
    const confirmed = await confirm({
      title,
      message,
      confirmLabel,
      cancelLabel,
      variant: 'danger',
    })
    if (confirmed) onConfirm()
  }

  return (
    <button
      type="button"
      title={confirmLabel}
      aria-label={ariaLabel}
      disabled={disabled || pending}
      className="inline-flex h-7 items-center rounded-md px-2 hover:bg-surface-hover disabled:opacity-50"
      onClick={() => void requestDelete()}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
    >
      <Trash2 className="h-3.5 w-3.5 text-danger" />
    </button>
  )
}
