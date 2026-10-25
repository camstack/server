/**
 * Login sessions (D812) — every signed-in browser and app on the hub, every
 * user's (`auth.listSessions`). The session this browser uses is marked and
 * can be neither signed out nor selected here: ending it is the page's own
 * Sign out.
 */
import { trpc, useConfirm } from '@camstack/ui-library'
import { LogOut, MonitorSmartphone } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { describeClient, describeMethod } from '../auth/session-client'
import { AccessSection, useUserNames, pickNotice } from './AccessSection'
import { CredentialTable } from './CredentialTable'
import { loginSessionRow, type CredentialRow, type LoginSessionSource } from './credential-row'
import { useBulkRevoke } from './use-bulk-revoke'
import { useTranslation } from 'react-i18next'

const NOUN = { key: 'access.nouns.session' } as const

export function LoginSessionsSection(): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const names = useUserNames()
  const query = trpc.auth.listSessions.useQuery()
  const [error, setError] = useState<string | null>(null)
  const refresh = () => void utils.auth.listSessions.invalidate()
  const revoke = trpc.auth.revokeSessions.useMutation({
    onSuccess: refresh,
    onError: (err: { message: string }) => setError(`Sign out failed: ${err.message}`),
  })
  const bulk = useBulkRevoke(NOUN, refresh)

  const rows = useMemo(
    () =>
      ((query.data ?? []) as readonly LoginSessionSource[]).map((s) =>
        loginSessionRow(s, names, {
          client: (raw) => describeClient(raw).label,
          method: describeMethod,
        }),
      ),
    [query.data, names],
  )

  const signOut = async (row: CredentialRow): Promise<void> => {
    const ok = await confirm({
      title: t('access.loginSessionsSection.signOutThisSession', 'Sign out this session'),
      message: t(
        'access.loginSessionsSection.onWillHaveToSign',
        '{{ownerName}} on {{name}} will have to sign in again.',
        { ownerName: row.ownerName, name: row.name },
      ),
      confirmLabel: t('access.loginSessionsSection.signOut', 'Sign out'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    revoke.mutate({ id: row.id })
  }

  return (
    <AccessSection
      notice={pickNotice(error, bulk.outcome)}
      onDismissNotice={() => {
        setError(null)
        bulk.dismiss()
      }}
      id="login-sessions"
      title={t('access.loginSessionsSection.loginSessions', 'Login sessions')}
      icon={MonitorSmartphone}
      description={t(
        'access.loginSessionsSection.everyBrowserAndAppSigned',
        'Every browser and app signed in to this hub, for every user. Signing one out ends it at once; it has to sign in again. Your own current session is marked and never included in a bulk sign-out.',
      )}
    >
      <CredentialTable
        rows={rows}
        label={t('common.sessionsLabel')}
        isLoading={query.isLoading}
        loadError={query.isError ? (query.error?.message ?? 'Request failed') : null}
        emptyText="No active sessions."
        action={{
          label: t('access.loginSessionsSection.signOut', 'Sign out'),
          icon: LogOut,
          isAvailable: (r) => r.status === 'active',
          onRun: (r) => void signOut(r),
          busyId:
            revoke.isPending && revoke.variables !== undefined && 'id' in revoke.variables
              ? revoke.variables.id
              : null,
          disabled: revoke.isPending || bulk.busy,
        }}
        bulk={{ revoke: bulk, noun: NOUN, isSelectable: (r) => r.status === 'active' }}
      />
    </AccessSection>
  )
}
