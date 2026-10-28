/**
 * The delivery options of a rule — one control per parameter a SELECTED
 * notifier declares (D938). Renders nothing when no selected notifier declares
 * any, so a rule that only addresses phones never sees it.
 */
import type { DeliveryParam, DeliveryParamValue } from '@camstack/types'
import { FormField, Input, Select, Switch } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

export interface NotificationRuleDeliveryOptionsProps {
  readonly params: readonly DeliveryParam[]
  readonly valueOf: (key: string) => unknown
  readonly onChange: (key: string, value: DeliveryParamValue | undefined) => void
}

interface ParamControlProps {
  readonly param: DeliveryParam
  readonly value: unknown
  readonly onChange: (value: DeliveryParamValue | undefined) => void
}

function ParamControl({ param, value, onChange }: ParamControlProps) {
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

export function NotificationRuleDeliveryOptions({
  params,
  valueOf,
  onChange,
}: NotificationRuleDeliveryOptionsProps) {
  const { t } = useTranslation()
  if (params.length === 0) return null
  return (
    <div className="flex flex-col gap-3" data-testid="rule-delivery-options">
      <p className="text-sm font-medium text-foreground">
        {t('system.notificationRules.deliveryOptions.title', 'Delivery options')}
      </p>
      {params.map((param) => (
        <FormField key={param.key} label={param.label}>
          <ParamControl
            param={param}
            value={valueOf(param.key)}
            onChange={(next) => onChange(param.key, next)}
          />
        </FormField>
      ))}
    </div>
  )
}
