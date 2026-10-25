import { type ConfigField, isSecretClear, isSecretFieldView } from '@camstack/types'
import { type JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Input } from '../../primitives/input'
import { Switch } from '../../primitives/switch'
import { Select } from '../../primitives/select'
import { FormField } from '../form-field'
import { SecretFieldControl } from '../config-secret-field'
import { isRedactedSecret, isSecretField } from './record-entry-secrets'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function labelFor(key: string, node: Record<string, unknown>): string {
  const desc = node['description']
  if (typeof desc === 'string' && desc.length > 0) return desc
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBool(value: unknown): boolean {
  return value === true
}

function objectFromJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * What the secret control is hydrated with. A read hands a stored secret as a
 * VIEW (`{ $secret: <row ref>, set: true }`) the control reveals by ref through
 * the host's audited reveal; the legacy redaction token is "set, no ref" (it
 * can be replaced but not revealed); anything else is "nothing stored".
 */
function hydratedSecret(value: unknown): unknown {
  if (isSecretFieldView(value) || isSecretClear(value)) return value
  if (isRedactedSecret(value)) return { $secret: null, v: 1, set: true }
  return null
}

function RecordEntrySecretField({
  name,
  label,
  required,
  value,
  disabled,
  onPatch,
}: {
  readonly name: string
  readonly label: string
  readonly required: boolean
  readonly value: unknown
  readonly disabled?: boolean
  readonly onPatch: (next: unknown) => void
}): JSX.Element {
  const field: ConfigField = { type: 'password', key: name, label, required }
  return (
    <FormField label={label} required={required}>
      <SecretFieldControl
        field={field}
        value={hydratedSecret(value)}
        onChange={onPatch}
        disabled={disabled}
      />
    </FormField>
  )
}

interface FieldProps {
  readonly path: string
  readonly name: string
  readonly node: Record<string, unknown>
  readonly value: unknown
  readonly secretPaths: readonly string[]
  readonly required: boolean
  readonly disabled?: boolean
  readonly onPatch: (path: string, next: unknown) => void
}

function SchemaField(props: FieldProps): JSX.Element | null {
  const { path, name, node, value, secretPaths, required, disabled, onPatch } = props
  const label = labelFor(name, node)
  const uiText = useUiText()

  if (isSecretField(path, secretPaths, node)) {
    return (
      <RecordEntrySecretField
        name={name}
        label={label}
        required={required}
        value={value}
        disabled={disabled}
        onPatch={(next) => onPatch(path, next)}
      />
    )
  }

  const enumValues = node['enum']
  if (Array.isArray(enumValues) && enumValues.every((v) => typeof v === 'string')) {
    return (
      <FormField label={label} required={required}>
        <Select
          value={readString(value)}
          onChange={(e) => onPatch(path, e.target.value)}
          disabled={disabled}
          options={enumValues.map((opt) => ({ value: opt, label: opt }))}
        />
      </FormField>
    )
  }

  const type = node['type']
  if (type === 'boolean') {
    return (
      <FormField label={label} required={required}>
        <Switch
          checked={readBool(value)}
          onCheckedChange={(v) => onPatch(path, v)}
          disabled={disabled}
        />
      </FormField>
    )
  }

  if (type === 'integer' || type === 'number') {
    return (
      <FormField label={label} required={required}>
        <Input
          type="number"
          value={readNumber(value) ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            onPatch(path, raw === '' ? undefined : Number(raw))
          }}
          disabled={disabled}
        />
      </FormField>
    )
  }

  if (type === 'object') {
    const properties = node['properties']
    if (isRecord(properties)) {
      const childValue = isRecord(value) ? value : {}
      const childRequired = Array.isArray(node['required'])
        ? node['required'].filter((k): k is string => typeof k === 'string')
        : []
      return (
        <fieldset className="space-y-3 rounded-lg border border-border-subtle p-3">
          <legend className="px-1 text-xs font-medium text-foreground-muted">{label}</legend>
          {Object.entries(properties).map(([key, childNode]) =>
            isRecord(childNode) ? (
              <SchemaField
                key={key}
                path={`${path}.${key}`}
                name={key}
                node={childNode}
                value={childValue[key]}
                secretPaths={secretPaths}
                required={childRequired.includes(key)}
                disabled={disabled}
                onPatch={onPatch}
              />
            ) : null,
          )}
        </fieldset>
      )
    }
    const jsonText = isRecord(value) ? JSON.stringify(value, null, 2) : '{}'
    return (
      <FormField
        label={label}
        required={required}
        description={uiText('uiLibrary.recordEntries.jsonObject', 'JSON object')}
      >
        <textarea
          className={cn(
            'min-h-[8rem] w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-xs text-foreground',
            'placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          rows={6}
          defaultValue={jsonText}
          disabled={disabled}
          onBlur={(e) => {
            const parsed = objectFromJson(e.target.value)
            if (parsed !== null) onPatch(path, parsed)
          }}
        />
      </FormField>
    )
  }

  if (type === 'string' || type === undefined) {
    return (
      <FormField label={label} required={required}>
        <Input
          value={readString(value)}
          onChange={(e) => onPatch(path, e.target.value)}
          disabled={disabled}
        />
      </FormField>
    )
  }

  return null
}

function setAtPath(
  root: Record<string, unknown>,
  path: string,
  next: unknown,
): Record<string, unknown> {
  const parts = path.split('.')
  if (parts.length === 1) {
    return { ...root, [parts[0] as string]: next }
  }
  const [head, ...rest] = parts
  const key = head as string
  const child = isRecord(root[key]) ? root[key] : {}
  return { ...root, [key]: setAtPath(child, rest.join('.'), next) }
}

export interface EntryJsonSchemaFormProps {
  /** JSON Schema root (`EntryKindInfo.fields`). */
  readonly schema: Record<string, unknown>
  readonly secretPaths: readonly string[]
  readonly value: Record<string, unknown>
  readonly onChange: (value: Record<string, unknown>) => void
  readonly disabled?: boolean
}

/** Renders an entry body from the engine's JSON Schema descriptor. */
export function EntryJsonSchemaForm({
  schema,
  secretPaths,
  value,
  onChange,
  disabled,
}: EntryJsonSchemaFormProps): JSX.Element | null {
  const properties = schema['properties']
  if (!isRecord(properties)) return null
  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((k): k is string => typeof k === 'string')
    : []

  const onPatch = (path: string, next: unknown): void => {
    onChange(setAtPath(value, path, next))
  }

  return (
    <div className="space-y-3">
      {Object.entries(properties).map(([key, node]) =>
        isRecord(node) ? (
          <SchemaField
            key={key}
            path={key}
            name={key}
            node={node}
            value={value[key]}
            secretPaths={secretPaths}
            required={required.includes(key)}
            disabled={disabled}
            onPatch={onPatch}
          />
        ) : null,
      )}
    </div>
  )
}
