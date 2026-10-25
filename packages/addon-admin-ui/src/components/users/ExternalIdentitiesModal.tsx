/**
 * A user's linked sign-in accounts, as an admin sees them (D782).
 *
 * Admins can SEE and REMOVE links — never create one: a link is made only by
 * its owner, from their profile, inside their own session. A link whose
 * provider instance is no longer offered (renamed, removed, disabled) is
 * marked as such; removing it is harmless.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  trpc,
  useConfirm,
  useUserManagementListExternalIdentities,
  useUserManagementUnlinkExternalIdentity,
} from '@camstack/ui-library'
import { Link2, Loader2, Unlink } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ExternalIdentitiesModalProps {
  readonly userId: string
  readonly username: string
  readonly onClose: () => void
}

export function ExternalIdentitiesModal({
  userId,
  username,
  onClose,
}: ExternalIdentitiesModalProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const linksQuery = useUserManagementListExternalIdentities({ userId })
  // The login page's methods are the live provider instances.
  const methodsQuery = trpc.auth.listLoginMethods.useQuery()
  const unlink = useUserManagementUnlinkExternalIdentity({
    onSuccess: () => void utils.userManagement.listExternalIdentities.invalidate(),
  })

  const labels = new Map(
    (methodsQuery.data ?? []).flatMap((m) =>
      m.kind === 'redirect' ? [[m.id, m.label] as const] : [],
    ),
  )
  const links = linksQuery.data ?? []

  const handleUnlink = async (link: { provider: string; subject: string }, label: string) => {
    const ok = await confirm({
      title: t('users.externalIdentitiesModal.removeSignInLink', 'Remove sign-in link'),
      message: t(
        'users.externalIdentitiesModal.willNoLongerBeAble',
        '"{{username}}" will no longer be able to sign in with this {{label}} account.',
        { username, label },
      ),
      confirmLabel: t('common.remove', 'Remove'),
      variant: 'danger',
    })
    if (!ok) return
    unlink.mutate({ userId, provider: link.provider, subject: link.subject })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        width="md"
        placement="sheet-on-mobile"
        scroll="body"
        data-testid="external-identities-modal"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            <span>
              {t('users.externalIdentitiesModal.linkedSignInAccounts', 'Linked sign-in accounts')}
              <span className="mt-0.5 block text-[11px] font-normal text-foreground-subtle">
                {t('users.externalIdentitiesModal.user', 'User:')}{' '}
                <span className="font-mono">{username}</span>
              </span>
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {linksQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-foreground-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', 'Loading…')}
            </div>
          ) : links.length === 0 ? (
            <p className="text-xs text-foreground-subtle">
              {t(
                'users.externalIdentitiesModal.noLinkedAccountsOnlyThe',
                'No linked accounts. Only the user can link one, from their own profile page.',
              )}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {links.map((link) => {
                const live = labels.get(link.provider)
                const label = live ?? link.provider
                return (
                  <li
                    key={`${link.provider}|${link.subject}`}
                    className="flex items-center gap-3 px-3 py-2 text-xs"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {label}
                        {live === undefined && (
                          <span className="ml-2 rounded bg-foreground-subtle/15 px-1.5 py-0.5 text-[10px] font-normal text-foreground-subtle">
                            {t(
                              'users.externalIdentitiesModal.providerUnavailable',
                              'provider unavailable',
                            )}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-foreground-subtle truncate">
                        {link.label ?? link.subject} ·{' '}
                        {new Date(link.linkedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      onClick={() => void handleUnlink(link, label)}
                      disabled={unlink.isPending}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-danger hover:bg-danger/10 disabled:opacity-50"
                    >
                      <Unlink className="h-3 w-3" />
                      {t('common.remove', 'Remove')}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose} variant="secondary">
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
