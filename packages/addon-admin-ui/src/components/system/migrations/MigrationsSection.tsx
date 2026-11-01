/**
 * System → Data → Migrations — read-only. Every migration the hub knows (ledger
 * joined with the pending list), a filterable table and a detail per row. A query
 * that did not answer is never "no migrations" (D315): pending shows progress, a
 * failed read shows the error, an absent capability says so.
 */
import { EmptyState, ErrorBox, SECTION_BODY, trpc } from '@camstack/ui-library'
import { Loader2, DatabaseZap } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useCapabilityPresence } from '../../../lib/capability-presence'
import { MigrationDetailDialog } from './MigrationDetailDialog'
import { MigrationsTable } from './MigrationsTable'
import { joinMigrationRows } from './migration-rows'

export const MIGRATION_PARAM = 'migration'

export function MigrationsSection(): ReactNode {
  const { t } = useTranslation()
  const presence = useCapabilityPresence('migrations')
  const enabled = presence === 'present'
  const ledger = trpc.migrations.listLedger.useQuery({}, { enabled })
  const pending = trpc.migrations.listPending.useQuery({}, { enabled })
  const [params, setParams] = useSearchParams()
  const openId = params.get(MIGRATION_PARAM)

  const rows = useMemo(
    () =>
      ledger.data === undefined || pending.data === undefined
        ? null
        : joinMigrationRows(ledger.data.entries, pending.data.pending),
    [ledger.data, pending.data],
  )
  const knownIds = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows])
  const open = rows?.find((r) => r.id === openId) ?? null

  const select = (id: string | null): void =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev)
        if (id === null) out.delete(MIGRATION_PARAM)
        else out.set(MIGRATION_PARAM, id)
        return out
      },
      { replace: true },
    )

  let body: ReactNode
  if (presence === 'pending') {
    body = <Progress label={t('migrations.loading', 'Loading migrations…')} />
  } else if (presence === 'unknown') {
    body = (
      <ErrorBox
        title={t('migrations.unknownTitle', 'Could not check the migration ledger')}
        message={t('migrations.unknownBody', 'The hub did not answer. Try again in a moment.')}
      />
    )
  } else if (presence === 'absent') {
    body = (
      <EmptyState
        icon={DatabaseZap}
        title={t('migrations.absentTitle', 'No migration ledger on this hub')}
        description={t(
          'migrations.absentBody',
          'Nothing on this hub provides the migrations capability.',
        )}
      />
    )
  } else if (ledger.isError || pending.isError) {
    body = (
      <ErrorBox
        title={t('migrations.loadFailed', 'Could not load the migrations')}
        message={(ledger.error ?? pending.error)?.message ?? ''}
      />
    )
  } else if (rows === null) {
    body = <Progress label={t('migrations.loading', 'Loading migrations…')} />
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={DatabaseZap}
        title={t('migrations.empty', 'No migrations.')}
        description={t('migrations.emptyBody', 'The ledger and the catalogues are both empty.')}
      />
    )
  } else {
    body = <MigrationsTable rows={rows} onOpen={select} />
  }

  return (
    <div className={SECTION_BODY}>
      <p className="mb-3 text-xs text-foreground-muted">
        {t(
          'migrations.intro',
          'Every data migration this hub knows: what ran, what is waiting and what failed. Read-only.',
        )}
      </p>
      {body}
      <MigrationDetailDialog
        row={open}
        knownIds={knownIds}
        onOpenRow={select}
        onClose={() => select(null)}
      />
    </div>
  )
}

function Progress({ label }: { readonly label: string }): ReactNode {
  return (
    <div className="flex items-center gap-2 py-4 text-xs text-foreground-subtle" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      {label}
    </div>
  )
}
