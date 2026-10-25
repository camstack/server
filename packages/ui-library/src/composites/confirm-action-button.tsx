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
 */
import { type ReactNode, useState, type ComponentType, type JSX } from 'react'
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
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setError(null)
    setRunning(true)
    try {
      const result = await action()
      onSuccess?.(result)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={size}
        disabled={disabled}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
        className={className}
      >
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </Button>

      <Dialog open={open} onOpenChange={(next) => !running && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
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
              onClick={() => setOpen(false)}
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
              {confirmLabel ?? label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
