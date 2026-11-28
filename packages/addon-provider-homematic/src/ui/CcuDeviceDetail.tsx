import { useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  DataTable,
  ErrorBox,
  KeyValueList,
  SectionCard,
  Skeleton,
  type AddonPageProps,
  type DataColumn,
} from '@dominevo/ui-library'
import { ArrowLeft, ExternalLink, MousePointerClick, SlidersHorizontal } from 'lucide-react'
import {
  CcuDeviceStateSchema,
  CcuFaultsResultSchema,
  type CcuFaultsResult,
  CcuLinksResultSchema,
  HeatingOverviewSchema,
  OkResultSchema,
  ServiceMessagesResultSchema,
  type CcuDeviceRow,
  type CcuLink,
  type CcuProgramsResult,
  type ChannelValues,
  type HeatingGroup,
  type KeyChannelLink,
  type ServiceMessage,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import { ButtonEventsDialog, directLinkLabel } from './ButtonEventsDialog.js'
import { ChannelConfigDialog } from './ChannelConfigDialog.js'
import type { CcuTrpc } from './ccu-client.js'
import { centralKey } from './central-key.js'
import { belongsToDevice, camstackDevicePagePath, ccuInterfaceOf } from './device-route.js'
import { dateTimeOrDash, percentOrDash, textOrDash } from './format.js'
import { EVENTS_LABEL, keyEventStatuses, type KeyEventStatus } from './key-event-programs.js'
import { TableBlock } from './TableBlock.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

/** What the tab already knows about the programs: the answer, or why there is none. */
export interface ProgramsRead {
  readonly data: CcuProgramsResult | undefined
  readonly error: string | null
}

export interface CcuDeviceDetailProps {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly device: CcuDeviceRow
  readonly programs: ProgramsRead
  readonly navigate: AddonPageProps['navigate']
  readonly onBack: () => void
  /** A write changed what the list shows (a central link, a program). */
  readonly onChanged: () => void
}

function flag(value: boolean | null, yes: string, no: string, unknown: string): string {
  return value === null ? unknown : value ? yes : no
}

function channelLabel(channel: ChannelValues): string {
  return channel.name ?? `${channel.type ?? channel.address} · ${channel.index}`
}

/** One device, everything known about it: identity, live state, keys and events, configuration, groups, links, faults. */
export function CcuDeviceDetail(props: CcuDeviceDetailProps): ReactNode {
  const { trpc, integrationId, device, programs, navigate, onBack, onChanged } = props
  const { t } = useT()
  const input = useMemo(
    () => ({ integrationId, address: device.address }),
    [integrationId, device.address],
  )
  const list = useMemo(() => ({ integrationId }), [integrationId])
  const state = useCcuData(trpc, 'getCcuDeviceState', input, CcuDeviceStateSchema)
  const groups = useCcuData(trpc, 'listHeatingGroups', list, HeatingOverviewSchema)
  const links = useCcuData(trpc, 'listCcuLinks', list, CcuLinksResultSchema)
  const messages = useCcuData(trpc, 'listServiceMessages', list, ServiceMessagesResultSchema)
  const faults = useCcuData(trpc, 'listCcuFaults', list, CcuFaultsResultSchema)
  const [configuring, setConfiguring] = useState(false)
  const [centralOpen, setCentralOpen] = useState(false)

  const title = device.name ?? device.address
  const deviceId = device.deviceId
  return (
    <div className="flex flex-col gap-3" data-testid="hm-device-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('detail.back')}
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{title}</h2>
      </div>

      <SectionCard headingId="hm-detail-identity" title={t('detail.identityTitle')}>
        <div className="p-3">
          <KeyValueList
            items={[
              { key: t('detail.fieldName'), value: textOrDash(device.name) },
              { key: t('detail.fieldAddress'), value: device.address },
              { key: t('detail.fieldType'), value: device.type },
              {
                key: t('detail.fieldFirmware'),
                value: (
                  <span className="flex items-center gap-1">
                    {textOrDash(device.firmware)}
                    {device.updatable === true && device.availableFirmware !== null && (
                      <Badge variant="info">
                        {t('devices.updateTo', {
                          version: device.availableFirmware,
                        })}
                      </Badge>
                    )}
                  </span>
                ),
              },
              {
                key: t('detail.fieldInterface'),
                value: ccuInterfaceOf(device.type),
              },
              {
                key: t('detail.fieldRooms'),
                value: textOrDash(device.rooms.join(', ')),
              },
              {
                key: t('detail.fieldFunctions'),
                value: textOrDash(device.functions.join(', ')),
              },
              {
                key: t('detail.camstackDevice'),
                value:
                  deviceId === null ? (
                    t('detail.notAdopted')
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(camstackDevicePagePath(deviceId))}
                    >
                      <ExternalLink className="size-4" aria-hidden="true" />
                      {t('devices.openDevicePage')}
                    </Button>
                  ),
              },
            ]}
          />
        </div>
      </SectionCard>

      <LiveState device={device} state={state} />
      {device.keyChannels.length > 0 && (
        <ButtonEvents
          trpc={trpc}
          integrationId={integrationId}
          device={device}
          programs={programs}
          state={state.data?.channels ?? []}
          onManageCentral={() => setCentralOpen(true)}
          onChanged={() => {
            onChanged()
            state.reload()
          }}
        />
      )}

      <SectionCard
        headingId="hm-detail-config"
        title={t('detail.configTitle')}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => setConfiguring(true)}>
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {t('detail.configOpen')}
          </Button>
        }
      >
        <p className="p-3 text-sm text-foreground-subtle">{t('detail.configHint')}</p>
      </SectionCard>

      <GroupsBlock device={device} read={groups} groups={groups.data?.groups} />
      <LinksBlock device={device} read={links} links={links.data?.links} />
      <FaultsBlock device={device} faults={faults} messages={messages} />

      {configuring && (
        <ChannelConfigDialog
          trpc={trpc}
          integrationId={integrationId}
          device={device}
          onClose={() => setConfiguring(false)}
        />
      )}
      {centralOpen && (
        <ButtonEventsDialog
          trpc={trpc}
          integrationId={integrationId}
          device={device}
          onClose={() => setCentralOpen(false)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

interface ReadStatus {
  readonly error: string | null
  readonly loading: boolean
  readonly reload: () => void
}

function BlockError(props: { readonly title: string; readonly read: ReadStatus }): ReactNode {
  return (
    <ErrorBox
      variant="warning"
      title={props.title}
      message={props.read.error ?? ''}
      onRetry={props.read.reload}
    />
  )
}

function LiveState(props: {
  readonly device: CcuDeviceRow
  readonly state: ReadStatus & {
    readonly data: { readonly channels: readonly ChannelValues[] } | undefined
  }
}): ReactNode {
  const { device, state } = props
  const { t } = useT()
  const yes = t('detail.yes')
  const no = t('detail.no')
  const unknown = t('detail.unknown')
  const rows = (state.data?.channels ?? []).flatMap((channel) =>
    channel.values
      .filter((param) => param.readable)
      .map((param) => ({
        channel,
        param,
        key: `${channel.address}/${param.parameter}`,
      })),
  )
  const columns: readonly DataColumn<(typeof rows)[number]>[] = [
    {
      mobile: 'detail',
      key: 'channel',
      header: t('detail.colChannel'),
      render: (row) => channelLabel(row.channel),
      sortValue: (row) => row.channel.index,
    },
    {
      mobile: 'primary',
      key: 'parameter',
      header: t('detail.colParameter'),
      render: (row) => row.param.parameter,
      sortValue: (row) => row.param.parameter,
    },
    {
      mobile: 'keep',
      key: 'value',
      header: t('detail.colValue'),
      align: 'right',
      notSortableReason: 'Mixed value types',
      render: (row) =>
        row.param.value === null
          ? '—'
          : `${String(row.param.value)}${row.param.unit === null ? '' : ` ${row.param.unit}`}`,
    },
  ]
  return (
    <SectionCard headingId="hm-detail-state" title={t('detail.stateTitle')}>
      <div className="flex flex-col gap-3 p-3">
        <KeyValueList
          items={[
            {
              key: t('detail.fieldSignal'),
              value: device.rssi === null ? '—' : `${device.rssi} dBm`,
            },
            {
              key: t('detail.fieldDuty'),
              value:
                device.dutyCycleLimited === true
                  ? t('devices.dutyLimited')
                  : percentOrDash(device.dutyCycle),
            },
            {
              key: t('detail.fieldUnreach'),
              value: flag(device.unreach, yes, no, unknown),
            },
            {
              key: t('detail.fieldBattery'),
              value: flag(device.lowBattery, yes, no, unknown),
            },
            {
              key: t('detail.fieldConfigPending'),
              value: flag(device.configPending, yes, no, unknown),
            },
            ...device.keyChannels.map((channel) => ({
              key: `${t('detail.colCentral')} · ${channel.index}`,
              value: t(centralKey(channel.central)),
            })),
          ]}
        />
        {state.error !== null ? (
          <BlockError title={t('detail.stateUnavailable')} read={state} />
        ) : state.data === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.key}
            minWidthPx={420}
            pageSize={15}
            emptyMessage={t('detail.noValues')}
          />
        )}
      </div>
    </SectionCard>
  )
}

function ButtonEvents(props: {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly device: CcuDeviceRow
  readonly programs: ProgramsRead
  readonly state: readonly ChannelValues[]
  readonly onManageCentral: () => void
  readonly onChanged: () => void
}): ReactNode {
  const { trpc, integrationId, device, programs, state, onManageCentral, onChanged } = props
  const { t } = useT()
  const write = useCcuWrite(trpc)
  const statuses = useMemo(
    () =>
      programs.data === undefined
        ? undefined
        : keyEventStatuses(
            device.keyChannels.map((channel) => channel.address),
            programs.data.programs,
            programs.data.keyReferencesUnreadable === true,
          ),
    [programs.data, device.keyChannels],
  )
  const hmip = device.type.toUpperCase().startsWith('HMIP')

  const press = async (channelAddress: string, parameter: string): Promise<void> => {
    const channel = state.find((candidate) => candidate.address === channelAddress)
    const done = await write({
      action: 'setCcuValue',
      input: {
        integrationId,
        channel: channelAddress,
        parameter,
        value: true,
        ...(device.deviceId === null ? {} : { deviceId: device.deviceId }),
      },
      schema: OkResultSchema,
      title: t('panel.writeTitle'),
      message: t('panel.pressMessage', {
        parameter,
        channel: channel === undefined ? channelAddress : channelLabel(channel),
      }),
      confirmLabel: t('panel.writeConfirm'),
      variant: 'warning',
    })
    if (done !== null) onChanged()
  }

  const createProgram = async (): Promise<void> => {
    const done = await write({
      action: 'ensureCcuKeyEventProgram',
      input: {
        integrationId,
        deviceAddress: device.address,
        channelAddresses: device.keyChannels.map((channel) => channel.address),
      },
      schema: OkResultSchema,
      title: t('detail.createProgramTitle'),
      message: t('detail.createProgramMessage', {
        name: device.name ?? device.address,
      }),
      confirmLabel: t('detail.createProgramConfirm'),
    })
    if (done !== null) onChanged()
  }

  const missing = statuses?.some((status) => status.state !== 'ok') === true
  return (
    <SectionCard
      headingId="hm-detail-events"
      title={t('detail.eventsTitle')}
      icon={MousePointerClick}
      actions={
        <span className="flex flex-wrap gap-1">
          <Button type="button" variant="outline" size="sm" onClick={onManageCentral}>
            {t('detail.manageCentral')}
          </Button>
          {missing && hmip && (
            <Button type="button" size="sm" onClick={() => void createProgram()}>
              {t('detail.createProgram')}
            </Button>
          )}
        </span>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <p className="text-sm text-foreground-subtle">{t('detail.eventsHint')}</p>
        {programs.error !== null && (
          <ErrorBox
            variant="warning"
            title={t('detail.programsUnavailable')}
            message={programs.error}
          />
        )}
        {missing && !hmip && (
          <p className="text-xs text-foreground-subtle">{t('detail.createProgramUnavailable')}</p>
        )}
        {device.keyChannels.map((channel) => (
          <KeyRow
            key={channel.address}
            channel={channel}
            status={statuses?.find((status) => status.address === channel.address)}
            pressable={state
              .find((candidate) => candidate.address === channel.address)
              ?.values.filter((param) => param.type === 'ACTION' && param.writable)
              .map((param) => param.parameter)}
            onPress={(parameter) => void press(channel.address, parameter)}
          />
        ))}
      </div>
    </SectionCard>
  )
}

function KeyRow(props: {
  readonly channel: KeyChannelLink
  readonly status: KeyEventStatus | undefined
  readonly pressable: readonly string[] | undefined
  readonly onPress: (parameter: string) => void
}): ReactNode {
  const { channel, status, pressable, onPress } = props
  const { t } = useT()
  const label = channel.name ?? t('devices.buttonChannel', { index: channel.index })
  return (
    <div className="flex flex-col gap-1 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm text-foreground">{label}</span>
        <Badge variant={channel.central === 'on' ? 'success' : 'warning'}>
          {t(centralKey(channel.central))}
        </Badge>
        {status !== undefined && (
          <Badge
            variant={
              status.state === 'ok' ? 'success' : status.state === 'unknown' ? 'info' : 'warning'
            }
            data-testid={`hm-key-event-${status.state}`}
          >
            {t(EVENTS_LABEL[status.state])}
          </Badge>
        )}
      </div>
      {status !== undefined && status.state !== 'unknown' && (
        <span className="text-xs text-foreground-subtle">
          {status.state === 'missing'
            ? t('detail.programNone')
            : status.state === 'inactive'
              ? t('detail.programInactive', {
                  names: status.programs.join(', '),
                })
              : status.programs.join(', ')}
        </span>
      )}
      {channel.central !== 'unknown' && channel.links.length > 0 && (
        <span className="text-xs text-foreground-subtle">
          {t('devices.directLinks', {
            targets: channel.links.map(directLinkLabel).join(', '),
          })}
        </span>
      )}
      {pressable !== undefined && pressable.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {pressable.map((parameter) => (
            <Button
              key={parameter}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onPress(parameter)}
            >
              {parameter === 'PRESS_LONG' ? t('detail.pressLong') : t('detail.pressShort')}
            </Button>
          ))}
        </span>
      )}
    </div>
  )
}

function GroupsBlock(props: {
  readonly device: CcuDeviceRow
  readonly read: ReadStatus & {
    readonly data: { readonly groupsError: string | null } | undefined
  }
  readonly groups: readonly HeatingGroup[] | undefined
}): ReactNode {
  const { device, read, groups } = props
  const { t } = useT()
  const mine = (groups ?? []).filter(
    (group) =>
      belongsToDevice(group.deviceAddress, device.address) ||
      group.members.some((member) => belongsToDevice(member.address, device.address)),
  )
  return (
    <TableBlock headingId="hm-detail-groups" title={t('detail.groupsTitle')}>
      {read.error !== null ? (
        <BlockError title={t('detail.groupsUnavailable')} read={read} />
      ) : read.data?.groupsError ? (
        <ErrorBox
          variant="warning"
          title={t('detail.groupsUnavailable')}
          message={read.data.groupsError}
        />
      ) : groups === undefined ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <p className="text-sm text-foreground">
          {mine.length === 0
            ? t('detail.groupsNone')
            : mine.map((group) => `${group.name} (${group.typeLabel ?? group.type})`).join(', ')}
        </p>
      )}
    </TableBlock>
  )
}

function endpointLabel(endpoint: CcuLink['sender']): string {
  const name = endpoint.name ?? endpoint.deviceName
  return name === null ? endpoint.address : `${name} (${endpoint.address})`
}

function LinksBlock(props: {
  readonly device: CcuDeviceRow
  readonly read: ReadStatus
  readonly links: readonly CcuLink[] | undefined
}): ReactNode {
  const { device, read, links } = props
  const { t } = useT()
  const mine = (links ?? []).filter(
    (link) =>
      belongsToDevice(link.sender.address, device.address) ||
      belongsToDevice(link.receiver.address, device.address),
  )
  const columns: readonly DataColumn<CcuLink>[] = [
    {
      mobile: 'primary',
      key: 'sender',
      header: t('detail.colSender'),
      nowrap: false,
      render: (row) => endpointLabel(row.sender),
      sortValue: (row) => row.sender.address,
    },
    {
      mobile: 'detail',
      key: 'receiver',
      header: t('detail.colReceiver'),
      nowrap: false,
      render: (row) => endpointLabel(row.receiver),
      sortValue: (row) => row.receiver.address,
    },
  ]
  return (
    <TableBlock headingId="hm-detail-links" title={t('detail.linksTitle')}>
      {read.error !== null ? (
        <BlockError title={t('detail.linksUnavailable')} read={read} />
      ) : links === undefined ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <DataTable
          columns={columns}
          rows={mine}
          rowKey={(row) => `${row.sender.address}>${row.receiver.address}`}
          minWidthPx={420}
          emptyMessage={t('detail.linksNone')}
        />
      )}
    </TableBlock>
  )
}

function FaultsBlock(props: {
  readonly device: CcuDeviceRow
  readonly faults: ReadStatus & {
    readonly data: CcuFaultsResult | undefined
  }
  readonly messages: ReadStatus & {
    readonly data:
      | {
          readonly messages: readonly ServiceMessage[]
          readonly error: string | null
        }
      | undefined
  }
}): ReactNode {
  const { device, faults, messages } = props
  const { t } = useT()
  const own = (faults.data?.faults ?? []).find((row) => row.address === device.address)
  const ownMessages = (messages.data?.messages ?? []).filter((message) =>
    belongsToDevice(message.address, device.address),
  )
  const unreported = faults.data?.unreported.includes(device.address) === true
  const ready =
    faults.data !== undefined && messages.data !== undefined && messages.data.error === null
  return (
    <TableBlock headingId="hm-detail-faults" title={t('detail.faultsTitle')}>
      {faults.error !== null && <BlockError title={t('detail.faultsUnavailable')} read={faults} />}
      {messages.error !== null ? (
        <BlockError title={t('detail.messagesUnavailable')} read={messages} />
      ) : messages.data?.error ? (
        <ErrorBox
          variant="warning"
          title={t('detail.messagesUnavailable')}
          message={messages.data.error}
        />
      ) : null}
      {own !== undefined &&
        own.faults.map((fault) => (
          <div key={fault.code} className="flex items-center gap-2 text-sm">
            <Badge variant={fault.severity === 'error' ? 'danger' : 'warning'}>{fault.code}</Badge>
            <span className="text-foreground">{fault.label}</span>
          </div>
        ))}
      {ownMessages.map((message) => (
        <div key={message.id} className="flex items-center gap-2 text-sm">
          <Badge variant="warning">{textOrDash(message.type)}</Badge>
          <span className="text-foreground-subtle">{dateTimeOrDash(message.timestamp)}</span>
        </div>
      ))}
      {unreported && own === undefined && (
        <p className="text-sm text-foreground-subtle">{t('detail.faultsUnreported')}</p>
      )}
      {ready && !unreported && own === undefined && ownMessages.length === 0 && (
        <p className="text-sm text-foreground-subtle">{t('detail.faultsNone')}</p>
      )}
    </TableBlock>
  )
}
