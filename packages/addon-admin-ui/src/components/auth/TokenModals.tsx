/**
 * The one-shot reveal of a freshly minted secret (scoped tokens, admin
 * tokens) on Identity → Tokens & sessions. The raw token is returned ONLY at
 * create time; once the reveal is closed it is unrecoverable (GitHub PAT UX).
 *
 * Built on the library `Dialog` (top layer, Escape, focus) — never a page-local
 * overlay.
 */
import {
  Button,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export function RevealTokenModal({
  token,
  label,
  onClose,
}: {
  readonly token: string
  readonly label: string
  readonly onClose: () => void
}): ReactNode {
  const { t } = useTranslation()
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('auth.tokenModals.token', 'Token: {{label}}', { label })}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {t(
              'auth.tokenModals.copyThisTokenNowOnce',
              'Copy this token now. Once you close this dialog the secret cannot be displayed again.',
            )}
          </div>
          <div className="select-all break-all rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground">
            {token}
          </div>
        </DialogBody>
        <DialogFooter>
          <CopyButton value={token} label={t('common.copy', 'Copy')} srLabel="token" />
          <Button type="button" variant="primary" size="sm" onClick={onClose}>
            {t('auth.tokenModals.done', 'Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
