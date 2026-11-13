import { Checkbox, FormField, Input, Select } from '@camstack/ui-library'
import type { ConfigParam, ConfigValue } from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'

/** The value an edit field holds, turned back into what the CCU takes; `undefined` = not a valid value yet. */
export function parseEdit(param: ConfigParam, raw: string | boolean): ConfigValue | undefined {
  if (typeof raw === 'boolean') return raw
  if (param.type === 'INTEGER' || param.type === 'FLOAT') {
    if (raw.trim() === '') return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return raw
}

export function ParamField(props: {
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
