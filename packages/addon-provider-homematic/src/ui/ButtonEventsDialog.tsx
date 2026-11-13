import { Badge, Button, ItemFormDialog } from '@camstack/ui-library'
import { MousePointerClick } from 'lucide-react'
import { useState } from 'react'
import { OkResultSchema, type CcuDeviceRow, type KeyChannelLink } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { centralKey } from './central-key.js'
import { useCcuWrite } from './use-ccu-write.js'

/** Per key channel: whether the CCU sends presses, and the central-link toggle. */
export function ButtonEventsDialog(props: {
  readonly trpc: CcuTrpc
  readonly integrationId: string
  readonly device: CcuDeviceRow
  readonly onClose: () => void
  readonly onChanged: () => void
}) {
  const { trpc, integrationId, device, onClose, onChanged } = props
  const { t } = useT()
  const write = useCcuWrite(trpc)
  const [busy, setBusy] = useState<string | null>(null)

  const toggle = async (channel: KeyChannelLink): Promise<void> => {
    const enable = channel.central !== 'on'
    setBusy(channel.address)
    try {
      const done = await write({
        action: 'setButtonEvents',
        input: { integrationId, address: channel.address, enabled: enable },
        schema: OkResultSchema,
        title: t(enable ? 'devices.enableButtonEvents' : 'devices.disableButtonEvents'),
        message: t(
          enable ? 'devices.enableButtonEventsMessage' : 'devices.disableButtonEventsMessage',
          {
            name: channel.name ?? `${device.name ?? device.address} ch${channel.index}`,
          },
        ),
        confirmLabel: t(enable ? 'devices.enableButtonEvents' : 'devices.disableButtonEvents'),
      })
      if (done !== null) onChanged()
    } finally {
      setBusy(null)
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
          <div key={channel.address} className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-sm text-foreground">
                {channel.name ?? t('devices.buttonChannel', { index: channel.index })}
              </span>
              <span className="text-xs text-foreground-subtle">
                {t('devices.buttonEventsStatus', { state: t(centralKey(channel.central)) })}
              </span>
            </div>
            {channel.central === 'on' || channel.central === 'off' ? (
              <Button
                type="button"
                variant={channel.central === 'on' ? 'secondary' : 'primary'}
                disabled={busy !== null}
                onClick={() => void toggle(channel)}
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
        ))}
      </div>
    </ItemFormDialog>
  )
}
