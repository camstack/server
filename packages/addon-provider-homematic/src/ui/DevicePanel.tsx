import { useMemo, useState } from 'react'
import { Badge, Button, DataTable, ErrorBox, type DataColumn } from '@camstack/ui-library'
import { RefreshCw, SlidersHorizontal } from 'lucide-react'
import {
  CcuDeviceStateSchema,
  OkResultSchema,
  type CcuDeviceState,
  type ChannelValues,
  type ConfigValue,
  type ValueParam,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { ChannelConfigDialog } from './ChannelConfigDialog.js'
import { SetValueDialog } from './SetValueDialog.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'
import { asEditable, valueText } from './value-format.js'

export interface DevicePanelProps {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly address: string
  /** The CamStack device the panel sits on, carried into the write's log line. */
  readonly deviceId?: number
}

type Dialog =
  | { readonly kind: 'closed' }
  | { readonly kind: 'configure' }
  | { readonly kind: 'set'; readonly channel: ChannelValues; readonly param: ValueParam }

function channelLabel(channel: ChannelValues): string {
  return channel.name ?? `${channel.type ?? channel.address} · ${channel.index}`
}

function Diagnostics(props: { readonly state: CcuDeviceState }) {
  const { diagnostics, firmware } = props.state
  const { t } = useT()
  const rssi = (value: number | null): string => (value === null ? '—' : String(value))
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="hm-panel-diagnostics">
      {diagnostics.unreach !== null && (
        <Badge variant={diagnostics.unreach ? 'danger' : 'success'}>
          {diagnostics.unreach ? t('panel.unreachable') : t('panel.reachable')}
        </Badge>
      )}
      {diagnostics.lowBattery === true && <Badge variant="warning">{t('panel.lowBattery')}</Badge>}
      {diagnostics.configPending === true && (
        <Badge variant="info">{t('panel.configPending')}</Badge>
      )}
      {diagnostics.dutyCycle === true && (
        <Badge variant="warning">{t('panel.dutyCycleReached')}</Badge>
      )}
      {typeof diagnostics.dutyCycle === 'number' && (
        <Badge>{t('panel.dutyCycle', { value: diagnostics.dutyCycle })}</Badge>
      )}
      {(diagnostics.rssiDevice !== null || diagnostics.rssiPeer !== null) && (
        <Badge>
          {t('panel.rssi', {
            device: rssi(diagnostics.rssiDevice),
            peer: rssi(diagnostics.rssiPeer),
          })}
        </Badge>
      )}
      {firmware.installed !== null && (
        <Badge>{t('panel.firmware', { version: firmware.installed })}</Badge>
      )}
      {firmware.available !== null && firmware.available !== firmware.installed && (
        <Badge variant="info">{t('panel.firmwareUpdate', { version: firmware.available })}</Badge>
      )}
    </div>
  )
}

/**
 * One CCU device on its CamStack device page: the maintenance readings, every
 * channel's VALUES, a manual write of each writable one (switch, level, key
 * press …) and the MASTER configuration. Every write asks the operator first.
 */
export function DevicePanel(props: DevicePanelProps) {
  const { trpc, integrationId, address, deviceId } = props
  const { t } = useT()
  const input = useMemo(() => ({ integrationId, address }), [integrationId, address])
  const state = useCcuData(trpc, 'getCcuDeviceState', input, CcuDeviceStateSchema)
  const write = useCcuWrite(trpc)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'closed' })

  const send = async (
    channel: ChannelValues,
    param: ValueParam,
    value: ConfigValue,
  ): Promise<boolean> => {
    const press = param.type === 'ACTION'
    const shown = asEditable({ ...param, value }).value
    const done = await write({
      action: 'setCcuValue',
      input: {
        integrationId,
        channel: channel.address,
        parameter: param.parameter,
        value,
        ...(deviceId === undefined ? {} : { deviceId }),
      },
      schema: OkResultSchema,
      title: t('panel.writeTitle'),
      message: press
        ? t('panel.pressMessage', { parameter: param.parameter, channel: channelLabel(channel) })
        : t('panel.writeMessage', {
            parameter: param.parameter,
            channel: channelLabel(channel),
            value: String(shown),
          }),
      confirmLabel: t('panel.writeConfirm'),
      variant: 'warning',
    })
    if (done === null) return false
    state.reload()
    return true
  }

  const actionCell = (channel: ChannelValues, param: ValueParam) => {
    if (!param.writable) return null
    if (param.type === 'ACTION') {
      return (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void send(channel, param, true)}
        >
          {t('panel.press')}
        </Button>
      )
    }
    if (param.type === 'BOOL') {
      const next = param.value !== true
      return (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void send(channel, param, next)}
        >
          {next ? t('panel.turnOn') : t('panel.turnOff')}
        </Button>
      )
    }
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setDialog({ kind: 'set', channel, param })}
      >
        {t('panel.setAction')}
      </Button>
    )
  }

  const valueCell = (param: ValueParam) => {
    if (param.readable && typeof param.value === 'boolean') {
      return (
        <Badge variant={param.value ? 'success' : 'default'}>
          {param.value ? t('panel.yes') : t('panel.no')}
        </Badge>
      )
    }
    return <span className="text-sm text-foreground">{valueText(param) ?? '—'}</span>
  }

  const columnsFor = (channel: ChannelValues): readonly DataColumn<ValueParam>[] => [
    {
      key: 'parameter',
      header: t('panel.colParameter'),
      render: (row) => <span className="font-mono text-xs text-foreground">{row.parameter}</span>,
      sortValue: (row) => row.parameter,
    },
    {
      key: 'value',
      header: t('panel.colValue'),
      render: valueCell,
      notSortableReason: 'Mixed value types',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: 'Action column',
      render: (row) => actionCell(channel, row),
    },
  ]

  if (state.error !== null) {
    return <ErrorBox title={t('panel.loadFailed')} message={state.error} onRetry={state.reload} />
  }
  const data = state.data
  if (data === undefined) {
    return <p className="text-sm text-foreground-subtle">{t('common.loading')}</p>
  }
  return (
    <div className="flex flex-col gap-3" data-testid="hm-device-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-foreground-muted">
          {data.type} · {data.address}
        </span>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={state.reload}>
            <RefreshCw className="h-4 w-4" />
            {t('panel.reload')}
          </Button>
          <Button type="button" size="sm" onClick={() => setDialog({ kind: 'configure' })}>
            <SlidersHorizontal className="h-4 w-4" />
            {t('panel.configure')}
          </Button>
        </div>
      </div>
      <Diagnostics state={data} />
      {data.channels
        .filter((channel) => channel.values.length > 0)
        .map((channel) => (
          <div key={channel.address} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground-muted">
              {channel.index === 0 ? t('panel.maintenance') : channelLabel(channel)} ·{' '}
              {channel.address}
            </span>
            <DataTable
              columns={columnsFor(channel)}
              rows={channel.values}
              rowKey={(row) => row.parameter}
              minWidthPx={280}
              emptyMessage={t('panel.none')}
            />
          </div>
        ))}
      {dialog.kind === 'configure' && (
        <ChannelConfigDialog
          trpc={trpc}
          integrationId={integrationId}
          device={{ address: data.address, name: data.name }}
          onClose={() => setDialog({ kind: 'closed' })}
        />
      )}
      {dialog.kind === 'set' && (
        <SetValueDialog
          param={dialog.param}
          channelLabel={channelLabel(dialog.channel)}
          onClose={() => setDialog({ kind: 'closed' })}
          onSet={async (value) => {
            if (await send(dialog.channel, dialog.param, value)) setDialog({ kind: 'closed' })
          }}
        />
      )}
    </div>
  )
}
