import { useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  ErrorBox,
  FormField,
  Input,
  ItemFormDialog,
  Select,
} from '@camstack/ui-library'
import { SlidersHorizontal } from 'lucide-react'
import {
  DeviceConfigSchema,
  OkResultSchema,
  type ConfigParam,
  type ConfigValue,
  type CcuDeviceRow,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

/** The value an edit field holds, turned back into what the CCU takes; `undefined` = not a valid value yet. */
function parseEdit(param: ConfigParam, raw: string | boolean): ConfigValue | undefined {
  if (typeof raw === 'boolean') return raw
  if (param.type === 'INTEGER' || param.type === 'FLOAT') {
    if (raw.trim() === '') return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return raw
}

function ParamField(props: {
  readonly param: ConfigParam
  readonly edit: string | boolean | undefined
  readonly onEdit: (value: string | boolean) => void
}) {
  const { param, edit, onEdit } = props
  const { t } = useT()
  const label = param.unit === null ? param.parameter : `${param.parameter} (${param.unit})`
  const hint =
    param.min !== null && param.max !== null
      ? t('config.range', { min: param.min, max: param.max })
      : undefined

  if (param.type === 'BOOL') {
    const checked = typeof edit === 'boolean' ? edit : param.value === true
    return (
      <FormField label={label}>
        <Checkbox checked={checked} disabled={!param.writable} onChange={() => onEdit(!checked)} />
      </FormField>
    )
  }
  if (param.type === 'ENUM' && param.valueList !== null) {
    const current =
      typeof edit === 'string' ? edit : typeof param.value === 'string' ? param.value : ''
    return (
      <FormField label={label}>
        <Select
          value={current}
          disabled={!param.writable}
          onChange={(event) => onEdit(event.target.value)}
          options={[
            ...(current === '' ? [{ value: '', label: t('config.unknown') }] : []),
            ...param.valueList.map((value) => ({ value, label: value })),
          ]}
        />
      </FormField>
    )
  }
  const numeric = param.type === 'INTEGER' || param.type === 'FLOAT'
  const current = typeof edit === 'string' ? edit : param.value === null ? '' : String(param.value)
  return (
    <FormField label={label} {...(hint === undefined ? {} : { description: hint })}>
      <Input
        type={numeric ? 'number' : 'text'}
        value={current}
        disabled={!param.writable}
        {...(param.min !== null ? { min: param.min } : {})}
        {...(param.max !== null ? { max: param.max } : {})}
        onChange={(event) => onEdit(event.target.value)}
      />
    </FormField>
  )
}

/** Edit the MASTER parameters of one device channel; only the changed ones are sent, after the operator confirms. */
export function ChannelConfigDialog(props: {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly device: CcuDeviceRow
  readonly onClose: () => void
}) {
  const { trpc, integrationId, device, onClose } = props
  const { t } = useT()
  const write = useCcuWrite(trpc)
  const input = useMemo(
    () => ({ integrationId, address: device.address }),
    [integrationId, device.address],
  )
  const config = useCcuData(trpc, 'getCcuDeviceConfig', input, DeviceConfigSchema)
  const [picked, setPicked] = useState<string | null>(null)
  const [edits, setEdits] = useState<Readonly<Record<string, string | boolean>>>({})
  const [busy, setBusy] = useState(false)

  const channels = config.data?.channels ?? []
  const channel = channels.find((c) => c.channel === picked) ?? channels[0]

  const changes = useMemo(() => {
    const out: Record<string, ConfigValue> = {}
    for (const param of channel?.params ?? []) {
      const raw = edits[`${channel?.channel}/${param.parameter}`]
      if (raw === undefined) continue
      const value = parseEdit(param, raw)
      if (value !== undefined && value !== param.value) out[param.parameter] = value
    }
    return out
  }, [channel, edits])
  const changeCount = Object.keys(changes).length

  const save = async (): Promise<void> => {
    if (channel === undefined) return
    setBusy(true)
    try {
      const done = await write({
        action: 'setCcuChannelConfig',
        input: { integrationId, channel: channel.channel, values: changes },
        schema: OkResultSchema,
        title: t('config.confirmTitle'),
        message: t('config.confirmMessage', {
          channel: channel.channel,
          count: changeCount,
          names: Object.keys(changes).join(', '),
        }),
        confirmLabel: t('config.confirmLabel'),
        variant: 'warning',
      })
      if (done !== null) {
        setEdits({})
        config.reload()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={SlidersHorizontal}
      width="lg"
      title={t('config.title', { name: device.name ?? device.address })}
      testId="hm-config-dialog"
      footer={
        <Button type="button" onClick={() => void save()} disabled={changeCount === 0 || busy}>
          {t('config.save')}
        </Button>
      }
    >
      {config.error !== null ? (
        <ErrorBox title={t('config.loadFailed')} message={config.error} onRetry={config.reload} />
      ) : config.data === undefined ? (
        <p className="text-sm text-foreground-subtle">{t('common.loading')}</p>
      ) : channel === undefined ? (
        <p className="text-sm text-foreground-subtle">{t('config.none')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {channels.length > 1 && (
            <FormField label={t('config.channel')}>
              <Select
                value={channel.channel}
                onChange={(event) => {
                  setPicked(event.target.value)
                  setEdits({})
                }}
                options={channels.map((c) => ({
                  value: c.channel,
                  label: c.channelType === null ? c.channel : `${c.channel} · ${c.channelType}`,
                }))}
              />
            </FormField>
          )}
          {channel.error !== null && (
            <p className="text-xs text-danger">
              {t('config.valuesUnreadable', { error: channel.error })}
            </p>
          )}
          {channel.params.map((param) => (
            <ParamField
              key={param.parameter}
              param={param}
              edit={edits[`${channel.channel}/${param.parameter}`]}
              onEdit={(value) =>
                setEdits((prev) => ({ ...prev, [`${channel.channel}/${param.parameter}`]: value }))
              }
            />
          ))}
        </div>
      )}
    </ItemFormDialog>
  )
}
