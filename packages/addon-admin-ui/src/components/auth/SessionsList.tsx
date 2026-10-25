/**
 * The one list of login sessions, used by My access (the caller's own) and by
 * the admin's per-user Sessions modal on the Users page. Purely
 * presentational: the owner of the data and of the sign-out is the caller.
 *
 * The session this browser is using (`current`) is marked and has no per-row
 * sign-out — ending it is the page's own Sign out.
 */
import { Loader2, LogOut, Monitor } from 'lucide-react'
import { describeClient, describeMethod, formatDateTime } from './session-client'
import { useTranslation } from 'react-i18next'

export interface SessionRow {
  readonly id: string
  readonly userId: string
  readonly method: string
  readonly refreshable: boolean
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly client: string | null
  readonly ip: string | null
  readonly current: boolean
}

export interface SessionsListProps {
  readonly sessions: readonly SessionRow[]
  readonly isLoading: boolean
  readonly loadError: string | null
  readonly emptyText: string
  readonly onRevoke: (session: SessionRow) => void
  readonly revokingId: string | null
}

export function SessionsList({
  sessions,
  isLoading,
  loadError,
  emptyText,
  onRevoke,
  revokingId,
}: SessionsListProps) {
  const { t } = useTranslation()
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('auth.sessionsList.loadingSessions', 'Loading sessions…')}
      </div>
    )
  }
  if (loadError !== null) {
    return (
      <div className="text-[11px] text-danger">
        {t('auth.sessionsList.couldNotLoadSessions', 'Could not load sessions:')} {loadError}
      </div>
    )
  }
  if (sessions.length === 0) {
    return (
      <div className="rounded border border-dashed border-border px-3 py-4 text-xs text-foreground-subtle text-center">
        {emptyText}
      </div>
    )
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {sessions.map((s) => (
        <SessionItem
          key={s.id}
          session={s}
          revoking={revokingId === s.id}
          onRevoke={() => onRevoke(s)}
        />
      ))}
    </ul>
  )
}

interface SessionItemProps {
  readonly session: SessionRow
  readonly revoking: boolean
  readonly onRevoke: () => void
}

function SessionItem({ session, revoking, onRevoke }: SessionItemProps) {
  const { t } = useTranslation()
  const client = describeClient(session.client)
  return (
    <li data-testid="session-row" className="flex items-start gap-3 px-3 py-2 text-xs">
      <Monitor className="h-3.5 w-3.5 mt-0.5 shrink-0 text-foreground-subtle" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-foreground truncate" title={client.raw ?? undefined}>
            {client.label}
          </span>
          {session.current && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {t('auth.sessionsList.thisDevice', 'This device')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 text-[11px] text-foreground-subtle">
          <span>{describeMethod(session.method)}</span>
          <span className="font-mono">
            {session.ip ?? t('auth.sessionsList.ipUnknown', 'IP unknown')}
          </span>
          <span>
            {t('auth.sessionsList.lastActive', { when: formatDateTime(session.lastUsedAt) })}
          </span>
          <span>{t('auth.sessionsList.expires', { when: formatDateTime(session.expiresAt) })}</span>
        </div>
      </div>
      {!session.current && (
        <button
          onClick={onRevoke}
          disabled={revoking}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          {revoking ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
          {t('auth.sessionsList.signOut', 'Sign out')}
        </button>
      )}
    </li>
  )
}
