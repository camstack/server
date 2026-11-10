/**
 * `TemplateField` — a title/body box with grouped placeholder chips that
 * insert at the cursor, plus an unknown-name warning.
 *
 * `vars: undefined` means the catalog has not ANSWERED (loading, or a hub
 * without the method) — no chips, no warning. It must never read as "no
 * variables", which is what `vars: []` (answered, none apply) means. See
 * CLAUDE.md: "A UI claims something is ABSENT only from a query that
 * ANSWERED with nothing."
 *
 * `deviceValues: false` renders a plain box with the same chips: for a text the hub
 * does not pass through the device-template renderer (the shipped-sentence catalog,
 * which is `{{var}}` substitution only), a device-value picker would promise a
 * feature that does nothing.
 */
import type { NcTemplateVarContext, NcTemplateVarDescriptor } from '@camstack/types'
import {
  Button,
  DeviceTemplateField,
  type DeviceTemplateFieldHandle,
  Input,
  Textarea,
} from '@camstack/ui-library'
import { AlertTriangle } from 'lucide-react'
import { type ChangeEvent, useRef } from 'react'
import {
  groupTemplateVars,
  placeholderToken,
  type TemplateVarGroupId,
  unknownPlaceholders,
} from './template-field.helpers'
import { useTemplatePreview } from './use-template-catalog'
import { useTranslation } from 'react-i18next'

const GROUP_LABELS: Readonly<Record<TemplateVarGroupId, string>> = {
  subject: 'Subject',
  place: 'Place',
  time: 'Time',
  rule: 'Rule',
  occupancy: 'Occupancy',
  sound: 'Sound',
  sensor: 'Sensor',
  system: 'System event',
  digest: 'Digest',
  ai: 'AI',
}

const LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1'

export interface TemplateFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (next: string) => void
  /** `undefined` = the catalog has not answered: no chips, no warning. */
  readonly vars: readonly NcTemplateVarDescriptor[] | undefined
  readonly multiline?: boolean
  readonly placeholder?: string
  readonly disabled?: boolean
  /** Whether the hub renders this text's `{{ alias.field }}` device values. Default true. */
  readonly deviceValues?: boolean
  readonly testId: string
}

export function TemplateField({
  label,
  value,
  onChange,
  vars,
  multiline = false,
  placeholder,
  disabled = false,
  deviceValues = true,
  testId,
}: TemplateFieldProps) {
  const { t } = useTranslation()
  const field = useRef<DeviceTemplateFieldHandle | null>(null)
  const plain = useRef<(HTMLInputElement & HTMLTextAreaElement) | null>(null)
  const unknown = vars ? unknownPlaceholders(value, vars) : []

  const insert = (descriptor: NcTemplateVarDescriptor): void => {
    const token = placeholderToken(descriptor)
    if (deviceValues) {
      field.current?.insertText(token.text, token.cursorOffset)
      return
    }
    const element = plain.current
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? value.length
    onChange(value.slice(0, start) + token.text + value.slice(end))
    const cursor = start + token.cursorOffset
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(cursor, cursor)
    })
  }
  const edit = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
    onChange(e.target.value)

  return (
    <div className="space-y-1">
      <label className={LABEL_CLASS}>{label}</label>
      {deviceValues ? (
        <DeviceTemplateField
          label={label}
          value={value}
          onChange={onChange}
          multiline={multiline}
          placeholder={placeholder}
          disabled={disabled}
          handle={field}
          testId={testId}
        />
      ) : multiline ? (
        <Textarea
          ref={plain}
          aria-label={label}
          value={value}
          rows={2}
          disabled={disabled}
          placeholder={placeholder}
          onChange={edit}
          data-testid={`${testId}-input`}
        />
      ) : (
        <Input
          ref={plain}
          aria-label={label}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={edit}
          data-testid={`${testId}-input`}
        />
      )}
      {vars && vars.length === 0 ? (
        <p className="text-[10px] text-foreground-subtle">
          {t('notifications.templateField.noVariablesForThisField', 'No variables for this field.')}
        </p>
      ) : null}
      {vars && vars.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {groupTemplateVars(vars).map((entry) => (
            <div
              key={entry.group}
              className="flex flex-wrap items-center gap-1"
              data-testid={`${testId}-group-${entry.group}`}
            >
              <span className="text-[10px] uppercase text-foreground-subtle">
                {GROUP_LABELS[entry.group]}
              </span>
              {entry.vars.map((descriptor) => (
                <Button
                  variant="unstyled"
                  key={descriptor.name}
                  type="button"
                  disabled={disabled}
                  // Keep the caret where it is: a mousedown on the chip would blur the box.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(descriptor)}
                  title={`${descriptor.description ?? descriptor.label} — e.g. "${descriptor.example}"`}
                  className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-foreground hover:bg-surface-hover"
                  data-testid={`${testId}-chip-${descriptor.name}`}
                >
                  {descriptor.dynamic
                    ? t('notifications.templateField.class', '{{name}}<class>', {
                        name: descriptor.name,
                      })
                    : descriptor.name}
                </Button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {unknown.length > 0 ? (
        <p
          className="flex items-center gap-1 text-[10px] text-warning"
          data-testid={`${testId}-unknown`}
        >
          <AlertTriangle className="h-3 w-3" />
          {t('notifications.templateField.willBeEmpty', {
            names: unknown.map((name) => `{{${name}}}`).join(' '),
          })}
        </p>
      ) : null}
    </div>
  )
}

export interface TemplatePreviewProps {
  readonly context: NcTemplateVarContext
  readonly title: string
  readonly body: string
  readonly testId: string
}

/** The hub renders the draft with example values — the only honest preview. */
export function TemplatePreview({ context, title, body, testId }: TemplatePreviewProps) {
  const { t } = useTranslation()
  const preview = useTemplatePreview(context, { title, body }, true)
  if (!preview.data) return null
  return (
    <div
      className="rounded-md border border-border bg-surface-subtle px-2.5 py-1.5 text-xs"
      data-testid={testId}
    >
      <p className="text-[10px] uppercase text-foreground-subtle">
        {t('notifications.templateField.previewExampleValues', 'Preview (example values)')}
      </p>
      {preview.data.title !== null ? <p className="font-medium">{preview.data.title}</p> : null}
      {preview.data.body !== null ? (
        <p className="whitespace-pre-wrap">{preview.data.body}</p>
      ) : null}
    </div>
  )
}
