import { useMemo, useState } from 'react'
import { Button, ErrorBox, FormField, ItemFormDialog, Select } from '@camstack/ui-library'
import { SlidersHorizontal } from 'lucide-react'
import {
  DeviceConfigSchema,
  OkResultSchema,
  type ConfigValue,
  type CcuDeviceRow,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { ParamField, parseEdit } from './ParamField.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

/** Edit the MASTER parameters of one device channel; only the changed ones are sent, after the operator confirms. */
export function ChannelConfigDialog(props: {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly device: Pick<CcuDeviceRow, 'address' | 'name'>
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
