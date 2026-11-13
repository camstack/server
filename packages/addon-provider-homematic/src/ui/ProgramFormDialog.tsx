import { Button, Checkbox, FormField, ItemFormDialog, Select } from '@camstack/ui-library'
import { ListTree } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CcuProgram, ProgramKey } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'

export interface ProgramDraft {
  readonly deviceAddress: string
  readonly channelAddresses: readonly string[]
}

export interface ProgramFormDialogProps {
  /** `null` creates a program; a program edits the keys of its device. */
  readonly program: CcuProgram | null
  readonly keys: readonly ProgramKey[]
  readonly busy: boolean
  readonly error: string | null
  readonly onClose: () => void
  readonly onSave: (draft: ProgramDraft) => void
}

interface DeviceChoice {
  readonly address: string
  readonly label: string
  readonly keys: readonly ProgramKey[]
}

function deviceAddressOf(channelAddress: string): string {
  const idx = channelAddress.lastIndexOf(':')
  return idx === -1 ? channelAddress : channelAddress.slice(0, idx)
}

function choicesOf(keys: readonly ProgramKey[]): DeviceChoice[] {
  const grouped = new Map<string, ProgramKey[]>()
  for (const key of keys) {
    const list = grouped.get(key.deviceAddress) ?? []
    grouped.set(key.deviceAddress, [...list, key])
  }
  return [...grouped.entries()].map(([address, deviceKeys]) => ({
    address,
    label: deviceKeys[0]?.deviceName ?? address,
    keys: deviceKeys,
  }))
}

function keyLabel(key: ProgramKey): string {
  return key.name ?? key.address
}

/** Create or edit the one key-event program of a HmIP button: which keys, short and long press, no action. */
export function ProgramFormDialog(props: ProgramFormDialogProps) {
  const { program, keys, busy, error, onClose, onSave } = props
  const { t } = useT()
  const choices = useMemo(() => choicesOf(keys), [keys])
  const lockedAddress =
    program === null || program.channels[0] === undefined
      ? ''
      : deviceAddressOf(program.channels[0].address)
  const [deviceAddress, setDeviceAddress] = useState(
    lockedAddress !== '' ? lockedAddress : (choices[0]?.address ?? ''),
  )
  const initial = new Set(program?.channels.map((channel) => channel.address) ?? [])
  const [selected, setSelected] = useState<ReadonlySet<string>>(initial)
  const device = choices.find((choice) => choice.address === deviceAddress)
  const deviceKeys = device?.keys ?? []
  const picked = deviceKeys.filter((key) => selected.has(key.address)).map((key) => key.address)

  const toggle = (address: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={ListTree}
      width="md"
      title={program === null ? t('programs.formTitleNew') : t('programs.formTitleEdit')}
      testId="hm-program-dialog"
      footer={
        <Button
          type="button"
          disabled={picked.length === 0 || busy || deviceAddress === ''}
          onClick={() => onSave({ deviceAddress, channelAddresses: picked })}
        >
          {busy ? t('programs.saving') : t('programs.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-foreground-subtle">{t('programs.formHint')}</p>
        {program !== null && <p className="text-sm text-foreground">{program.name}</p>}
        <FormField label={t('programs.fieldDevice')}>
          <Select
            aria-label={t('programs.fieldDevice')}
            value={deviceAddress}
            disabled={program !== null}
            onChange={(event) => {
              setDeviceAddress(event.target.value)
              setSelected(new Set())
            }}
            options={[
              { value: '', label: t('programs.pickDevice') },
              ...choices.map((choice) => ({ value: choice.address, label: choice.label })),
            ]}
          />
        </FormField>
        <FormField label={t('programs.fieldKeys')} description={t('programs.fieldKeysHint')}>
          {deviceKeys.length === 0 ? (
            <p className="text-xs text-foreground-subtle">{t('programs.noKeys')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {deviceKeys.map((key) => (
                <li key={key.address}>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={selected.has(key.address)}
                      onChange={() => toggle(key.address)}
                    />
                    <span>{keyLabel(key)}</span>
                    <span className="text-xs text-foreground-subtle">{key.address}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </FormField>
        {error !== null && <p className="text-sm text-danger">{error}</p>}
      </div>
    </ItemFormDialog>
  )
}
