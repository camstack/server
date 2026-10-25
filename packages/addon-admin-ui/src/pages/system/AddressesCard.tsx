/**
 * Network → "Addresses": one table of every address this hub is reached at —
 * the detected endpoints, the operator's custom addresses and the CamStack
 * app link — each ticked for the roles it serves. App connections take many rows;
 * Notification taps, Public endpoint and Internal take one (ticking another row moves it).
 * An empty column is automatic, and the summary says what is in use.
 */
import type { HubAddressBook, HubAddressRow } from '@camstack/types'
import { validateCustomAddress } from '@camstack/types'
import { Button, Card, Checkbox, type DataColumn, DataTable, Input } from '@camstack/ui-library'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  isRoleChecked,
  ROLE_COLUMNS,
  ROLES_CUSTOM_ADDRESS_HELP,
  type RoleColumn,
  roleToggle,
  type SetAddressRoleInput,
  summarizeRoles,
} from './address-table-model'
import { useTranslation } from 'react-i18next'

const KIND_BADGE: Record<string, { readonly labelKey: string; readonly className: string }> = {
  'lan-ipv4': {
    labelKey: 'system.addressesCard.kindIpv4',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
  'lan-ipv6': {
    labelKey: 'system.addressesCard.kindIpv6',
    className: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  },
  public: {
    labelKey: 'system.addressesCard.kindPublic',
    className: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  },
  'app-link': {
    labelKey: 'system.addressesCard.kindAppLink',
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  },
  custom: {
    labelKey: 'system.addressesCard.kindCustom',
    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  },
  loopback: {
    labelKey: 'system.addressesCard.kindLoopback',
    className: 'bg-foreground-subtle/15 text-foreground-subtle',
  },
}

export interface AddressesCardProps {
  readonly book: HubAddressBook | undefined
  readonly loading: boolean
  readonly saving: boolean
  /** The hub's refusal of the last change, if any. */
  readonly error: string | null
  readonly onSetRole: (input: SetAddressRoleInput) => void
  readonly onAdd: (baseUrl: string, label: string) => void
  readonly onRemove: (baseUrl: string) => void
}

interface PendingHttp {
  readonly input: SetAddressRoleInput
  readonly reason: string
}

export function AddressesCard({
  book,
  loading,
  saving,
  error,
  onSetRole,
  onAdd,
  onRemove,
}: AddressesCardProps) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [pendingHttp, setPendingHttp] = useState<PendingHttp | null>(null)

  const submit = (): void => {
    const check = validateCustomAddress(url)
    if (!check.ok) {
      setUrlError(check.reason)
      return
    }
    setUrlError(null)
    setUrl('')
    setLabel('')
    onAdd(check.baseUrl, label.trim())
  }

  const click = (row: HubAddressRow, column: RoleColumn): void => {
    const toggle = roleToggle(row, column.role)
    if (toggle.kind === 'none') return
    if (toggle.kind === 'confirm-http') {
      setPendingHttp({ input: toggle.input, reason: toggle.reason })
      return
    }
    setPendingHttp(null)
    onSetRole(toggle.input)
  }

  const columns: readonly DataColumn<HubAddressRow>[] = [
    {
      key: 'url',
      header: t('system.addressesCard.address', 'Address'),
      render: (row) => (
        <div className="min-w-0 py-0.5">
          <div
            className={`font-mono text-[12px] break-all ${
              row.plausible ? 'text-foreground' : 'text-foreground-subtle'
            }`}
          >
            {row.baseUrl}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground-subtle">
            <span>{row.label}</span>
            {row.kind === 'app-link' && (
              <span className="font-mono">
                {/* i18n-ignore: `hub=` is a literal field name, not prose */}
                hub={' '}
                {book?.appLinkHub ??
                  t(
                    'system.addressesCard.noneNoTunnelOrTailscale',
                    'none (no tunnel or Tailscale)',
                  )}
              </span>
            )}
            {row.custom && row.detected && (
              <span>
                {t('system.addressesCard.alsoAddedAsACustom', 'also added as a custom address')}
              </span>
            )}
            {row.kind !== 'custom' &&
              row.interfaceKind !== 'lan' &&
              row.interfaceKind !== 'public' &&
              row.interfaceKind !== 'other' && (
                <span className="uppercase tracking-wide">{row.interfaceKind}</span>
              )}
            {!row.plausible && row.interfaceKind !== 'loopback' && (
              <span
                className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
                title={row.plausibleReason || undefined}
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {t('system.addressesCard.unlikelyUsable', 'Unlikely usable')}
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'kind',
      header: t('system.addressesCard.kind', 'Kind'),
      nowrap: true,
      render: (row) => {
        const badge = KIND_BADGE[row.kind] ?? KIND_BADGE.loopback!
        return (
          <span className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${badge.className}`}>
            {t(badge.labelKey)}
          </span>
        )
      },
    },
    ...ROLE_COLUMNS.map(
      (column): DataColumn<HubAddressRow> => ({
        key: column.role,
        headerRender: () => <span title={column.help}>{column.title}</span>,
        align: 'center',
        nowrap: true,
        width: 'w-24',
        render: (row) => {
          const allowed = row.eligible.includes(column.role)
          const flagged = row.flags.includes(column.role)
          const checked = isRoleChecked(row, column.role)
          return (
            <label
              className={`inline-flex items-center justify-center gap-1 ${allowed ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}
              title={
                allowed
                  ? checked && !flagged
                    ? t(
                        'system.addressesCard.inUseAutomatically',
                        '{{title}}: in use automatically. {{help}}',
                        { title: column.title, help: column.help },
                      )
                    : column.help
                  : t(
                      'system.addressesCard.thisAddressCannotBeUsed',
                      'This address cannot be used for this.',
                    )
              }
            >
              <Checkbox
                checked={allowed && checked}
                disabled={!allowed || saving}
                onChange={() => click(row, column)}
                aria-label={`${column.title}: ${row.baseUrl}`}
              />
              {checked && !flagged && allowed && (
                <span className="text-[9px] text-foreground-subtle">{t('common.auto')}</span>
              )}
            </label>
          )
        },
      }),
    ),
    {
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      render: (row) =>
        row.custom ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => onRemove(row.baseUrl)}
            aria-label={t('system.addressesCard.remove', 'Remove {{baseUrl}}', {
              baseUrl: row.baseUrl,
            })}
            title={t(
              'system.addressesCard.removeThisCustomAddressIts',
              'Remove this custom address (its roles turn automatic)',
            )}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        ) : null,
    },
  ]

  const summary = book === undefined ? [] : summarizeRoles(book)

  return (
    <Card>
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2">
        <div>
          <div className="text-sm font-semibold">
            {t('system.addressesCard.addresses', 'Addresses')}
          </div>
          <div className="text-xs text-foreground-subtle max-w-3xl">
            {t(
              'system.addressesCard.everyAddressThisHubIs',
              'Every address this hub is reached at, detected or added by you. Tick what each one is used for.',
            )}
          </div>
          <details className="mt-1.5 text-xs max-w-3xl" data-testid="address-roles-help">
            <summary className="cursor-pointer select-none text-foreground-subtle hover:text-foreground">
              {t('system.addressesCard.whatAreRoles', 'What are roles?')}
            </summary>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {ROLE_COLUMNS.map((column) => (
                <div key={column.role} className="contents">
                  <dt className="font-medium">{column.title}</dt>
                  <dd className="text-foreground-subtle">{column.help}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1.5 text-foreground-subtle">{ROLES_CUSTOM_ADDRESS_HELP}</p>
          </details>
        </div>
        {summary.length > 0 && (
          <div
            className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 items-baseline text-xs"
            data-testid="address-roles-summary"
          >
            {summary.map((s) => (
              <div key={s.role} className="contents">
                <span className="text-foreground-subtle">{s.title}</span>
                <span className="font-mono break-all" data-testid={`address-role-${s.role}`}>
                  {s.inUse}
                  <span className="ml-1.5 font-sans text-foreground-subtle">
                    {s.automatic
                      ? t('system.addressesCard.automatic', '(automatic)')
                      : t('system.addressesCard.setByYou', '(set by you)')}
                  </span>
                </span>
                {s.automatic ? (
                  <span />
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving}
                    onClick={() => onSetRole({ role: s.role, baseUrl: null, enabled: false })}
                  >
                    {t('system.addressesCard.useAutomatic', 'Use automatic')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {pendingHttp !== null && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            <span className="flex-1 min-w-[220px]">{pendingHttp.reason}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onSetRole({ ...pendingHttp.input, acceptInsecureHttp: true })
                setPendingHttp(null)
              }}
            >
              {t('system.addressesCard.useHttpAnyway', 'Use http anyway')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingHttp(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        )}
        {error !== null && (
          <div className="text-[11px] text-red-600 dark:text-red-400" role="alert">
            {error}
          </div>
        )}
      </div>
      <DataTable
        columns={columns}
        rows={book?.rows ?? []}
        rowKey={(row) => `${row.kind}-${row.baseUrl}`}
        minWidthPx={760}
        bordered={false}
        emptyMessage={
          loading
            ? t('common.loading', 'Loading…')
            : t('system.addressesCard.noAddressesAvailable', 'No addresses available.')
        }
        rowClassName={(row) => (!row.plausible ? 'opacity-80' : undefined)}
      />
      <div className="px-4 py-3 border-t border-border flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-[220px]">
          <Input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setUrlError(null)
            }}
            placeholder="https://cams.example.com or https://192.0.2.20:4443"
            aria-label={t('system.addressesCard.customAddress', 'Custom address')}
            disabled={saving}
          />
          {urlError !== null && (
            <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">{urlError}</div>
          )}
        </div>
        <div className="w-48">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('system.addressesCard.labelOptional', 'Label (optional)')}
            aria-label={t('system.addressesCard.customAddressLabel', 'Custom address label')}
            maxLength={80}
            disabled={saving}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={saving || url.trim() === ''}
          onClick={submit}
        >
          <Plus className="h-3 w-3" />
          {t('system.addressesCard.addCustomAddress', 'Add custom address')}
        </Button>
      </div>
    </Card>
  )
}
