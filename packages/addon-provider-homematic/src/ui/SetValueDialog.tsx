import { useState } from 'react'
import { Button, ItemFormDialog } from '@camstack/ui-library'
import { Send } from 'lucide-react'
import type { ConfigValue, ValueParam } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import { ParamField } from './ParamField.js'
import { asEditable, parseValueEdit } from './value-format.js'

export interface SetValueDialogProps {
  readonly param: ValueParam
  readonly channelLabel: string
  readonly onClose: () => void
  /** Called with the parsed value; the caller asks for the confirmation and writes. */
  readonly onSet: (value: ConfigValue) => Promise<void>
}

/** Type one VALUES parameter's new value, shaped by its description (range, unit, enum). */
export function SetValueDialog(props: SetValueDialogProps) {
  const { param, channelLabel, onClose, onSet } = props
  const { t } = useT()
  const [edit, setEdit] = useState<string | boolean | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const parsed = edit === undefined ? undefined : parseValueEdit(param, edit)

  const submit = async (): Promise<void> => {
    if (parsed === undefined) return
    setBusy(true)
    try {
      await onSet(parsed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={Send}
      title={t('panel.setTitle', { parameter: param.parameter, channel: channelLabel })}
      testId="hm-set-value-dialog"
      footer={
        <Button type="button" onClick={() => void submit()} disabled={parsed === undefined || busy}>
          {t('panel.set')}
        </Button>
      }
    >
      <ParamField param={asEditable(param)} edit={edit} onEdit={setEdit} />
    </ItemFormDialog>
  )
}
