/**
 * <RebootQuickAction> — a dedicated row-level reboot affordance.
 *
 * Replaces the old kebab-nested "Reboot device" item: reboot now has its
 * own icon button in the row, alongside the PTZ quick-action. Because
 * reboot is destructive and low-frequency, the button is NOT a one-click
 * action — clicking it opens a confirm modal (the shared `Dialog`
 * primitive, same surface `ConfirmActionButton` uses). The cap is only
 * invoked once the operator confirms.
 *
 * Cap-gating mirrors the former MoreActionsMenu exactly: render only when
 * the device proxy has resolved AND the `reboot` cap is bound. The caller
 * pre-gates on the `rebootable` feature; this atom self-gates on the live
 * cap binding, so a device that claims the feature without a bound
 * provider still renders nothing.
 *
 * The reboot call shows a busy/disabled state while in flight, closes the
 * modal on success, and surfaces errors inline at the dialog's bottom.
 * `stopPropagation` on the trigger keeps the row's navigate-to-detail
 * handler from firing.
 */
import { useState, type MouseEvent, type ReactNode } from 'react'
import { Loader2, RotateCw } from 'lucide-react'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { Button } from '../../primitives/button'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'

export interface RebootQuickActionProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  /** Device display name — woven into the confirm-modal body. */
  readonly deviceName: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function RebootQuickAction({
  trpc,
  deviceId,
  deviceName,
}: RebootQuickActionProps): ReactNode {
  const t = useUiText()
  const { dev, cap } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.reboot,
    slice: () => undefined,
  })
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Hide the button if the proxy resolved but no reboot cap is bound —
  // nothing to act on. While the proxy is still resolving (dev === null)
  // we also render nothing so the row stays compact until binding lands.
  if (dev === null || cap === undefined || cap === null) return null

  const handleOpen = (e: MouseEvent): void => {
    e.stopPropagation()
    setError(null)
    setOpen(true)
  }

  const handleConfirm = async (): Promise<void> => {
    if (running) return
    setError(null)
    setRunning(true)
    try {
      await cap.reboot({})
      setOpen(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0',
          open && 'bg-surface-hover text-foreground',
        )}
        title={t('uiLibrary.rebootQuickAction.rebootDevice', 'Reboot device')}
        aria-label={t('uiLibrary.rebootQuickAction.rebootDevice', 'Reboot device')}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <RotateCw className="h-3 w-3" />
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!running) setOpen(next)
        }}
      >
        <DialogContent width="sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCw className="h-4 w-4 text-amber-400" />
              {t('uiLibrary.rebootQuickAction.rebootDeviceQuestion', 'Reboot device?')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'uiLibrary.rebootQuickAction.description',
                'This will restart {{deviceName}}. It may be unavailable for a moment.',
                { deviceName },
              )}
            </DialogDescription>
          </DialogHeader>

          {error !== null && (
            <div className="mt-2 px-3 py-2 rounded border border-danger/40 bg-danger/10 text-xs text-danger">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={running}
              onClick={() => {
                if (!running) setOpen(false)
              }}
            >
              {t('uiLibrary.rebootQuickAction.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={running}
              onClick={() => {
                void handleConfirm()
              }}
            >
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('uiLibrary.rebootQuickAction.reboot', 'Reboot')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
