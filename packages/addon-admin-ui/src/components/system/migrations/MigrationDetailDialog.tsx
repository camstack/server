/**
 * One migration with every field the hub holds: the catalogued meta, the ledger
 * row (status, attempts, timestamps, code version, boot, node, plan summary,
 * progress, error, reason) and its `dependsOn` as links to the other rows. The
 * only call is the dry run — it runs the body in a transaction and rolls it back —
 * offered for a hub migration over a database file.
 */
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  trpc,
} from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MigrationStatusBadge } from './MigrationStatusBadge'
import { formatApplied } from './MigrationsTable'
import { canDryRun, type MigrationRow } from './migration-rows'

export interface MigrationDetailDialogProps {
  readonly row: MigrationRow | null
  readonly knownIds: ReadonlySet<string>
  readonly onOpenRow: (id: string) => void
  readonly onClose: () => void
}

function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  )
}

function Json({ value }: { readonly value: Record<string, unknown> | null }): ReactNode {
  if (value === null) return <span className="text-foreground-subtle">—</span>
  return (
    <pre className="max-h-40 overflow-auto rounded-md bg-surface p-2 font-mono text-xs text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function DryRun({ id }: { readonly id: string }): ReactNode {
  const { t } = useTranslation()
  const query = trpc.migrations.dryRun.useQuery({ id }, { enabled: false })
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
      >
        {query.isFetching && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
        {t('migrations.detail.dryRun', 'Run a dry run')}
      </Button>
      <p className="text-xs text-foreground-muted">
        {t(
          'migrations.detail.dryRunHint',
          'Runs the migration in a transaction and rolls it back. Nothing is written.',
        )}
      </p>
      {query.isError && (
        <ErrorBox
          title={t('migrations.detail.dryRunFailed', 'The dry run could not run')}
          message={query.error.message}
        />
      )}
      {query.data !== undefined && (
        <div className="space-y-1 text-xs" data-testid="dry-run-result">
          <div className="text-foreground">
            {query.data.ok
              ? t('migrations.detail.dryRunOk', 'Would change {{count}} rows', {
                  count: query.data.rowsChanged,
                })
              : (query.data.error ?? t('migrations.detail.dryRunThrows', 'It would fail'))}
          </div>
          {query.data.tables.map((tb) => (
            <div key={tb.table} className="font-mono text-foreground-muted">
              {tb.table}: {tb.before} → {tb.after}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MigrationDetailDialog({
  row,
  knownIds,
  onOpenRow,
  onClose,
}: MigrationDetailDialogProps): ReactNode {
  const { t } = useTranslation()
  const none = <span className="text-foreground-subtle">—</span>
  const meta = row?.meta ?? null
  const ledger = row?.ledger ?? null
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        {row !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="break-all font-mono text-base">{row.id}</DialogTitle>
              <DialogDescription>
                {meta?.description ??
                  t('migrations.detail.noMeta', 'No catalogue on this hub lists this migration.')}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <dl className="divide-y divide-border-subtle">
                <Field label={t('migrations.col.status', 'Status')}>
                  <MigrationStatusBadge status={row.status} />
                </Field>
                {row.error !== null && (
                  <Field label={t('migrations.detail.error', 'Error')}>
                    <span className="text-danger" data-testid="migration-error">
                      {row.error}
                    </span>
                  </Field>
                )}
                {row.reason !== null && (
                  <Field label={t('migrations.detail.reason', 'Reason')}>{row.reason}</Field>
                )}
                <Field label={t('migrations.col.owner', 'Owner')}>{row.owner}</Field>
                <Field label={t('migrations.col.level', 'Level')}>{meta?.level ?? none}</Field>
                <Field label={t('migrations.col.body', 'Body')}>{meta?.bodyKind ?? none}</Field>
                <Field label={t('migrations.detail.store', 'Store')}>
                  {meta?.store ?? none} · {row.database}
                </Field>
                <Field label={t('migrations.detail.scope', 'Scope')}>{meta?.scope ?? none}</Field>
                <Field label={t('migrations.detail.onFailure', 'On failure')}>
                  {meta?.onFailure ?? none}
                </Field>
                <Field label={t('migrations.detail.seq', 'Sequence in owner')}>{row.seq}</Field>
                <Field label={t('migrations.detail.fixtureMark', 'Fixture mark')}>
                  {meta?.fixtureMark ?? none}
                </Field>
                <Field label={t('migrations.detail.dependsOn', 'Depends on')}>
                  {meta === null || meta.dependsOn.length === 0 ? (
                    none
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {meta.dependsOn.map((dep) =>
                        knownIds.has(dep) ? (
                          <Button
                            key={dep}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="font-mono text-xs"
                            onClick={() => onOpenRow(dep)}
                          >
                            {dep}
                          </Button>
                        ) : (
                          <Badge key={dep} variant="neutral" className="font-mono text-xs">
                            {dep}
                          </Badge>
                        ),
                      )}
                    </div>
                  )}
                </Field>
                <Field label={t('migrations.col.applied', 'Applied')}>
                  {formatApplied(row.appliedAt)}
                </Field>
                <Field label={t('migrations.detail.attempts', 'Attempts')}>
                  {ledger?.attempts ?? none}
                </Field>
                <Field label={t('migrations.detail.codeVersion', 'Code version')}>
                  {ledger?.codeVersion ?? none}
                </Field>
                <Field label={t('migrations.detail.node', 'Node')}>{ledger?.nodeId ?? none}</Field>
                <Field label={t('migrations.detail.boot', 'Boot (snapshot id prefix)')}>
                  <span className="font-mono text-xs">{ledger?.bootId ?? none}</span>
                </Field>
                <Field label={t('migrations.detail.planSummary', 'Rows changed')}>
                  <Json value={ledger?.planSummary ?? null} />
                </Field>
                <Field label={t('migrations.detail.progress', 'Progress')}>
                  <Json value={ledger?.progress ?? null} />
                </Field>
              </dl>
              {canDryRun(row) && <DryRun key={row.id} id={row.id} />}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('migrations.detail.close', 'Close')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
