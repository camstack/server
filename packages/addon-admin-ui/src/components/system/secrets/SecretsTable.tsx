/**
 * Every stored keychain value by owner, scope and field — never the value.
 *
 * The library `DataTable`, scrolling inside its own box (`maxBodyHeight`) and
 * sideways on a phone. Long scopes and fields are
 * truncated with the full ref as tooltip and a copy button, so no row is ever
 * taller or wider than its neighbours. Reveal opens a dialog (the page owns
 * it); nothing about a reveal changes this table's layout.
 *
 * A usage filter narrows the rows; with orphans present, "Delete N orphans"
 * removes exactly the orphan refs after a confirm. `unknown` usage is shown as
 * "Unavailable" and is never offered for deletion: absence is claimed only
 * from a read that answered.
 */
import type { KeychainAdminSecret, KeychainSecretUsage } from '@camstack/types'
import { Badge, Button, DataTable, type DataColumn, TABLE_SCROLL_MAX_H } from '@camstack/ui-library'
import { Eye, Puzzle, Server, Trash2 } from 'lucide-react'
import { AddonAssetIcon } from '../../shared/AddonAssetIcon'
import { formatWhen } from './format'
import { Truncated } from './Truncated'
import { useTranslation } from 'react-i18next'
import i18n from '../../../i18n/index'

export type SecretsFilter = 'all' | KeychainSecretUsage

const USAGE: Record<
  KeychainSecretUsage,
  {
    labelKey: string
    variant: 'success' | 'warning' | 'default'
    hintKey: string
    rank: number
  }
> = {
  orphan: {
    labelKey: 'secrets.secretsTableState.usageOrphan',
    variant: 'warning',
    hintKey: 'secrets.secretsTableState.usageOrphanHint',
    rank: 0,
  },
  unknown: {
    labelKey: 'secrets.secretsTableState.usageUnknown',
    variant: 'default',
    hintKey: 'secrets.secretsTableState.usageUnknownHint',
    rank: 1,
  },
  'in-use': {
    labelKey: 'secrets.secretsTableState.usageInUse',
    variant: 'success',
    hintKey: 'secrets.secretsTableState.usageInUseHint',
    rank: 2,
  },
}

const FILTERS: readonly { id: SecretsFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'common.all' },
  { id: 'in-use', labelKey: 'secrets.secretsTableState.usageInUse' },
  { id: 'orphan', labelKey: 'secrets.secretsTableState.filterOrphans' },
  { id: 'unknown', labelKey: 'secrets.secretsTableState.usageUnknown' },
]

const SYSTEM_OWNER = 'system'

export interface SecretsTableProps {
  readonly secrets: readonly KeychainAdminSecret[] | undefined
  readonly locked: boolean
  readonly filter: SecretsFilter
  readonly onFilterChange: (filter: SecretsFilter) => void
  readonly onReveal: (entry: KeychainAdminSecret) => void
  readonly revealing: boolean
  readonly onDeleteOrphans: (refs: readonly string[]) => void
  readonly deleting: boolean
}

export function SecretsTable(props: SecretsTableProps) {
  const { t } = useTranslation()
  const { secrets, filter, onFilterChange, onDeleteOrphans, deleting, locked } = props
  if (secrets === undefined)
    return <p className="text-xs text-foreground-subtle">{t('common.loading', 'Loading…')}</p>
  const count = (f: SecretsFilter) =>
    f === 'all' ? secrets.length : secrets.filter((s) => s.usage === f).length
  const orphanRefs = secrets.filter((s) => s.usage === 'orphan').map((s) => s.ref)
  const rows = filter === 'all' ? secrets : secrets.filter((s) => s.usage === filter)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('secrets.secretsTable.filterByUsage', 'Filter by usage')}
        >
          {FILTERS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={filter === f.id ? 'secondary' : 'ghost'}
              aria-pressed={filter === f.id}
              className={filter === f.id ? 'ring-1 ring-border' : undefined}
              onClick={() => onFilterChange(f.id)}
            >
              {t(f.labelKey)}
              <span className="text-foreground-subtle tabular-nums">{count(f.id)}</span>
            </Button>
          ))}
        </div>
        {orphanRefs.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={deleting || locked}
            onClick={() => onDeleteOrphans(orphanRefs)}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t('secrets.secretsTableState.deleteOrphans', { count: orphanRefs.length })}
          </Button>
        )}
      </div>
      <DataTable
        columns={secretColumns(props)}
        rows={rows}
        rowKey={(s) => s.ref}
        minWidthPx={860}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'owner', dir: 'asc' }}
        emptyMessage={
          secrets.length === 0
            ? t('secrets.secretsTable.noValueIsStoredIn', 'No value is stored in the keychain yet.')
            : t(
                'secrets.secretsTable.noStoredValueMatchesThis',
                'No stored value matches this filter.',
              )
        }
      />
    </div>
  )
}

function OwnerCell({ owner }: { readonly owner: string }) {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-2">
      <AddonAssetIcon
        addonId={owner}
        fallback={owner === SYSTEM_OWNER ? Server : Puzzle}
        tileClassName="bg-surface-hover text-foreground-subtle"
        size="sm"
      />
      <span className="font-medium">
        {owner === SYSTEM_OWNER ? t('secrets.secretsTable.hubSystem', 'Hub (system)') : owner}
      </span>
    </span>
  )
}

function secretColumns({
  locked,
  onReveal,
  revealing,
}: SecretsTableProps): DataColumn<KeychainAdminSecret>[] {
  return [
    {
      key: 'owner',
      header: i18n.t('secrets.secretsTable.owner', 'Owner'),
      render: (s) => <OwnerCell owner={s.owner} />,
      sortValue: (s) => s.owner,
    },
    {
      key: 'scope',
      header: i18n.t('secrets.secretsTable.scope', 'Scope'),
      render: (s) => (
        <span className="block max-w-[11rem] truncate font-mono" title={s.scope}>
          {s.scope}
        </span>
      ),
      sortValue: (s) => s.scope,
    },
    {
      key: 'field',
      header: i18n.t('secrets.secretsTable.field', 'Field'),
      render: (s) => (
        <Truncated
          value={s.fieldPath}
          copyValue={s.ref}
          srLabel="secret ref"
          maxWidthClass="max-w-[16rem]"
        />
      ),
      sortValue: (s) => s.fieldPath,
    },
    {
      key: 'updated',
      header: i18n.t('secrets.secretsTable.updated', 'Updated'),
      render: (s) => formatWhen(s.updatedAt),
      sortValue: (s) => s.updatedAt,
    },
    {
      key: 'last-read',
      header: i18n.t('secrets.secretsTable.lastRead', 'Last read'),
      render: (s) => formatWhen(s.lastReadAt),
      sortValue: (s) => s.lastReadAt,
    },
    {
      key: 'status',
      header: i18n.t('secrets.secretsTable.status', 'Status'),
      render: (s) => (
        <Badge variant={USAGE[s.usage].variant} title={i18n.t(USAGE[s.usage].hintKey)}>
          {i18n.t(USAGE[s.usage].labelKey)}
        </Badge>
      ),
      sortValue: (s) => USAGE[s.usage].rank,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: 'Actions',
      render: (s) => (
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || revealing}
          aria-label={i18n.t('secrets.secretsTable.reveal', 'Reveal {{fieldPath}}', {
            fieldPath: s.fieldPath,
          })}
          title={
            locked
              ? i18n.t('secrets.secretsTable.theKeychainIsLocked', 'The keychain is locked')
              : i18n.t('secrets.secretsTable.revealAudited', 'Reveal (audited)')
          }
          onClick={() => onReveal(s)}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {i18n.t('secrets.secretsTable.reveal2', 'Reveal')}
        </Button>
      ),
    },
  ]
}
