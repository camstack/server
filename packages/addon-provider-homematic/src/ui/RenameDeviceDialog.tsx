import { useState } from 'react'
import { Button, Checkbox, FormField, Input, ItemFormDialog } from '@camstack/ui-library'
import { Pencil } from 'lucide-react'
import type { CcuChannelRow, CcuDeviceRow } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'

export interface DeviceRenameDraft {
  readonly name: string
  readonly renameChannels: boolean
}

export interface RenameDeviceDialogProps {
  readonly device: CcuDeviceRow
  readonly onClose: () => void
  /** Hands the draft to the caller, which asks the operator before the CCU write. */
  readonly onRenameDevice: (draft: DeviceRenameDraft) => Promise<void>
  readonly onRenameChannel: (channel: CcuChannelRow, name: string) => Promise<void>
}

function ChannelRenameRow(props: {
  readonly channel: CcuChannelRow
  readonly onRename: (channel: CcuChannelRow, name: string) => Promise<void>
}) {
  const { channel, onRename } = props
  const { t } = useT()
  const [name, setName] = useState(channel.name ?? '')
  const [busy, setBusy] = useState(false)
  const changed = name.trim() !== '' && name.trim() !== (channel.name ?? '')

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      await onRename(channel, name)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-xs text-foreground-subtle">:{channel.index}</span>
      <Input
        aria-label={t('rename.channelName', { index: channel.index })}
        value={name}
        placeholder={channel.type ?? ''}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={!changed || busy}
        onClick={() => void run()}
      >
        {t('rename.channelSave')}
      </Button>
    </li>
  )
}

/** Rename a device on the CCU (optionally its channels to `<name>:<index>`), or one channel at a time. */
export function RenameDeviceDialog(props: RenameDeviceDialogProps) {
  const { device, onClose, onRenameDevice, onRenameChannel } = props
  const { t } = useT()
  const [name, setName] = useState(device.name ?? '')
  const [renameChannels, setRenameChannels] = useState(false)
  const [busy, setBusy] = useState(false)
  const canSave = name.trim() !== '' && !busy

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      await onRenameDevice({ name, renameChannels })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={Pencil}
      width="md"
      title={t('rename.title', { name: device.name ?? device.address })}
      testId="hm-rename-dialog"
      footer={
        <Button type="button" onClick={() => void run()} disabled={!canSave}>
          {t('rename.deviceSave')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label={t('rename.deviceName')} required>
          <Input
            aria-label={t('rename.deviceName')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </FormField>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox checked={renameChannels} onChange={() => setRenameChannels(!renameChannels)} />
          <span>{t('rename.renameChannels')}</span>
        </label>
        {device.channels.length > 0 && (
          <FormField label={t('rename.channels')} description={t('rename.channelsHint')}>
            <ul className="flex flex-col gap-2">
              {device.channels.map((channel) => (
                <ChannelRenameRow
                  key={channel.address}
                  channel={channel}
                  onRename={onRenameChannel}
                />
              ))}
            </ul>
          </FormField>
        )}
      </div>
    </ItemFormDialog>
  )
}
