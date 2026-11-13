/**
 * The Inputs panel of the automation template editor (#527): what the template
 * asks for, "Mark as input" to add one from a field of the body, and the edit
 * and remove controls of each. A group input is authored by the shipped
 * templates and shown read-only.
 */
import type { AutomationTemplatePayload, TemplateInput } from '@camstack/types'
import {
  Badge,
  Button,
  FormField,
  IconButton,
  Input,
  Select,
  Switch,
  Textarea,
} from '@camstack/ui-library'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type BindableField,
  bindableFields,
  keyFromLabel,
  markAsInput,
  markProblem,
  removeInput,
  replaceInput,
  uniqueInputKey,
} from './mark-as-input'
import { optionsFromText, optionsToText, patchInput } from './input-edit'
import { DurationValueInput } from './DurationValueInput'

export interface InputsPanelProps {
  readonly payload: AutomationTemplatePayload
  /** A built-in template: the panel lists the inputs and changes nothing. */
  readonly readOnly: boolean
  readonly onChange: (next: AutomationTemplatePayload) => void
}

export function InputsPanel({ payload, readOnly, onChange }: InputsPanelProps): ReactNode {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="space-y-3" data-testid="template-inputs-panel">
      {payload.inputs.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          {t(
            'build.templates.noInputs',
            'No inputs yet. Mark a field of the automation as an input to ask for it each time.',
          )}
        </p>
      ) : (
        <ul className="space-y-2">
          {payload.inputs.map((input) => (
            <li
              key={input.key}
              className="rounded-md border border-border bg-surface p-3"
              data-testid={`template-input-row-${input.key}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {input.label}
                </span>
                <Badge variant="neutral">{input.kind}</Badge>
                {input.optional === true && (
                  <Badge variant="neutral">{t('build.templates.optional', 'Optional')}</Badge>
                )}
                <code className="text-xs text-foreground-subtle">{input.key}</code>
                {input.kind === 'group' ? (
                  <span className="text-xs text-foreground-subtle">
                    {t(
                      'build.templates.groupReadOnly',
                      'Repeatable group — shipped templates only',
                    )}
                  </span>
                ) : (
                  !readOnly && (
                    <>
                      <IconButton
                        icon={Pencil}
                        size="sm"
                        variant="ghost"
                        aria-label={t('common.edit', 'Edit')}
                        onClick={() => setEditing(editing === input.key ? null : input.key)}
                        data-testid={`template-input-edit-${input.key}`}
                      />
                      <IconButton
                        icon={Trash2}
                        size="sm"
                        variant="ghost"
                        aria-label={t('common.delete', 'Delete')}
                        onClick={() => {
                          setEditing(null)
                          onChange(removeInput(payload, input.key))
                        }}
                        data-testid={`template-input-remove-${input.key}`}
                      />
                    </>
                  )
                )}
              </div>
              {input.kind === 'group' && (
                <ul className="mt-2 space-y-0.5 pl-3 text-xs text-foreground-muted">
                  {input.inputs.map((inner) => (
                    <li key={inner.key}>
                      {inner.label} <span className="text-foreground-subtle">({inner.kind})</span>
                    </li>
                  ))}
                </ul>
              )}
              {editing === input.key && input.kind !== 'group' && (
                <InputEditor
                  input={input}
                  deviceInputs={payload.inputs.filter((i) => i.kind === 'device')}
                  onChange={(next) => onChange(replaceInput(payload, input.key, next))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && <MarkAsInput payload={payload} onChange={onChange} />}
    </div>
  )
}

function numberOf(raw: string): number | undefined {
  if (raw === '') return undefined
  const parsed = Number(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

interface InputEditorProps {
  readonly input: Exclude<TemplateInput, { kind: 'group' }>
  readonly deviceInputs: readonly TemplateInput[]
  readonly onChange: (next: TemplateInput) => void
}

function InputEditor({ input, deviceInputs, onChange }: InputEditorProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div
      className="mt-3 grid gap-3 sm:grid-cols-2"
      data-testid={`template-input-editor-${input.key}`}
    >
      <FormField label={t('build.templates.label', 'Label')}>
        <Input
          value={input.label}
          maxLength={80}
          onChange={(e) => onChange(patchInput(input, { label: e.target.value }))}
          data-testid="template-input-label"
        />
      </FormField>
      <FormField label={t('build.templates.requiredField', 'Required')}>
        <Switch
          checked={input.optional !== true}
          onCheckedChange={(required) => onChange(patchInput(input, { optional: !required }))}
          label={t('build.templates.requiredField', 'Required')}
          data-testid="template-input-required"
        />
      </FormField>
      {(input.kind === 'number' || input.kind === 'duration') && (
        <>
          <FormField label={t('build.templates.min', 'Minimum')}>
            {input.kind === 'duration' ? (
              <span data-testid="template-input-min">
                <DurationValueInput
                  value={input.min}
                  aria-label={t('build.templates.min', 'Minimum')}
                  onChange={(seconds) => onChange(patchInput(input, { min: seconds }))}
                />
              </span>
            ) : (
              <Input
                type="number"
                value={input.min === undefined ? '' : String(input.min)}
                onChange={(e) => onChange(patchInput(input, { min: numberOf(e.target.value) }))}
                data-testid="template-input-min"
              />
            )}
          </FormField>
          <FormField label={t('build.templates.max', 'Maximum')}>
            {input.kind === 'duration' ? (
              <span data-testid="template-input-max">
                <DurationValueInput
                  value={input.max}
                  aria-label={t('build.templates.max', 'Maximum')}
                  onChange={(seconds) => onChange(patchInput(input, { max: seconds }))}
                />
              </span>
            ) : (
              <Input
                type="number"
                value={input.max === undefined ? '' : String(input.max)}
                onChange={(e) => onChange(patchInput(input, { max: numberOf(e.target.value) }))}
                data-testid="template-input-max"
              />
            )}
          </FormField>
          <FormField label={t('build.templates.default', 'Default')}>
            {input.kind === 'duration' ? (
              <span data-testid="template-input-default">
                <DurationValueInput
                  value={input.default}
                  aria-label={t('build.templates.default', 'Default')}
                  onChange={(seconds) => onChange(patchInput(input, { default: seconds }))}
                />
              </span>
            ) : (
              <Input
                type="number"
                value={input.default === undefined ? '' : String(input.default)}
                onChange={(e) => onChange(patchInput(input, { default: numberOf(e.target.value) }))}
                data-testid="template-input-default"
              />
            )}
          </FormField>
        </>
      )}
      {input.kind === 'text' && (
        <FormField label={t('build.templates.default', 'Default')}>
          <Input
            value={input.default ?? ''}
            onChange={(e) =>
              onChange(
                patchInput(input, { default: e.target.value === '' ? undefined : e.target.value }),
              )
            }
          />
        </FormField>
      )}
      {input.kind === 'boolean' && (
        <FormField label={t('build.templates.default', 'Default')}>
          <Switch
            checked={input.default === true}
            onCheckedChange={(on) => onChange(patchInput(input, { default: on }))}
            label={t('build.templates.default', 'Default')}
          />
        </FormField>
      )}
      {input.kind === 'select' && (
        <FormField
          label={t('build.templates.options', 'Options')}
          description={t('build.templates.optionsHint', 'One per line: value = label')}
          className="sm:col-span-2"
        >
          <OptionsField
            options={input.options}
            onChange={(options) => onChange(patchInput(input, { options }))}
          />
        </FormField>
      )}
      {input.kind === 'device' && (
        <>
          <FormField label={t('build.templates.filterCapability', 'Only devices with capability')}>
            <Input
              value={input.filter?.capability ?? ''}
              onChange={(e) => onChange(patchInput(input, { capability: e.target.value }))}
              data-testid="template-input-filter-capability"
            />
          </FormField>
          <FormField label={t('build.templates.filterRole', 'Only devices of type')}>
            <Input
              value={input.filter?.role ?? ''}
              onChange={(e) => onChange(patchInput(input, { role: e.target.value }))}
            />
          </FormField>
        </>
      )}
      {(input.kind === 'event' || input.kind === 'action') && (
        <FormField label={t('build.templates.readsDevice', 'Reads the device input')}>
          <Select
            value={input.deviceInput ?? ''}
            options={[
              ...(input.kind === 'action'
                ? [{ value: '', label: t('build.templates.anyAction', 'Any action') }]
                : []),
              ...deviceInputs.map((d) => ({ value: d.key, label: d.label })),
            ]}
            onChange={(e) => onChange(patchInput(input, { deviceInput: e.target.value }))}
          />
        </FormField>
      )}
    </div>
  )
}

interface OptionsFieldProps {
  readonly options: readonly { readonly value: string; readonly label: string }[]
  readonly onChange: (
    options: readonly { readonly value: string; readonly label: string }[],
  ) => void
}

/** Keeps the text as typed (a blank line is a line being written) and reports the parsed options. */
function OptionsField({ options, onChange }: OptionsFieldProps): ReactNode {
  const [text, setText] = useState(() => optionsToText(options))
  return (
    <Textarea
      rows={4}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(optionsFromText(e.target.value))
      }}
      data-testid="template-input-options"
    />
  )
}

interface MarkAsInputProps {
  readonly payload: AutomationTemplatePayload
  readonly onChange: (next: AutomationTemplatePayload) => void
}

/** The fields a pick can turn into an input, with the phrase that places each in the body. */
function fieldLabel(field: BindableField, t: (key: string, fallback: string) => string): string {
  const what: Record<BindableField['kind'], string> = {
    device: t('build.templates.kindDevice', 'Device'),
    event: t('build.templates.kindEvent', 'Event'),
    action: t('build.templates.kindAction', 'Action'),
    duration: t('build.templates.kindDuration', 'Duration'),
    number: t('build.templates.kindNumber', 'Number'),
  }
  return `${what[field.kind]} — ${field.where} · ${field.path.map(String).join('.')}`
}

function MarkAsInput({ payload, onChange }: MarkAsInputProps): ReactNode {
  const { t } = useTranslation()
  const fields = useMemo(
    () => bindableFields(payload.body, payload.bindings),
    [payload.body, payload.bindings],
  )
  const [fieldId, setFieldId] = useState('')
  const [label, setLabel] = useState('')
  const [optional, setOptional] = useState(false)
  const [deviceInput, setDeviceInput] = useState('')
  const field = fields.find((f) => f.id === fieldId)
  const deviceInputs = payload.inputs.filter((i) => i.kind === 'device')
  const needsDevice = field?.kind === 'event'

  if (fields.length === 0) {
    return (
      <p className="text-xs text-foreground-subtle" data-testid="template-nothing-to-mark">
        {t('build.templates.nothingToMark', 'Every field that can be an input already is.')}
      </p>
    )
  }

  const draft =
    field === undefined
      ? null
      : {
          key: uniqueInputKey(
            payload.inputs,
            keyFromLabel(label === '' ? field.suggestedKey : label),
          ),
          label: label.trim() === '' ? field.suggestedLabel : label.trim(),
          optional,
          ...(field.kind === 'event' || field.kind === 'action'
            ? { deviceInput: deviceInput === '' ? deviceInputs[0]?.key : deviceInput }
            : {}),
        }
  const problem =
    field === undefined || draft === null ? 'field' : markProblem(payload, field, draft)

  return (
    <div
      className="space-y-3 rounded-md border border-dashed border-border p-3"
      data-testid="template-mark-as-input"
    >
      <p className="text-sm font-medium text-foreground">
        {t('build.templates.markAsInput', 'Mark as input')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('build.templates.markField', 'Field')} className="sm:col-span-2">
          <Select
            value={fieldId}
            options={[
              {
                value: '',
                label: t('build.templates.pickField', 'Choose a field of the automation…'),
              },
              ...fields.map((f) => ({ value: f.id, label: fieldLabel(f, t) })),
            ]}
            onChange={(e) => {
              setFieldId(e.target.value)
              setLabel('')
            }}
            data-testid="template-mark-field"
          />
        </FormField>
        {field !== undefined && (
          <>
            <FormField label={t('build.templates.label', 'Label')}>
              <Input
                value={label}
                placeholder={field.suggestedLabel}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
                data-testid="template-mark-label"
              />
            </FormField>
            <FormField label={t('build.templates.requiredField', 'Required')}>
              <Switch
                checked={!optional}
                onCheckedChange={(required) => setOptional(!required)}
                label={t('build.templates.requiredField', 'Required')}
              />
            </FormField>
            {(field.kind === 'event' || field.kind === 'action') && (
              <FormField
                label={t('build.templates.readsDevice', 'Reads the device input')}
                {...(needsDevice && deviceInputs.length === 0
                  ? {
                      error: t(
                        'build.templates.markDeviceFirst',
                        'Mark the device as an input first.',
                      ),
                    }
                  : {})}
              >
                <Select
                  value={deviceInput === '' ? (deviceInputs[0]?.key ?? '') : deviceInput}
                  options={[
                    ...(field.kind === 'action'
                      ? [{ value: '', label: t('build.templates.anyAction', 'Any action') }]
                      : []),
                    ...deviceInputs.map((d) => ({ value: d.key, label: d.label })),
                  ]}
                  onChange={(e) => setDeviceInput(e.target.value)}
                />
              </FormField>
            )}
          </>
        )}
      </div>
      <Button
        size="sm"
        disabled={problem !== null || field === undefined || draft === null}
        onClick={() => {
          if (field === undefined || draft === null || problem !== null) return
          onChange(markAsInput(payload, field, draft))
          setFieldId('')
          setLabel('')
          setOptional(false)
        }}
        data-testid="template-mark-add"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t('build.templates.addInput', 'Add input')}
      </Button>
    </div>
  )
}
