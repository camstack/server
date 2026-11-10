/**
 * One control for one delivery parameter a notifier declares (D938), shown in
 * that target's own panel of the rule editor (`NotificationRuleTargetSettings`,
 * #487) — never written onto every selected target at once.
 */
import type { DeliveryParam, DeliveryParamValue } from '@camstack/types'
import { Input, Select, Switch } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

export interface ParamControlProps {
  readonly param: DeliveryParam
  readonly value: unknown
  readonly onChange: (value: DeliveryParamValue | undefined) => void
}

export function ParamControl({ param, value, onChange }: ParamControlProps) {
  const { t } = useTranslation()
  const placeholder = param.default === undefined ? undefined : String(param.default)
  if (param.type === 'enum') {
    return (
      <Select
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        options={[
          {
            value: '',
            label: t(
              'system.notificationRules.deliveryOptions.useDefault',
              'Use the target setting',
            ),
          },
          ...(param.options ?? []),
        ]}
      />
    )
  }
  if (param.type === 'boolean') {
    return (
      <Switch
        checked={value === true}
        onCheckedChange={(checked) => onChange(checked)}
        label={param.label}
      />
    )
  }
  return (
    <Input
      type={param.type === 'number' ? 'number' : 'text'}
      value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
      placeholder={placeholder}
      min={param.min}
      max={param.max}
      onChange={(event) => {
        const raw = event.target.value
        if (raw === '') return onChange(undefined)
        if (param.type === 'string') return onChange(raw)
        const parsed = Number(raw)
        onChange(Number.isFinite(parsed) ? parsed : undefined)
      }}
    />
  )
}
