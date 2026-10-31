/**
 * Active sessions — My access. The caller's own login sessions
 * (`auth.listOwnSessions`), each signed out on its own
 * (`auth.revokeOwnSession`), or all at once.
 *
 * "Sign out everywhere" is `auth.logout({ everywhere: true })`: it ends EVERY
 * session of the user, this browser's included, so it confirms saying so and
 * then forgets the session here through the auth context's `logout()`.
 */
import { useState } from 'react'
import { Loader2, LogOut, MonitorSmartphone } from 'lucide-react'
import { trpc, useConfirm, Button } from '@camstack/ui-library'

import { useAuth } from '../../contexts/auth-context'
import { describeClient } from './session-client'
import { SessionsList, type SessionRow } from './SessionsList'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

function errorMessage(err: { message: string }): string {
  return err.message.length > 0 ? err.message : i18n.t('auth.authAuditSection.requestFailed')
}

export function MySessionsSection() {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const query = trpc.auth.listOwnSessions.useQuery()
  const [error, setError] = useState<string | null>(null)

  const revoke = trpc.auth.revokeOwnSession.useMutation({
    onSuccess: () => void utils.auth.listOwnSessions.invalidate(),
    onError: (err: { message: string }) => setError(`Sign out failed: ${errorMessage(err)}`),
  })
  const everywhere = trpc.auth.logout.useMutation({
    onSuccess: () => logout(),
    onError: (err: { message: string }) => setError(`Sign out failed: ${errorMessage(err)}`),
  })

  const handleRevoke = async (session: SessionRow): Promise<void> => {
    const ok = await confirm({
      title: t('auth.mySessionsSection.signOutThisSession', 'Sign out this session'),
      message: t(
        'auth.mySessionsSection.willHaveToSignIn',
        '{{label}} will have to sign in again.',
        { label: describeClient(session.client).label },
      ),
      confirmLabel: t('auth.mySessionsSection.signOut', 'Sign out'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    revoke.mutate({ id: session.id })
  }

  const handleEverywhere = async (): Promise<void> => {
    const ok = await confirm({
      title: t('auth.mySessionsSection.signOutEverywhere', 'Sign out everywhere'),
      message: t(
        'auth.mySessionsSection.everySessionOfYourAccount',
        'Every session of your account ends, this browser included: you will be signed out here too and every device has to sign in again.',
      ),
      confirmLabel: t('auth.mySessionsSection.signOutEverywhere', 'Sign out everywhere'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    everywhere.mutate({ everywhere: true })
  }

  return (
    <div
      data-testid="my-sessions"
      className="rounded-lg border border-border bg-surface overflow-hidden"
    >
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <MonitorSmartphone className="h-3.5 w-3.5 text-foreground-subtle" />
        <div className="text-xs font-semibold text-foreground">
          {t('auth.mySessionsSection.activeSessions', 'Active sessions')}
        </div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'auth.mySessionsSection.theBrowsersAndAppsSigned',
            'The browsers and apps signed in to your account. Signing one out ends it at once.',
          )}
        </p>
        {error !== null && <div className="text-[11px] text-danger">{error}</div>}
        <SessionsList
          sessions={(query.data ?? []) as readonly SessionRow[]}
          isLoading={query.isLoading}
          loadError={
            query.isError
              ? (query.error?.message ?? t('auth.authAuditSection.requestFailed'))
              : null
          }
          emptyText="No active sessions."
          onRevoke={(s) => void handleRevoke(s)}
          revokingId={revoke.isPending ? (revoke.variables?.id ?? null) : null}
        />
        <div className="flex justify-end">
          <Button
            variant="unstyled"
            onClick={() => void handleEverywhere()}
            disabled={everywhere.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-danger/40 px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {everywhere.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <LogOut className="h-3 w-3" />
            )}
            {t('auth.mySessionsSection.signOutEverywhere', 'Sign out everywhere')}
          </Button>
        </div>
      </div>
    </div>
  )
}
