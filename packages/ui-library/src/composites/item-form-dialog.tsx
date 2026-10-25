/**
 * ItemFormDialog — shared shell for create/edit of a named list item.
 *
 * Fixed chrome: title (dismiss via Dialog Close / Escape), optional error /
 * beforeBody, a padded scrolling `DialogBody` (`space-y-3`), optional footer.
 * Callers fill slots with fields only — never add outer padding or a second
 * wrapper around the body children. Open state is owned by the caller
 * (typically `useItemFormUrl`).
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode, JSX } from 'react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  type DialogContentProps,
} from '../primitives'

export interface ItemFormDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly icon?: LucideIcon
  readonly error?: string | null
  readonly width?: DialogContentProps['width']
  readonly children: ReactNode
  /**
   * Pinned chrome between the title/error and the scrolling body — a tab
   * strip, a status banner, anything that must not scroll with the fields.
   * Under `scroll="body"` only `<DialogBody>` scrolls; this slot stays put
   * with the header (same contract as a hand-rolled Dialog chrome).
   */
  readonly beforeBody?: ReactNode
  /** Footer actions (Save, …). Dismiss is the Dialog Close control, not a second Cancel. */
  readonly footer?: ReactNode
  readonly testId?: string
}

export function ItemFormDialog({
  open,
  onClose,
  title,
  icon: Icon,
  error,
  width = 'lg',
  children,
  beforeBody,
  footer,
  testId,
}: ItemFormDialogProps): JSX.Element | null {
  if (!open) return null
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width={width} placement="sheet-on-mobile" scroll="body" data-testid={testId}>
        {/* `pr-10` clears the absolute Dialog Close (X) — same as DialogHeader. */}
        <div className="mb-3 flex shrink-0 items-center gap-2 pr-10">
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
            {Icon !== undefined && (
              <Icon className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden />
            )}
            <span className="truncate">{title}</span>
          </h3>
        </div>
        {error != null && error !== '' && (
          <div className="mb-3 shrink-0 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}
        {beforeBody != null && <div className="mb-3 shrink-0">{beforeBody}</div>}
        {/* Body owns spacing + inset; fillers must not wrap in padding/chrome. */}
        {/* px keeps focus rings inside the dialog padding (flush-left Inputs). */}
        <DialogBody className="space-y-3 px-1">{children}</DialogBody>
        {footer != null && <DialogFooter className="mt-3 shrink-0">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
