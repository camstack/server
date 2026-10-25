/**
 * A user's login sessions, as an admin sees them on the Users page
 * (`auth.listSessions({ userId })`). The admin signs one out
 * (`auth.revokeSessions({ id })`) or all of them (`{ userId }`).
 *
 * The admin's own current session is marked and has no per-row sign-out. If
 * the admin signs out everywhere on their OWN account, this browser's session
 * ended with the rest, so the auth context forgets it too.
 */
import { useState } from 'react'
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
} from '@camstack/ui-library'
import { Loader2, LogOut, MonitorSmartphone } from 'lucide-react'

import { useAuth } from '../../contexts/auth-context'
import { describeClient } from '../auth/session-client'
import { SessionsList, type SessionRow } from '../auth/SessionsList'
import { useTranslation } from 'react-i18next'

interface UserSessionsModalProps {
  readonly userId: string
  readonly username: string
  readonly onClose: () => void
}

export function UserSessionsModal({ userId, username, onClose }: UserSessionsModalProps) {
  const { t } = useTranslation()
  const { user: caller, logout } = useAuth()
  const isSelf = caller?.id === userId
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const query = trpc.auth.listSessions.useQuery({ userId })
  const [error, setError] = useState<string | null>(null)
  const revoke = trpc.auth.revokeSessions.useMutation({
    onSuccess: (_result: unknown, input: { id: string } | { userId: string }) => {
      if (isSelf && 'userId' in input) {
        logout()
        return
      }
      void utils.auth.listSessions.invalidate()
    },
    onError: (err: { message: string }) => setError(`Sign out failed: ${err.message}`),
  })

  const handleRevoke = async (session: SessionRow): Promise<void> => {
    const ok = await confirm({
      title: t('users.userSessionsModal.signOutThisSession', 'Sign out this session'),
      message: t(
        'users.userSessionsModal.onWillHaveToSign',
        '"{{username}}" on {{label}} will have to sign in again.',
        { username, label: describeClient(session.client).label },
      ),
      confirmLabel: t('users.userSessionsModal.signOut', 'Sign out'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    revoke.mutate({ id: session.id })
  }

  const handleEverywhere = async (): Promise<void> => {
    const ok = await confirm({
      title: t('users.userSessionsModal.signOutEverywhere', 'Sign out everywhere'),
      message: isSelf
        ? t(
            'users.userSessionsModal.everySessionOfYourOwn',
            'Every session of your own account ends, this browser included: you will be signed out here too.',
          )
        : t(
            'users.userSessionsModal.everySessionOfEndsAt',
            'Every session of "{{username}}" ends at once; each device has to sign in again.',
            { username },
          ),
      confirmLabel: t('users.userSessionsModal.signOutEverywhere', 'Sign out everywhere'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    revoke.mutate({ userId })
  }

  const revokingId =
    revoke.isPending && revoke.variables !== undefined && 'id' in revoke.variables
      ? revoke.variables.id
      : null

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        width="lg"
        placement="sheet-on-mobile"
        scroll="body"
        data-testid="user-sessions-modal"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorSmartphone className="h-4 w-4 text-primary" />
            <span>
              {t('users.userSessionsModal.activeSessions', 'Active sessions')}
              <span className="mt-0.5 block text-[11px] font-normal text-foreground-subtle">
                {t('users.userSessionsModal.user', 'User:')}{' '}
                <span className="font-mono">{username}</span>
              </span>
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {error !== null && <div className="text-[11px] text-danger">{error}</div>}
          <SessionsList
            sessions={(query.data ?? []) as readonly SessionRow[]}
            isLoading={query.isLoading}
            loadError={query.isError ? (query.error?.message ?? 'Request failed') : null}
            emptyText="No active sessions."
            onRevoke={(s) => void handleRevoke(s)}
            revokingId={revokingId}
          />
        </DialogBody>
        <DialogFooter className="justify-between">
          <button
            onClick={() => void handleEverywhere()}
            disabled={revoke.isPending || (query.data ?? []).length === 0}
            className="inline-flex items-center gap-1.5 rounded border border-danger/40 px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {revoke.isPending && revokingId === null ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <LogOut className="h-3 w-3" />
            )}
            {t('users.userSessionsModal.signOutEverywhere', 'Sign out everywhere')}
          </button>
          <Button onClick={onClose} variant="secondary">
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
