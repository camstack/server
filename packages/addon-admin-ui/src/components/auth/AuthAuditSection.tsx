/**
 * Auth audit — Identity → Tokens & sessions → Audit, admin-only. The latest 100 records of the
 * hub's authentication audit trail (`auth.listAuthAudit`), newest first:
 * tokens minted / revoked, every use of an all-permissions token, and second
 * factors skipped on a
 * trusted network. Admin-only on the hub, so a non-admin never mounts the
 * reader and never sends the read.
 */
import { useMemo } from 'react'
import { Loader2, ScrollText } from 'lucide-react'
import { trpc, useUserManagementListUsers } from '@camstack/ui-library'

import { useAuth } from '../../contexts/auth-context'
import { describeAuditEvent, type AuthAuditRecord } from './auth-audit-wording'
import { formatDateTime } from './session-client'
import { useTranslation } from 'react-i18next'

const AUDIT_LIMIT = 100

export function AuthAuditSection() {
  const { user } = useAuth()
  if (!user?.isAdmin) return null
  return <AuthAudit />
}

function useNameMaps() {
  const { data: users } = useUserManagementListUsers()
  // Same read (and cache entry) as the Tokens table: names a revoked token
  // whose audit record carries only its id.
  const { data: tokens } = trpc.auth.listTokens.useQuery(undefined)
  return useMemo(() => {
    const userNameById = new Map<string, string>()
    for (const u of users ?? []) userNameById.set(u.id, u.username)
    const tokenNameById = new Map<string, string>()
    for (const t of tokens ?? []) tokenNameById.set(t.id, t.label)
    return { userNameById, tokenNameById }
  }, [users, tokens])
}

function AuthAudit() {
  const { t } = useTranslation()
  const query = trpc.auth.listAuthAudit.useQuery({ limit: AUDIT_LIMIT })
  const { userNameById, tokenNameById } = useNameMaps()
  const records = (query.data ?? []) as readonly AuthAuditRecord[]

  return (
    <div
      data-testid="auth-audit"
      className="rounded-lg border border-border bg-surface overflow-hidden"
    >
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <ScrollText className="h-3.5 w-3.5 text-foreground-subtle" />
        <div className="text-xs font-semibold text-foreground">
          {t('auth.authAuditSection.authenticationAudit', 'Authentication audit')}
        </div>
        <span className="ml-auto text-[10px] text-foreground-subtle">
          {t('auth.authAuditSection.latest', { count: AUDIT_LIMIT })}
        </span>
      </div>
      <div className="p-4">
        {query.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('auth.authAuditSection.loadingAuditTrail', 'Loading audit trail…')}
          </div>
        ) : query.isError ? (
          <div className="text-[11px] text-danger">
            {t('auth.authAuditSection.couldNotLoadTheAudit', 'Could not load the audit trail:')}{' '}
            {query.error?.message ?? t('auth.authAuditSection.requestFailed', 'Request failed')}
          </div>
        ) : records.length === 0 ? (
          <div className="rounded border border-dashed border-border px-3 py-4 text-xs text-foreground-subtle text-center space-y-1">
            <div>
              {t(
                'auth.authAuditSection.noAuthenticationEventsRecordedYet',
                'No authentication events recorded yet.',
              )}
            </div>
            <div className="text-[11px] text-foreground-subtle/90">
              {t(
                'auth.authAuditSection.thisTrailRecordsAdminToken',
                'This trail records admin-token create/use/revoke, trusted-network 2FA skips, and credential revokes (including single share-link revoke). Browser password logins are not listed here.',
              )}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border max-h-[420px] overflow-y-auto">
            {records.map((r) => (
              <AuditItem
                key={r.id}
                record={r}
                userName={r.userId === undefined ? null : (userNameById.get(r.userId) ?? r.userId)}
                tokenNameById={tokenNameById}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface AuditItemProps {
  readonly record: AuthAuditRecord
  readonly userName: string | null
  readonly tokenNameById: ReadonlyMap<string, string>
}

function AuditItem({ record, userName, tokenNameById }: AuditItemProps) {
  const wording = describeAuditEvent(record, tokenNameById)
  return (
    <li data-testid="auth-audit-row" className="px-3 py-2 text-xs space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground">{wording.title}</span>
        <span className="ml-auto text-[10px] text-foreground-subtle">
          {formatDateTime(record.at)}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-[11px] text-foreground-subtle">
        {userName !== null && <span className="text-foreground">{userName}</span>}
        {record.ip !== undefined && <span className="font-mono">{record.ip}</span>}
        {wording.details.map((d) => (
          <span key={d} className="font-mono">
            {d}
          </span>
        ))}
      </div>
    </li>
  )
}
