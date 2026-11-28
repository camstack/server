/**
 * The API explorer's typed input form (planning#595): one control per top-level
 * field of the method's input schema — a device picker for a deviceId, a select
 * for an enum, a bounded number input, a switch for a boolean. The JSON editor
 * stays the source of truth; this form reads and writes the same value.
 */
import { DeviceValuePicker, Input, Select, Switch, Textarea } from '@dominevo/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isRecord } from '../../lib/api-explorer'
import { type InputControl, type InputField, withField } from '../../lib/api-input-fields'

export interface ApiInputFormProps {
  readonly fields: readonly InputField[]
  readonly value: Readonly<Record<string, unknown>>
  readonly onChange: (next: Record<string, unknown>) => void
}

export function ApiInputForm({ fields, value, onChange }: ApiInputFormProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      {fields.map((field) => {
        const id = `api-input-${field.key}`
        return (
          <div key={field.key} className="space-y-1">
            <label htmlFor={id} className="flex items-baseline gap-1.5 text-xs">
              <span className="font-mono font-medium text-foreground">{field.key}</span>
              {field.required && (
                <span className="text-foreground-subtle">
                  {t('system.apiExplorer.form.required')}
                </span>
              )}
            </label>
            <FieldControl
              id={id}
              field={field}
              current={value[field.key]}
              onChange={(next) => onChange(withField(value, field.key, next))}
            />
          </div>
        )
      })}
    </div>
  )
}

interface FieldControlProps {
  readonly id: string
  readonly field: InputField
  readonly current: unknown
  readonly onChange: (next: unknown) => void
}

function FieldControl({ id, field, current, onChange }: FieldControlProps): ReactNode {
  const control: InputControl = field.control
  const { t } = useTranslation()
  switch (control.type) {
    case 'device':
      return (
        <DeviceValuePicker
          id={id}
          pick="device"
          variant="inline"
          clearable={!field.required}
          recentKey="api-explorer"
          value={typeof current === 'number' ? { deviceId: current } : null}
          onChange={(picked) => onChange(picked === null ? undefined : picked.deviceId)}
        />
      )
    case 'deviceList':
      return (
        <DeviceValuePicker
          id={id}
          multiple
          pick="device"
          variant="inline"
          recentKey="api-explorer"
          value={(Array.isArray(current) ? current : []).flatMap((v) =>
            typeof v === 'number' ? [{ deviceId: v }] : [],
          )}
          onChange={(picked) => onChange(picked.map((p) => p.deviceId))}
        />
      )
    case 'select': {
      const options = control.options.map((o) => ({ value: String(o), label: String(o) }))
      return (
        <Select
          id={id}
          value={current === undefined ? '' : String(current)}
          options={
            field.required
              ? options
              : [{ value: '', label: t('system.apiExplorer.form.none') }, ...options]
          }
          onChange={(e) => {
            const picked = control.options.find((o) => String(o) === e.target.value)
            onChange(picked)
          }}
        />
      )
    }
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          inputMode={control.integer ? 'numeric' : 'decimal'}
          step={control.integer ? 1 : 'any'}
          min={control.min}
          max={control.max}
          value={typeof current === 'number' ? current : ''}
          onChange={(e) => {
            const raw = e.target.value
            onChange(raw === '' || Number.isNaN(Number(raw)) ? undefined : Number(raw))
          }}
        />
      )
    case 'switch':
      return (
        <Switch id={id} checked={current === true} onCheckedChange={onChange} label={field.key} />
      )
    case 'text':
      return (
        <Input
          id={id}
          value={typeof current === 'string' ? current : ''}
          onChange={(e) =>
            onChange(e.target.value === '' && !field.required ? undefined : e.target.value)
          }
        />
      )
    case 'json':
      return <JsonField id={id} current={current} onChange={onChange} />
  }
}

interface JsonFieldProps {
  readonly id: string
  readonly current: unknown
  readonly onChange: (next: unknown) => void
}

/** A nested value the form has no control for: a small JSON box that keeps its draft while invalid. */
function JsonField({ id, current, onChange }: JsonFieldProps): ReactNode {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(current === undefined ? '' : JSON.stringify(current))
  const [valid, setValid] = useState(true)
  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        rows={isRecord(current) ? 4 : 2}
        spellCheck={false}
        aria-label={t('system.apiExplorer.form.jsonField')}
        value={draft}
        state={valid ? 'default' : 'error'}
        className="font-mono text-xs"
        onChange={(e) => {
          const text = e.target.value
          setDraft(text)
          if (text.trim() === '') {
            setValid(true)
            onChange(undefined)
            return
          }
          try {
            const parsed: unknown = JSON.parse(text)
            setValid(true)
            onChange(parsed)
          } catch {
            setValid(false)
          }
        }}
      />
      {!valid && (
        <p className="text-xs text-danger">{t('system.apiExplorer.form.invalidJsonField')}</p>
      )}
    </div>
  )
}
