import { Badge, Button, ItemFormDialog, useConfirm } from '@camstack/ui-library'
import { MousePointerClick } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  OkResultSchema,
  type CcuDeviceRow,
  type KeyChannelLink,
  type KeyDirectLink,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import { callCcuAction, type CcuTrpc } from './ccu-client.js'
import { centralKey } from './central-key.js'

/** A linked channel by its CCU name, the address beside it. */
export function directLinkLabel(link: KeyDirectLink): string {
  const name = link.receiverName ?? link.receiverDeviceName
  return name === null ? link.receiver : `${name} (${link.receiver})`
}

type ChannelWrite =
  | { readonly kind: 'busy' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * Per key channel: whether the CCU sends presses, the channels it actuates
 * through direct links, and the central-link toggle. Enabling or disabling
 * stays in this dialog; the row shows busy, then saved or the error.
 */
export function ButtonEventsDialog(props: {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly device: CcuDeviceRow
  readonly onClose: () => void
  readonly onChanged: () => void
}): ReactNode {
  const { trpc, integrationId, device, onClose, onChanged } = props
  const { t } = useT()
  const confirm = useConfirm()
  const [writes, setWrites] = useState<Readonly<Record<string, ChannelWrite>>>({})

  const toggle = async (channel: KeyChannelLink): Promise<void> => {
    const enable = channel.central !== 'on'
    const name = channel.name ?? `${device.name ?? device.address} ch${channel.index}`
    const agreed = await confirm({
      title: t(enable ? 'devices.enableButtonEvents' : 'devices.disableButtonEvents'),
      message: t(
        enable ? 'devices.enableButtonEventsMessage' : 'devices.disableButtonEventsMessage',
        { name },
      ),
      confirmLabel: t(enable ? 'devices.enableButtonEvents' : 'devices.disableButtonEvents'),
    })
    if (!agreed) return
    setWrites((prev) => ({ ...prev, [channel.address]: { kind: 'busy' } }))
    try {
      await callCcuAction(
        trpc,
        'setButtonEvents',
        { integrationId, address: channel.address, enabled: enable, confirmed: true },
        OkResultSchema,
      )
      setWrites((prev) => ({ ...prev, [channel.address]: { kind: 'saved' } }))
      onChanged()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setWrites((prev) => ({ ...prev, [channel.address]: { kind: 'error', message } }))
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={MousePointerClick}
      width="md"
      title={t('devices.buttonEventsTitle', { name: device.name ?? device.address })}
      testId="hm-button-events-dialog"
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-foreground-subtle">{t('devices.buttonEventsHint')}</p>
        {device.keyChannels.map((channel) => (
          <KeyChannelRow
            key={channel.address}
            channel={channel}
            write={writes[channel.address]}
            onToggle={() => void toggle(channel)}
          />
        ))}
      </div>
    </ItemFormDialog>
  )
}

function KeyChannelRow(props: {
  readonly channel: KeyChannelLink
  readonly write: ChannelWrite | undefined
  readonly onToggle: () => void
}): ReactNode {
  const { channel, write, onToggle } = props
  const { t } = useT()
  return (
    <div className="flex items-center justify-between gap-3" aria-busy={write?.kind === 'busy'}>
      <div className="flex flex-col">
        <span className="text-sm text-foreground">
          {channel.name ?? t('devices.buttonChannel', { index: channel.index })}
        </span>
        <span className="text-xs text-foreground-subtle">
          {t('devices.buttonEventsStatus', { state: t(centralKey(channel.central)) })}
        </span>
        {channel.central !== 'unknown' && (
          <span className="text-xs text-foreground-subtle">
            {channel.links.length === 0
              ? t('devices.directLinksNone')
              : t('devices.directLinks', {
                  targets: channel.links.map(directLinkLabel).join(', '),
                })}
          </span>
        )}
      </div>
      <div className="flex flex-col items-end gap-1">
        <ChannelWriteLabel write={write} />
        {channel.central === 'on' || channel.central === 'off' ? (
          <Button
            type="button"
            variant={channel.central === 'on' ? 'secondary' : 'primary'}
            disabled={write?.kind === 'busy'}
            onClick={onToggle}
          >
            {t(
              channel.central === 'on'
                ? 'devices.disableButtonEvents'
                : 'devices.enableButtonEvents',
            )}
          </Button>
        ) : (
          <Badge variant="info">{t(centralKey(channel.central))}</Badge>
        )}
      </div>
    </div>
  )
}

function ChannelWriteLabel(props: { readonly write: ChannelWrite | undefined }): ReactNode {
  const { write } = props
  const { t } = useT()
  if (write === undefined) return null
  if (write.kind === 'busy') {
    return <span className="text-xs text-foreground-subtle">{t('devices.buttonEventsSaving')}</span>
  }
  if (write.kind === 'saved') {
    return <span className="text-xs text-success">{t('devices.buttonEventsSaved')}</span>
  }
  return <span className="text-xs text-danger">{write.message}</span>
}
