/**
 * useDeviceCommand — run a device command from a control and report a refusal.
 *
 * A control renders the slice the hub serves and nothing else. The hub holds
 * what a command was told to do until the device confirms it (D1061), so the
 * new value reaches the slice as soon as the command is seen — no client-side
 * patch, no client timers, and every client (admin, viewer, a second browser)
 * shows the same thing.
 *
 * What stays here is the operator's feedback: a command the server refuses is
 * reported through the shared alert dialog (one at a time), or to the caller's
 * `onError` when it handles the refusal itself.
 */
import { useCallback, useRef } from 'react'
import { useAlertIfAvailable } from '../composites/confirm-dialog'
import { useUiText } from '../contexts/ui-text'

/** Run `run`; a throw or rejection goes to `onError`, by default the refusal alert. */
export type RunDeviceCommand = (
  run: () => PromiseLike<unknown> | undefined,
  onError?: (error: unknown) => void,
) => void

export function useDeviceCommand(): RunDeviceCommand {
  const t = useUiText()
  const alert = useAlertIfAvailable()
  const alertOpenRef = useRef(false)

  const reportRefusal = useCallback(
    (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error)
      if (alert === undefined || alertOpenRef.current) return
      alertOpenRef.current = true
      void alert({
        title: t('uiLibrary.deviceCommand.refusedTitle', 'The device refused the change'),
        message,
        variant: 'danger',
      }).finally(() => {
        alertOpenRef.current = false
      })
    },
    [alert, t],
  )

  return useCallback(
    (run, onError = reportRefusal) => {
      // A synchronous throw is a refusal like any other.
      new Promise<unknown>((resolve) => resolve(run())).catch((err: unknown) => onError(err))
    },
    [reportRefusal],
  )
}
