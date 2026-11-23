/**
 * useDestructiveAction — a destructive action OUTSIDE a table (a page's
 * Delete, an editor's Delete, an integration's Remove).
 *
 * Inside a `DataTable` the table owns the loader (`table.destructive`). Here
 * the confirm dialog owns it: it stays open with a spinner until the action
 * settles, shows a failure in the dialog, and closes only on success.
 *
 *   const del = useDestructiveAction({ title, description, confirmLabel, action, onSuccess })
 *   <Button onClick={del.request}>Delete</Button>
 *   {del.dialog}
 *
 * For a call site that already has `useConfirm()`, `confirm({ …, action })`
 * is the same behaviour without a rendered element.
 */
import { type JSX, type ReactNode, useCallback, useMemo, useState } from 'react'
import { ConfirmActionDialog } from '../composites/confirm-action-button'

export interface UseDestructiveActionOptions<TResult> {
  readonly title: string
  readonly description?: ReactNode
  readonly confirmLabel: string
  /** Resolves only when the work is done; a throw is shown in the dialog. */
  readonly action: () => Promise<TResult>
  readonly onSuccess?: (result: TResult) => void
}

export interface DestructiveAction {
  /** Open the confirm dialog. */
  readonly request: () => void
  /** Render once, anywhere in the page. */
  readonly dialog: JSX.Element
}

export function useDestructiveAction<TResult>(
  options: UseDestructiveActionOptions<TResult>,
): DestructiveAction {
  const { title, description, confirmLabel, action, onSuccess } = options
  const [open, setOpen] = useState(false)
  const request = useCallback(() => setOpen(true), [])
  const dialog = (
    <ConfirmActionDialog
      open={open}
      onOpenChange={setOpen}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      action={action}
      onSuccess={onSuccess}
    />
  )
  return useMemo(() => ({ request, dialog }), [request, dialog])
}
