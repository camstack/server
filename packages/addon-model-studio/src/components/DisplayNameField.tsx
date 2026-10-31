/**
 * The optional display-name field every import card shows. Empty means "use
 * the source's own name"; the model id is never derived from it.
 */
import { Field } from './Form.js'
import { useT } from '../i18n/index.js'
import { MODEL_DISPLAY_NAME_MAX, parseDisplayName } from '../display-name.js'
import { Input } from '@camstack/ui-library'

export interface DisplayNameFieldProps {
  readonly value: string
  readonly onChange: (value: string) => void
  /** The name the model gets when the field is left empty. */
  readonly defaultName: string
}

export function DisplayNameField({ value, onChange, defaultName }: DisplayNameFieldProps) {
  const { t } = useT()
  const parsed = parseDisplayName(value)
  return (
    <div className="space-y-1">
      <Field label={t('displayName.label')}>
        <Input
          type="text"
          value={value}
          placeholder={defaultName}
          maxLength={MODEL_DISPLAY_NAME_MAX}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground focus:outline-none focus:border-primary/50"
        />
      </Field>
      {parsed.kind === 'invalid' && (
        <div className="text-[11px] text-danger">
          {parsed.code === 'control'
            ? t('displayName.control')
            : t('displayName.tooLong', { length: parsed.length, max: MODEL_DISPLAY_NAME_MAX })}
        </div>
      )}
    </div>
  )
}

/** The value an import call should send: the cleaned name, or nothing. */
export function importNameOf(value: string): string | undefined {
  const parsed = parseDisplayName(value)
  return parsed.kind === 'set' ? parsed.name : undefined
}

/** True when the field holds something an import would reject. */
export function isDisplayNameInvalid(value: string): boolean {
  return parseDisplayName(value).kind === 'invalid'
}
