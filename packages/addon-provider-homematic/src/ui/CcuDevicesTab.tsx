import { useMemo, useState } from 'react'
import {
  Badge,
  DataTable,
  DataTableFilterBar,
  ErrorBox,
  KebabMenu,
  useDataTableFilter,
  type DataColumn,
  type DataTableFilterConfig,
} from '@camstack/ui-library'
import { Trash2 } from 'lucide-react'
import { CcuDevicesResultSchema, OkResultSchema, type CcuDeviceRow } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { percentOrDash, textOrDash } from './format.js'
import { DeleteDeviceDialog, type DeleteDraft } from './DeleteDeviceDialog.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

type DeviceIssue = 'unreach' | 'sabotage' | 'lowBattery' | 'configPending' | 'ok'

/** The most urgent thing wrong with a device, for the filter chips. */
export function deviceIssue(row: CcuDeviceRow): DeviceIssue {
  if (row.unreach === true) return 'unreach'
  if (row.sabotage === true) return 'sabotage'
  if (row.lowBattery === true) return 'lowBattery'
  if (row.configPending === true) return 'configPending'
  return 'ok'
}

const FILTER_CONFIG: DataTableFilterConfig<CcuDeviceRow> = {
  searchText: (row) => [row.name ?? '', row.address, row.type, ...row.rooms, ...row.functions],
  facetGroups: [
    { id: 'issue', value: deviceIssue },
    { id: 'type', value: (row) => row.type },
  ],
}

function signalText(row: CcuDeviceRow): string {
  return row.rssi === null ? '—' : `${row.rssi} dBm`
}

/** The CCU device list: identity, firmware and the health flags the WebUI buries in "Servicemeldungen". */
export function CcuDevicesTab(props: { readonly trpc: CcuTrpc; readonly integrationId: string }) {
  const { trpc, integrationId } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const devices = useCcuData(trpc, 'listCcuDevices', input, CcuDevicesResultSchema)
  const rows = useMemo(() => devices.data?.devices ?? [], [devices.data])
  const filter = useDataTableFilter(rows, FILTER_CONFIG)
  const write = useCcuWrite(trpc)
  const [deleting, setDeleting] = useState<CcuDeviceRow | null>(null)

  const removeDevice = async (device: CcuDeviceRow, draft: DeleteDraft): Promise<void> => {
    const done = await write({
      action: 'deleteCcuDevice',
      input: { integrationId, address: device.address, reset: draft.reset, force: draft.force },
      schema: OkResultSchema,
      title: t('devices.deleteTitle'),
      message: t(draft.reset ? 'devices.deleteMessageReset' : 'devices.deleteMessage', {
        name: device.name ?? device.address,
      }),
      confirmLabel: t('devices.deleteConfirm'),
      variant: 'danger',
    })
    if (done !== null) {
      setDeleting(null)
      devices.reload()
    }
  }

  const columns = useMemo<readonly DataColumn<CcuDeviceRow>[]>(
    () => [
      {
        key: 'name',
        header: t('devices.colDevice'),
        render: (row) => (
          <div className="flex flex-col">
            <span className="text-foreground">{row.name ?? row.address}</span>
            {row.name !== null && (
              <span className="text-xs text-foreground-subtle">{row.address}</span>
            )}
          </div>
        ),
        sortValue: (row) => row.name ?? row.address,
      },
      {
        key: 'type',
        header: t('devices.colType'),
        render: (row) => row.type,
        sortValue: (row) => row.type,
      },
      {
        key: 'place',
        header: t('devices.colPlace'),
        nowrap: false,
        render: (row) => textOrDash([...row.rooms, ...row.functions].join(', ')),
        sortValue: (row) => row.rooms.join(', '),
      },
      {
        key: 'firmware',
        header: t('devices.colFirmware'),
        render: (row) => (
          <span className="flex items-center gap-1">
            {textOrDash(row.firmware)}
            {row.updatable === true && row.availableFirmware !== null && (
              <Badge variant="info">
                {t('devices.updateTo', { version: row.availableFirmware })}
              </Badge>
            )}
          </span>
        ),
        sortValue: (row) => row.firmware,
      },
      {
        key: 'signal',
        header: t('devices.colSignal'),
        align: 'right',
        render: signalText,
        sortValue: (row) => row.rssi,
      },
      {
        key: 'duty',
        header: t('devices.colDutyCycle'),
        align: 'right',
        render: (row) =>
          row.dutyCycleLimited === true ? (
            <Badge variant="warning">{t('devices.dutyLimited')}</Badge>
          ) : (
            percentOrDash(row.dutyCycle)
          ),
        sortValue: (row) => row.dutyCycle,
      },
      {
        key: 'health',
        header: t('devices.colHealth'),
        nowrap: false,
        notSortableReason: 'A set of flags, not one value',
        render: (row) => (
          <span className="flex flex-wrap gap-1">
            {row.unreach === true && <Badge variant="danger">{t('devices.unreach')}</Badge>}
            {row.sabotage === true && <Badge variant="danger">{t('devices.sabotage')}</Badge>}
            {row.lowBattery === true && <Badge variant="warning">{t('devices.lowBattery')}</Badge>}
            {row.configPending === true && (
              <Badge variant="info">{t('devices.configPending')}</Badge>
            )}
            {deviceIssue(row) === 'ok' && <Badge variant="success">{t('devices.ok')}</Badge>}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: 'Action column',
        render: (row) => (
          <KebabMenu
            items={[
              {
                id: 'delete',
                label: t('devices.deleteAction'),
                icon: Trash2,
                danger: true,
                onClick: () => setDeleting(row),
              },
            ]}
          />
        ),
      },
    ],
    [t],
  )

  if (devices.error !== null) {
    return (
      <ErrorBox title={t('devices.loadFailed')} message={devices.error} onRetry={devices.reload} />
    )
  }

  const groupLabel: Readonly<Record<string, string>> = {
    issue: t('devices.groupIssue'),
    type: t('devices.groupType'),
  }
  const issueLabel = (value: string): string =>
    value === 'unreach' ||
    value === 'sabotage' ||
    value === 'lowBattery' ||
    value === 'configPending' ||
    value === 'ok'
      ? t(`devices.${value}`)
      : value

  return (
    <div className="flex flex-col gap-3">
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        groups={filter.groups.map((group) => ({
          ...group,
          label: groupLabel[group.id] ?? group.id,
          ...(group.id === 'issue' ? { facetLabel: issueLabel } : {}),
        }))}
        labels={{
          searchPlaceholder: t('devices.searchPlaceholder'),
          searchLabel: t('devices.searchLabel'),
          facetsLabel: t('devices.facetsLabel'),
          clearLabel: t('devices.clearFilters'),
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onToggleGroupFacet={filter.toggleGroupFacet}
        onClear={filter.clear}
      />
      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(row) => row.address}
        minWidthPx={760}
        pageSize={25}
        emptyMessage={
          devices.loading
            ? t('common.loading')
            : filter.active
              ? t('devices.noMatch')
              : t('devices.none')
        }
      />
      {deleting !== null && (
        <DeleteDeviceDialog
          device={deleting}
          onClose={() => setDeleting(null)}
          onDelete={(draft) => removeDevice(deleting, draft)}
        />
      )}
    </div>
  )
}
