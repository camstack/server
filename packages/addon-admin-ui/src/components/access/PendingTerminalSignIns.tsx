/**
 * Terminal sign-ins waiting for an approval (D988), as the admin sees them
 * under Login sessions. A list carries no code, so it can only DENY ("not me");
 * approving takes the code typed at `/approve`.
 */
import { Button, trpc } from '@camstack/ui-library'
import { TerminalSquare } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { requestAge } from '../auth/CliLoginApproval'

const REFRESH_MS = 5_000

export function PendingTerminalSignIns(): JSX.Element | null {
  const { t } = useTranslation()
  const utils = trpc.useUtils()
  const pending = trpc.auth.cliLoginPending.useQuery(undefined, { refetchInterval: REFRESH_MS })
  const deny = trpc.auth.cliLoginDeny.useMutation({
    onSuccess: () => void utils.auth.cliLoginPending.invalidate(),
  })
  const rows = pending.data ?? []
  if (rows.length === 0) return null
  const now = Date.now()
  return (
    <div
      className="space-y-2 rounded-md border border-border bg-background-elevated p-3"
      data-testid="pending-terminal-signins"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
        {t('cliLogin.pendingTitle', 'Pending terminal sign-ins')}
      </div>
      <ul className="space-y-1">
        {rows.map((row) => {
          const age = requestAge(row.createdAt, now)
          return (
            <li key={row.requestId} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-foreground-muted">
                {row.userAgent ?? t('cliLogin.unknownValue', 'Unknown')}
                {' · '}
                {row.ip ?? t('cliLogin.unknownValue', 'Unknown')}
                {' · '}
                {age.key === 'justNow'
                  ? t('cliLogin.ageNow', 'just now')
                  : age.key === 'seconds'
                    ? t('cliLogin.ageSeconds', '{{count}} s ago', { count: age.value })
                    : t('cliLogin.ageMinutes', '{{count}} min ago', { count: age.value })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={deny.isPending}
                onClick={() => deny.mutate({ requestId: row.requestId })}
              >
                {t('cliLogin.notMe', 'Not me')}
              </Button>
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-foreground-subtle">
        {t(
          'cliLogin.pendingHint',
          'To approve one, open the approval page and type the code the terminal shows.',
        )}
      </p>
    </div>
  )
}
