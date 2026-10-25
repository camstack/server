/**
 * A revealed keychain value, in a dialog — never in the table row.
 *
 * Revealing inline put a multi-line PEM or a 400-character token into a table
 * cell and the whole table re-flowed around it (operator report, 2026-10-08).
 * Here the value is monospace, wraps, scrolls inside the dialog body, can be
 * copied, and is dropped from memory after `SECRET_REVEAL_MS` — the same window
 * the settings forms' eye uses. The hub has already audited the reveal; the
 * dialog says so.
 */
import type { KeychainAdminSecret } from '@camstack/types'
import {
  Button,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SECRET_REVEAL_MS,
} from '@camstack/ui-library'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface RevealedSecret {
  readonly entry: KeychainAdminSecret
  readonly value: string
}

export interface RevealDialogProps {
  readonly revealed: RevealedSecret | null
  readonly onClose: () => void
}

const TICK_MS = 1000

export function RevealDialog({ revealed, onClose }: RevealDialogProps) {
  const { t } = useTranslation()
  const [remaining, setRemaining] = useState(SECRET_REVEAL_MS)

  useEffect(() => {
    if (revealed === null) return
    const shownAt = Date.now()
    setRemaining(SECRET_REVEAL_MS)
    const hide = setTimeout(onClose, SECRET_REVEAL_MS)
    const tick = setInterval(
      () => setRemaining(Math.max(0, SECRET_REVEAL_MS - (Date.now() - shownAt))),
      TICK_MS,
    )
    return () => {
      clearTimeout(hide)
      clearInterval(tick)
    }
  }, [revealed, onClose])

  const seconds = Math.ceil(remaining / 1000)
  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        {revealed !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="break-all">{revealed.entry.fieldPath}</DialogTitle>
              <DialogDescription className="break-all">
                {revealed.entry.owner} · {revealed.entry.scope}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <pre
                data-testid="revealed-value"
                className="whitespace-pre-wrap break-all rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground"
              >
                {revealed.value}
              </pre>
            </DialogBody>
            <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[11px] text-foreground-subtle">
                {t('secrets.revealDialog.recorded', { seconds })}
              </p>
              <div className="flex justify-end gap-2">
                <CopyButton
                  value={revealed.value}
                  label={t('common.copy', 'Copy')}
                  srLabel="revealed value"
                />
                <Button size="sm" variant="outline" onClick={onClose}>
                  {t('secrets.revealDialog.hide', 'Hide')}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
