import { Badge } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { MigrationRowStatus } from './migration-rows'

const VARIANT: Readonly<
  Record<MigrationRowStatus, 'success' | 'danger' | 'warning' | 'info' | 'default' | 'neutral'>
> = {
  applied: 'success',
  failed: 'danger',
  blocked: 'warning',
  held: 'warning',
  running: 'info',
  pending: 'default',
  'skipped-newer': 'neutral',
}

export const MIGRATION_STATUS_LABEL: Readonly<Record<MigrationRowStatus, string>> = {
  applied: 'migrations.status.applied',
  failed: 'migrations.status.failed',
  blocked: 'migrations.status.blocked',
  held: 'migrations.status.held',
  running: 'migrations.status.running',
  pending: 'migrations.status.pending',
  'skipped-newer': 'migrations.status.skippedNewer',
}

export function MigrationStatusBadge({
  status,
}: {
  readonly status: MigrationRowStatus
}): ReactNode {
  const { t } = useTranslation()
  return (
    <Badge variant={VARIANT[status]} className="text-[10px]">
      {t(MIGRATION_STATUS_LABEL[status])}
    </Badge>
  )
}
