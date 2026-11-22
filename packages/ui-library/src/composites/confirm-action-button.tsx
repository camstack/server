/**
 * ConfirmActionButton — destructive-action button with a modal confirm.
 *
 * Two-step UX for any operation operators shouldn't trigger by accident:
 * reboot device, restart addon, regenerate token, etc. The trigger is a
 * normal Button that opens a Dialog; confirming runs the async action,
 * the trigger spinner-disables itself for the duration, and the dialog
 * closes on success. Errors surface inline at the dialog's bottom.
 *
 * Generic on `TResult` so callers don't have to discard the return
 * value. Pass an `icon` to render it inside the trigger (e.g. RotateCw
 * for reboot, RefreshCw for restart).
 *
 * `ConfirmActionDialog` is the dialog half on its own, for a trigger that is
 * not a button of its own — a menu row (`PageActions` on a phone).
 */
import { type ReactNode, useEffect, useState, type ComponentType, type JSX } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../primitives/dialog'
import { Button, type ButtonProps } from '../primitives/button'
import { useUiText } from '../contexts/ui-text'
import { cn } from '../lib/cn'

export interface ConfirmActionButtonProps<TResult> {
  /** Visible label on the trigger button. */
  readonly label: string
  /** Icon component (lucide-react) rendered inside the trigger. */
  readonly icon?: ComponentType<{ className?: string }>
  /** Dialog title. Defaults to "Confirm action". */
  readonly title?: string
  /**
   * Dialog body — accepts either a string (rendered as DialogDescription)
   * or arbitrary ReactNode for callers that need lists, code blocks, etc.
   */
  readonly description?: ReactNode
  /** Label on the confirm button inside the dialog. Defaults to `label`. */
  readonly confirmLabel?: string
  /** Visual variant for the trigger button (defaults to `outline`). */
  readonly triggerVariant?: ButtonProps['variant']
  /**
   * Visual variant for the confirm button inside the dialog. Defaults to
   * `danger` since this component is meant for destructive actions.
   */
  readonly confirmVariant?: ButtonProps['variant']
  /** Trigger button size — propagated to the underlying Button. */
  readonly size?: ButtonProps['size']
  /** Disable the trigger entirely (gates rendering instead of UX state). */
  readonly disabled?: boolean
  /** Optional extra class name on the trigger. */
  readonly className?: string
  /**
   * The async action to run on confirm. Must throw on failure so this
   * component can surface the error inline. The result is returned to
   * `onSuccess` for callers that need it (e.g. to invalidate queries).
   */
  readonly action: () => Promise<TResult>
  /** Called after `action` resolves, with the result. */
  readonly onSuccess?: (result: TResult) => void
}

export interface ConfirmActionDialogProps<TResult> {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Dialog title. Defaults to "Confirm action". */
  readonly title?: string
  readonly description?: ReactNode
  /** Label on the confirm button. */
  readonly confirmLabel: string
  /** Defaults to `danger`. */
  readonly confirmVariant?: ButtonProps['variant']
  readonly size?: ButtonProps['size']
  /** Must throw on failure; the message is shown in the dialog. */
  readonly action: () => Promise<TResult>
  readonly onSuccess?: (result: TResult) => void
}

/** The confirm step of a destructive action, opened by the caller. */
export function ConfirmActionDialog<TResult>({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant = 'danger',
  size = 'sm',
  action,
  onSuccess,
}: ConfirmActionDialogProps<TResult>): JSX.Element {
  const t = useUiText()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The dialog stays mounted (so it can animate out); a reopened one starts
  // with no stale error from the previous attempt.
  useEffect(() => {
    if (open) setError(null)
  }, [open])

  const handleConfirm = async () => {
    setError(null)
    setRunning(true)
    try {
      const result = await action()
      onSuccess?.(result)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {title ?? t('uiLibrary.confirmActionButton.defaultTitle', 'Confirm action')}
          </DialogTitle>
          {typeof description === 'string' ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            description
          )}
        </DialogHeader>

        {error && (
          <div
            className={cn(
              'mt-2 px-3 py-2 rounded border border-danger/40 bg-danger/10',
              'text-xs text-danger',
            )}
          >
            {error}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size={size}
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            {t('uiLibrary.confirmActionButton.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            size={size}
            disabled={running}
            onClick={() => {
              void handleConfirm()
            }}
          >
            {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmActionButton<TResult>({
  label,
  icon: Icon,
  title,
  description,
  confirmLabel,
  triggerVariant = 'outline',
  confirmVariant = 'danger',
  size = 'sm',
  disabled,
  className,
  action,
  onSuccess,
}: ConfirmActionButtonProps<TResult>): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={size}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={className}
      >
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </Button>
      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        confirmLabel={confirmLabel ?? label}
        confirmVariant={confirmVariant}
        size={size}
        action={action}
        onSuccess={onSuccess}
      />
    </>
  )
}
