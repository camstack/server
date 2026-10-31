/**
 * TOTP management modal — operator-facing view for a single user's 2FA.
 *
 * Scope (after the My-Profile split):
 *   • Operators NEVER set up 2FA on behalf of another user. The setup
 *     flow lives on `/system/my-access` and runs against the caller's
 *     own session.
 *   • Operators CAN remove a stale enrollment (lost device, leaving
 *     employee) via the disable action below. Removal is the only
 *     write action this modal exposes.
 *
 * States:
 *   • "loading"       — initial query in flight
 *   • "not_enrolled"  — show a read-only hint; no Setup button
 *   • "enrolled"      — show "Remove 2FA" destructive action
 */
import { Smartphone, Loader2, CheckCircle, X, Info } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useUserManagementGetTotpStatus,
  useUserManagementDisableTotp,
  useConfirm,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

interface TotpModalProps {
  readonly userId: string
  readonly username: string
  readonly onClose: () => void
}

export function TotpModal({ userId, username, onClose }: TotpModalProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const statusQuery = useUserManagementGetTotpStatus({ userId })
  const status = statusQuery.data

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [['userManagement', 'getTotpStatus']] })

  const disableMutation = useUserManagementDisableTotp({
    onSuccess: () => {
      invalidate()
      onClose()
    },
  })

  const phase: 'loading' | 'not_enrolled' | 'enrolled' = statusQuery.isLoading
    ? 'loading'
    : status?.enabled
      ? 'enrolled'
      : 'not_enrolled'

  const handleDisable = async () => {
    const ok = await confirm({
      title: t('users.totpModal.remove2fa', 'Remove 2FA'),
      message: t(
        'users.totpModal.removeTwoFactorAuthenticationFor',
        'Remove two-factor authentication for "{{username}}"? They\'ll be able to log in with just their password until they re-enroll from their own profile page.',
        { username },
      ),
      confirmLabel: t('common.remove', 'Remove'),
      variant: 'danger',
    })
    if (!ok) return
    disableMutation.mutate({ userId })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <span>
              {t('users.totpModal.twoFactorAuthentication', 'Two-factor authentication')}
              <span className="mt-0.5 block text-[11px] font-normal text-foreground-subtle">
                {t('users.totpModal.user', 'User:')} <span className="font-mono">{username}</span>
              </span>
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {phase === 'loading' && (
            <div className="flex items-center gap-2 text-xs text-foreground-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('users.totpModal.checkingStatus', 'Checking status…')}
            </div>
          )}

          {phase === 'not_enrolled' && (
            <div className="rounded-md border border-border bg-surface-hover/30 px-3 py-2.5 flex items-start gap-2.5 text-xs text-foreground-subtle">
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium text-foreground">
                  {t('users.totpModal.2faNotEnrolled', '2FA not enrolled')}
                </div>
                <p className="mt-0.5">
                  {t(
                    'users.totpModal.onlyTheUserThemselvesCan',
                    'Only the user themselves can enable 2FA, from their own profile page.',
                  )}
                </p>
              </div>
            </div>
          )}

          {phase === 'enrolled' && status && (
            <>
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 flex items-start gap-2.5">
                <CheckCircle className="h-4 w-4 mt-0.5 text-emerald-500 shrink-0" />
                <div className="text-xs text-foreground space-y-0.5">
                  <div className="font-medium">
                    {t('users.totpModal.2faIsActive', '2FA is active')}
                  </div>
                  <div className="text-foreground-subtle">
                    {t('common.enrolledOn', {
                      when: status.confirmedAt
                        ? new Date(status.confirmedAt).toLocaleString()
                        : '—',
                    })}
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-foreground-subtle">
                {t(
                  'users.totpModal.removingHereClearsTheServer',
                  "Removing here clears the server-side secret. Use this only when the user has lost access — they'll have to re-enroll from their profile page afterwards.",
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button onClick={onClose} variant="secondary">
                  {t('common.close', 'Close')}
                </Button>
                <Button
                  variant="unstyled"
                  onClick={handleDisable}
                  disabled={disableMutation.isPending}
                  className="rounded bg-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-danger/90 disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {disableMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                  {t('users.totpModal.remove2fa', 'Remove 2FA')}
                </Button>
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
