import { useState } from 'react'
import { Button, Checkbox, FormField, ItemFormDialog } from '@camstack/ui-library'
import { Trash2 } from 'lucide-react'
import type { CcuDeviceRow } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'

export interface DeleteDraft {
  readonly reset: boolean
  readonly force: boolean
}

/** Pick how a device leaves the CCU; the caller then asks the operator to confirm. */
export function DeleteDeviceDialog(props: {
  readonly device: CcuDeviceRow
  readonly onClose: () => void
  readonly onDelete: (draft: DeleteDraft) => Promise<void>
}) {
  const { device, onClose, onDelete } = props
  const { t } = useT()
  const [reset, setReset] = useState(false)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      await onDelete({ reset, force })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={Trash2}
      width="md"
      title={t('devices.deleteDialogTitle', { name: device.name ?? device.address })}
      testId="hm-delete-device-dialog"
      footer={
        <Button type="button" variant="danger" onClick={() => void run()} disabled={busy}>
          {t('devices.deleteContinue')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label={t('devices.deleteResetLabel')} description={t('devices.deleteResetHint')}>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox checked={reset} onChange={() => setReset(!reset)} />
            <span>{t('devices.deleteResetOption')}</span>
          </label>
        </FormField>
        <FormField label={t('devices.deleteForceLabel')} description={t('devices.deleteForceHint')}>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox checked={force} onChange={() => setForce(!force)} />
            <span>{t('devices.deleteForceOption')}</span>
          </label>
        </FormField>
      </div>
    </ItemFormDialog>
  )
}
