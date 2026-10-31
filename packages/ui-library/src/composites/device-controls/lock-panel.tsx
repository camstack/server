import { useUiText } from '../../contexts/ui-text'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { Lock, LockOpen, DoorOpen, Loader2 } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { Button } from '../../primitives/button'
import type { LockControlStatus } from '@camstack/types'
import { DeviceFeature } from '@camstack/types'
import type { ControlPanelProps } from './types'

type LockControlCap = {
  lock: (i: Record<string, never>) => Promise<void>
  unlock: (i: Record<string, never>) => Promise<void>
  open: (i: Record<string, never>) => Promise<void>
}

/**
 * Which security-sensitive action the compact (table inline) confirm modal is
 * gating. `null` means no modal is open. `lock` (secure) is never gated and so
 * never appears here.
 */
type PendingAction = 'unlock' | 'open' | null

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function LockPanel({
  trpc,
  deviceId,
  layout,
  optimistic,
  features,
}: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<LockControlCap, LockControlStatus>({
    trpc,
    deviceId,
    cap: (d) => d.lockControl as LockControlCap | undefined,
    slice: (d) => d.state.lockControl,
  })
  const { display, applyOptimistic } = useOptimisticSlice<LockControlStatus>(slice, {
    enabled: optimistic ?? true,
  })
  const [pending, setPending] = useState<PendingAction>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (display === undefined) return null
  const locked = display.state === 'locked' || display.state === 'locking'
  const busy = !available || display.state === 'jammed'
  // The hub refuses lock() while the door is open; the toggle then offers Lock, so it is disabled.
  const doorBlocksLock = display.state === 'door-open'
  const toggleDisabled = busy || doorBlocksLock
  const supportsOpen = features?.includes(DeviceFeature.LockOpen) === true
  // The compact (row/table) inline control requires explicit confirmation for
  // security-sensitive actions; the full (detail) layout fires immediately.
  const requiresConfirm = layout === 'compact'

  const doLock = (): void => {
    applyOptimistic({ state: 'locking' })
    void cap?.lock({})
  }

  const doUnlock = (): void => {
    applyOptimistic({ state: 'unlocking' })
    void cap?.unlock({})
  }

  const doOpen = (): void => {
    void cap?.open({})
  }

  const toggle = (): void => {
    if (toggleDisabled) return
    if (!locked) {
      // Lock (secure) is always immediate.
      doLock()
      return
    }
    // Unlock is security-sensitive: gate it behind a confirm modal in the
    // compact inline control; fire immediately in the full layout.
    if (requiresConfirm) {
      setError(null)
      setPending('unlock')
      return
    }
    doUnlock()
  }

  const handleOpen = (): void => {
    if (busy) return
    if (requiresConfirm) {
      setError(null)
      setPending('open')
      return
    }
    doOpen()
  }

  const closeModal = (): void => {
    if (running) return
    setPending(null)
  }

  const confirm = async (): Promise<void> => {
    if (running || pending === null) return
    setError(null)
    setRunning(true)
    try {
      if (pending === 'unlock') {
        applyOptimistic({ state: 'unlocking' })
        await cap?.unlock({})
      } else {
        await cap?.open({})
      }
      setPending(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  const label = locked
    ? t('uiLibrary.lockPanel.unlock', 'Unlock')
    : t('uiLibrary.lockPanel.lock', 'Lock')
  const confirmTitle =
    pending === 'open'
      ? t('uiLibrary.lockPanel.openDoorTitle', 'Open door?')
      : t('uiLibrary.lockPanel.unlockTitle', 'Unlock device?')
  const confirmDescription =
    pending === 'open'
      ? t('uiLibrary.lockPanel.openDoorBody', 'This will release the latch and open the door.')
      : t('uiLibrary.lockPanel.unlockBody', 'This will unlock the device.')
  const confirmLabel =
    pending === 'open'
      ? t('uiLibrary.lockPanel.confirmOpen', 'Confirm open')
      : t('uiLibrary.lockPanel.confirmUnlock', 'Confirm unlock')
  const confirmIcon =
    pending === 'open' ? (
      <DoorOpen className="h-4 w-4 text-amber-400" />
    ) : (
      <LockOpen className="h-4 w-4 text-amber-400" />
    )

  return (
    <div className={cn('inline-flex items-center', layout === 'full' ? 'gap-2' : 'gap-1')}>
      <button
        type="button"
        aria-label={label}
        title={
          display.state === 'jammed'
            ? t('uiLibrary.lockPanel.jammed', 'Jammed')
            : doorBlocksLock
              ? t('uiLibrary.lockPanel.closeDoorFirst', 'Close the door first')
              : label
        }
        disabled={toggleDisabled}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
        className={cn(
          'inline-flex items-center justify-center rounded transition-colors',
          layout === 'full' ? 'h-7 gap-1.5 px-2 text-xs' : 'h-5 w-5',
          locked ? 'text-success' : 'text-warning',
          toggleDisabled && 'opacity-40 cursor-not-allowed',
          'hover:bg-surface-hover',
        )}
      >
        {locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        {layout === 'full' && <span>{display.state}</span>}
      </button>
      {supportsOpen && (
        <button
          type="button"
          aria-label={t('uiLibrary.lockPanel.openDoor', 'Open door')}
          title={t('uiLibrary.lockPanel.openDoor', 'Open door')}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            handleOpen()
          }}
          className={cn(
            'inline-flex items-center justify-center rounded transition-colors',
            layout === 'full' ? 'h-7 gap-1.5 px-2 text-xs' : 'h-5 w-5',
            'text-foreground-muted',
            busy && 'opacity-40 cursor-not-allowed',
            'hover:bg-surface-hover',
          )}
        >
          <DoorOpen className="h-3.5 w-3.5" />
          {layout === 'full' && <span>{t('uiLibrary.lockPanel.open', 'Open')}</span>}
        </button>
      )}

      {requiresConfirm && (
        <Dialog
          open={pending !== null}
          onOpenChange={(next) => {
            if (!next) closeModal()
          }}
        >
          <DialogContent width="sm" onClick={(e: MouseEvent) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {confirmIcon}
                {confirmTitle}
              </DialogTitle>
              <DialogDescription>{confirmDescription}</DialogDescription>
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
                onClick={() => closeModal()}
              >
                {t('uiLibrary.lockPanel.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                aria-label={confirmLabel}
                disabled={running}
                onClick={() => {
                  void confirm()
                }}
              >
                {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
