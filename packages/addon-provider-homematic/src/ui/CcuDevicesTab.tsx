import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  DataTable,
  DataTableFilterBar,
  ErrorBox,
  KebabMenu,
  useDataTableFilter,
  useUrlQueryParam,
  type AddonPageProps,
  type DataColumn,
  type DataTableFilterConfig,
  type KebabMenuItem,
} from '@camstack/ui-library'
import { ExternalLink, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react'
import {
  CcuDevicesResultSchema,
  CcuProgramsResultSchema,
  DeviceRenameResultSchema,
  NamedObjectSchema,
  OkResultSchema,
  type CcuChannelRow,
  type CcuDeviceRow,
  type CcuProgramsResult,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { percentOrDash, textOrDash } from './format.js'
import { ChannelConfigDialog } from './ChannelConfigDialog.js'
import { CcuDeviceDetail } from './CcuDeviceDetail.js'
import { camstackDevicePagePath, DEVICE_PARAM, resolveDeviceSelection } from './device-route.js'
import { deviceKeyEventState, EVENTS_LABEL, keyEventStatuses } from './key-event-programs.js'
import { centralKey } from './central-key.js'
import { DeleteDeviceDialog, type DeleteDraft } from './DeleteDeviceDialog.js'
import { RenameDeviceDialog, type DeviceRenameDraft } from './RenameDeviceDialog.js'
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

export { camstackDevicePagePath }

function deviceMenuPrefix(
  row: CcuDeviceRow,
  label: string,
  navigate: AddonPageProps['navigate'],
): readonly KebabMenuItem[] {
  const open = openDeviceItem(row, label, navigate)
  return open === null ? [] : [open]
}

function openDeviceItem(
  row: CcuDeviceRow,
  label: string,
  navigate: AddonPageProps['navigate'],
): KebabMenuItem | null {
  const deviceId = row.deviceId
  if (deviceId === null) return null
  const path = camstackDevicePagePath(deviceId)
  return {
    id: 'open-device',
    label,
    icon: ExternalLink,
    onClick: () => navigate(path),
  }
}

function DeviceName(props: {
  readonly row: CcuDeviceRow
  readonly navigate: AddonPageProps['navigate']
}) {
  const { row, navigate } = props
  const label = row.name ?? row.address
  const deviceId = row.deviceId
  const path = deviceId === null ? null : camstackDevicePagePath(deviceId)
  return (
    <div className="flex flex-col">
      {path === null ? (
        <span className="text-foreground">{label}</span>
      ) : (
        <a
          href={path}
          className="text-primary hover:underline"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            navigate(path)
          }}
        >
          {label}
        </a>
      )}
      {row.name !== null && <span className="text-xs text-foreground-subtle">{row.address}</span>}
    </div>
  )
}

/** "events: ok / missing program" for a device with keys; nothing for a device without. */
function EventsBadge(props: {
  readonly row: CcuDeviceRow
  readonly programs: {
    readonly data: CcuProgramsResult | undefined
    readonly error: string | null
  }
}) {
  const { row, programs } = props
  const { t } = useT()
  if (row.keyChannels.length === 0) return <span className="text-foreground-subtle">—</span>
  if (programs.data === undefined) {
    return programs.error === null ? (
      <span className="text-foreground-subtle">—</span>
    ) : (
      <Badge variant="info">{t('devices.eventsUnknown')}</Badge>
    )
  }
  const state = deviceKeyEventState(
    keyEventStatuses(
      row.keyChannels.map((channel) => channel.address),
      programs.data.programs,
      programs.data.keyReferencesUnreadable === true,
    ),
  )
  if (state === null) return <span className="text-foreground-subtle">—</span>
  return (
    <Badge variant={state === 'ok' ? 'success' : state === 'unknown' ? 'info' : 'warning'}>
      {t(EVENTS_LABEL[state])}
    </Badge>
  )
}

/** The CCU device list: identity, firmware and the health flags the WebUI buries in "Servicemeldungen". */
export function CcuDevicesTab(props: {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly navigate: AddonPageProps['navigate']
}) {
  const { trpc, integrationId, navigate } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const devices = useCcuData(trpc, 'listCcuDevices', input, CcuDevicesResultSchema)
  const rows = useMemo(() => devices.data?.devices ?? [], [devices.data])
  const filter = useDataTableFilter(rows, FILTER_CONFIG)
  const write = useCcuWrite(trpc)
  const [deleting, setDeleting] = useState<CcuDeviceRow | null>(null)
  const [configuring, setConfiguring] = useState<CcuDeviceRow | null>(null)
  const [deviceParam, setDeviceParam] = useUrlQueryParam(DEVICE_PARAM)
  const programs = useCcuData(trpc, 'listCcuPrograms', input, CcuProgramsResultSchema)
  const [renaming, setRenaming] = useState<CcuDeviceRow | null>(null)

  const renameDevice = async (device: CcuDeviceRow, draft: DeviceRenameDraft): Promise<void> => {
    const done = await write({
      action: 'renameCcuDevice',
      input: {
        integrationId,
        address: device.address,
        name: draft.name,
        renameChannels: draft.renameChannels,
      },
      schema: DeviceRenameResultSchema,
      title: t('rename.deviceTitle'),
      message: t(draft.renameChannels ? 'rename.deviceMessageChannels' : 'rename.deviceMessage', {
        from: device.name ?? device.address,
        to: draft.name.trim(),
      }),
      confirmLabel: t('rename.deviceConfirm'),
    })
    if (done !== null) {
      setRenaming(null)
      devices.reload()
    }
  }

  const renameChannel = async (channel: CcuChannelRow, name: string): Promise<void> => {
    const done = await write({
      action: 'renameCcuChannel',
      input: { integrationId, address: channel.address, name },
      schema: NamedObjectSchema,
      title: t('rename.channelTitle'),
      message: t('rename.channelMessage', {
        from: channel.name ?? channel.address,
        to: name.trim(),
      }),
      confirmLabel: t('rename.channelConfirm'),
    })
    if (done !== null) devices.reload()
  }

  const removeDevice = async (device: CcuDeviceRow, draft: DeleteDraft): Promise<void> => {
    const done = await write({
      action: 'deleteCcuDevice',
      input: {
        integrationId,
        address: device.address,
        reset: draft.reset,
        force: draft.force,
      },
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
        mobile: 'primary',
        key: 'name',
        header: t('devices.colDevice'),
        render: (row) => <DeviceName row={row} navigate={navigate} />,
        sortValue: (row) => row.name ?? row.address,
      },
      {
        mobile: 'detail',
        key: 'type',
        header: t('devices.colType'),
        render: (row) => row.type,
        sortValue: (row) => row.type,
      },
      {
        mobile: 'detail',
        key: 'place',
        header: t('devices.colPlace'),
        nowrap: false,
        render: (row) => textOrDash([...row.rooms, ...row.functions].join(', ')),
        sortValue: (row) => row.rooms.join(', '),
      },
      {
        mobile: 'hidden',
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
        mobile: 'hidden',
        key: 'signal',
        header: t('devices.colSignal'),
        align: 'right',
        render: signalText,
        sortValue: (row) => row.rssi,
      },
      {
        mobile: 'hidden',
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
        mobile: 'keep',
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
            {row.keyChannels.map((channel) => (
              <Badge
                key={channel.address}
                variant={channel.central === 'on' ? 'success' : 'warning'}
              >
                {t('devices.buttonEventsBadge', {
                  index: channel.index,
                  state: t(centralKey(channel.central)),
                })}
              </Badge>
            ))}
          </span>
        ),
      },
      {
        mobile: 'hidden',
        key: 'events',
        header: t('devices.colEvents'),
        nowrap: false,
        notSortableReason: 'Needs the programs list',
        render: (row) => <EventsBadge row={row} programs={programs} />,
      },
      {
        mobile: 'keep',
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: 'Action column',
        render: (row) => (
          <span onClick={(event) => event.stopPropagation()}>
            <KebabMenu
              items={[
                ...deviceMenuPrefix(row, t('devices.openDevicePage'), navigate),
                {
                  id: 'rename',
                  label: t('devices.renameAction'),
                  icon: Pencil,
                  onClick: () => setRenaming(row),
                },
                {
                  id: 'configure',
                  label: t('devices.configureAction'),
                  icon: SlidersHorizontal,
                  onClick: () => setConfiguring(row),
                },
                {
                  id: 'delete',
                  label: t('devices.deleteAction'),
                  icon: Trash2,
                  danger: true,
                  onClick: () => setDeleting(row),
                },
              ]}
            />
          </span>
        ),
      },
    ],
    [navigate, t, programs],
  )

  if (devices.error !== null) {
    return (
      <ErrorBox title={t('devices.loadFailed')} message={devices.error} onRetry={devices.reload} />
    )
  }

  const selection = resolveDeviceSelection(deviceParam, devices.data?.devices)
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
      {selection.kind === 'pending' && <Skeleton className="h-32 w-full" />}
      {selection.kind === 'missing' && (
        <EmptyState
          title={t('detail.notFoundTitle')}
          description={t('detail.notFound', { address: selection.address })}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => setDeviceParam(null)}>
              {t('detail.back')}
            </Button>
          }
        />
      )}
      {selection.kind === 'found' && (
        <CcuDeviceDetail
          trpc={trpc}
          integrationId={integrationId}
          device={selection.device}
          programs={{ data: programs.data, error: programs.error }}
          navigate={navigate}
          onBack={() => setDeviceParam(null)}
          onChanged={() => {
            devices.reload()
            programs.reload()
          }}
        />
      )}
      <div className={selection.kind === 'none' ? 'flex flex-col gap-3' : 'hidden'}>
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
          onRowClick={(row) => setDeviceParam(row.address)}
          emptyMessage={
            devices.loading
              ? t('common.loading')
              : filter.active
                ? t('devices.noMatch')
                : t('devices.none')
          }
        />
      </div>
      {configuring !== null && (
        <ChannelConfigDialog
          trpc={trpc}
          integrationId={integrationId}
          device={configuring}
          onClose={() => setConfiguring(null)}
        />
      )}
      {renaming !== null && (
        <RenameDeviceDialog
          device={renaming}
          onClose={() => setRenaming(null)}
          onRenameDevice={(draft) => renameDevice(renaming, draft)}
          onRenameChannel={renameChannel}
        />
      )}
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
