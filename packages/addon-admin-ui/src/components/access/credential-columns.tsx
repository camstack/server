/**
 * The columns every Tokens & sessions table shares, in one order:
 * name · owner · kind / scope · status · created · last used · expires · actions.
 *
 * Sort values are raw numbers / strings (never formatted text), and "no value"
 * is `null`, which the common DataTable always sorts last — so "never used"
 * and "never expires" sink to the bottom whichever way the column points.
 */
import type { DataColumn } from '@camstack/ui-library'
import { Badge, Button } from '@camstack/ui-library'
import type { LucideIcon } from 'lucide-react'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

import type { CredentialRow, CredentialStatus } from './credential-row'
import i18n from '../../i18n/index'

const STATUS_LABEL_KEY: Readonly<Record<CredentialStatus, string>> = {
  active: 'access.credentialColumns.statusActive',
  expired: 'access.credentialColumns.statusExpired',
  revoked: 'access.credentialColumns.statusRevoked',
  current: 'access.credentialColumns.statusCurrent',
}

export function statusLabel(status: CredentialStatus): string {
  return i18n.t(STATUS_LABEL_KEY[status])
}

const STATUS_VARIANT: Readonly<
  Record<CredentialStatus, 'success' | 'warning' | 'default' | 'info'>
> = {
  active: 'success',
  expired: 'warning',
  revoked: 'default',
  current: 'info',
}

/** Rank for the Status sort: live first, dead last. */
const STATUS_RANK: Readonly<Record<CredentialStatus, number>> = {
  current: 0,
  active: 1,
  expired: 2,
  revoked: 3,
}

export function formatWhen(ts: number | null, none: string): string {
  if (ts === null) return none
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function CredentialStatusBadge({ status }: { readonly status: CredentialStatus }): ReactNode {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="text-[10px]">
      {statusLabel(status)}
    </Badge>
  )
}

export interface CredentialRowAction {
  /** "Revoke", "Sign out", "Unlink". */
  readonly label: string
  readonly icon: LucideIcon
  /** Whether THIS row offers the action (a revoked token does not). */
  readonly isAvailable: (row: CredentialRow) => boolean
  readonly onRun: (row: CredentialRow) => void
  /** The row whose action is in flight, if any. */
  readonly busyId: string | null
  /** True while any write runs — one write at a time. */
  readonly disabled: boolean
  /** `neutral` for a non-destructive action (Rename); default `danger`. */
  readonly tone?: 'danger' | 'neutral'
}

export interface CredentialColumnOptions {
  readonly hideOwner: boolean
  readonly expiresNone: string
  readonly action: CredentialRowAction | null
  /** More row actions, drawn before `action` (Rename, Delete …). */
  readonly extraActions?: readonly CredentialRowAction[]
}

function ActionButton({
  row,
  action,
}: {
  readonly row: CredentialRow
  readonly action: CredentialRowAction
}): ReactNode {
  if (!action.isAvailable(row)) return null
  const Icon = action.icon
  const busy = action.busyId === row.id
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => action.onRun(row)}
      disabled={action.disabled}
      aria-label={i18n.t('access.credentialColumns.actionOn', {
        action: action.label,
        name: row.name,
      })}
      className={action.tone === 'neutral' ? undefined : 'text-danger hover:bg-danger/10'}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <Icon className="h-3 w-3" aria-hidden />
      )}
      {action.label}
    </Button>
  )
}

export function credentialColumns(opts: CredentialColumnOptions): DataColumn<CredentialRow>[] {
  const columns: (DataColumn<CredentialRow> | null)[] = [
    {
      key: 'name',
      header: i18n.t('access.credentialColumns.name', 'Name'),
      sortValue: (r) => r.name.toLowerCase(),
      render: (r) => (
        <div className="min-w-0 max-w-[18rem]">
          <div className="truncate font-medium text-foreground" title={r.name}>
            {r.name}
          </div>
          {r.detail !== null && (
            <div className="truncate font-mono text-[10px] text-foreground-subtle" title={r.detail}>
              {r.detail}
            </div>
          )}
        </div>
      ),
    },
    opts.hideOwner
      ? null
      : {
          key: 'owner',
          header: i18n.t('access.credentialColumns.owner', 'Owner'),
          sortValue: (r) => r.ownerName.toLowerCase(),
          render: (r) => r.ownerName,
        },
    {
      key: 'kind',
      header: i18n.t('access.credentialColumns.kindScope', 'Kind / scope'),
      sortValue: (r) => r.kind.toLowerCase(),
      nowrap: false,
      render: (r) => (
        <div className="min-w-[8rem] max-w-[16rem]">
          <div className="text-foreground">{r.kind}</div>
          {r.scope !== null && (
            <div className="line-clamp-2 text-[10px] text-foreground-subtle" title={r.scope}>
              {r.scope}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: i18n.t('access.credentialColumns.status', 'Status'),
      sortValue: (r) => STATUS_RANK[r.status],
      render: (r) => <CredentialStatusBadge status={r.status} />,
    },
    {
      key: 'created',
      header: i18n.t('access.credentialColumns.created', 'Created'),
      sortValue: (r) => r.createdAt,
      render: (r) => <span className="text-foreground-subtle">{formatWhen(r.createdAt, '—')}</span>,
    },
    {
      key: 'lastUsed',
      header: i18n.t('access.credentialColumns.lastUsed', 'Last used'),
      sortValue: (r) => r.lastUsedAt,
      render: (r) => (
        <span className="text-foreground-subtle">
          {formatWhen(r.lastUsedAt, i18n.t('access.credentialColumns.never'))}
        </span>
      ),
    },
    {
      key: 'expires',
      header: i18n.t('access.credentialColumns.expires', 'Expires'),
      sortValue: (r) => r.expiresAt,
      render: (r) => (
        <span className="text-foreground-subtle">{formatWhen(r.expiresAt, opts.expiresNone)}</span>
      ),
    },
    opts.action === null
      ? null
      : {
          key: 'actions',
          header: '',
          align: 'right',
          notSortableReason: i18n.t('access.credentialColumns.actionsHeader'),
          render: (r) => (
            <div className="flex items-center justify-end gap-1">
              {[...(opts.extraActions ?? []), opts.action].map((a) =>
                a === null ? null : <ActionButton key={a.label} row={r} action={a} />,
              )}
            </div>
          ),
        },
  ]
  return columns.filter((c): c is DataColumn<CredentialRow> => c !== null)
}
