/**
 * The args template of a forward (D967). Default: the built method's input
 * passes through to the source method. Mapped: each input field of the SOURCE
 * method is a constant or `{ $input: '<field>' }` of the caller's input. A
 * source with no input has nothing to map, so the control is not drawn.
 */
import type { CompositionForwardArg } from '@camstack/types'
import { Input, Select, Switch } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type ArgChoice,
  argOf,
  choiceOf,
  defaultChoice,
  type InputField,
  parseStructuredArg,
  withArg,
} from './command-model'

type Args = Readonly<Record<string, CompositionForwardArg>>

export interface ForwardArgsEditorProps {
  /** The caller's input fields; empty for an item's `reset`, which reads nothing. */
  readonly builtFields: readonly string[]
  /** The input fields of the source method. */
  readonly sourceFields: readonly InputField[]
  readonly args: Args | undefined
  readonly onChange: (args: Args | undefined) => void
  readonly testId: string
}

type ChoiceKind = ArgChoice['kind'] | 'unset'

export function ForwardArgsEditor({
  builtFields,
  sourceFields,
  args,
  onChange,
  testId,
}: ForwardArgsEditorProps): ReactNode {
  const { t } = useTranslation()
  if (sourceFields.length === 0) return null
  const mapping = args !== undefined
  const startMapping = (): Args =>
    Object.fromEntries(
      sourceFields
        .filter((field) => field.required)
        .map((field) => [field.name, argOf(defaultChoice(field, builtFields))]),
    )
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <Switch
        checked={!mapping}
        onCheckedChange={(passThrough) => onChange(passThrough ? undefined : startMapping())}
        label={t('commands.args.passThrough')}
        className="text-[11px] text-foreground"
      />
      {mapping && (
        <ul className="flex flex-col gap-2" aria-label={t('commands.args.template')}>
          {sourceFields.map((field) => (
            <ArgRow
              key={field.name}
              field={field}
              builtFields={builtFields}
              arg={args[field.name]}
              onChange={(arg) => onChange(withArg(args, field.name, arg))}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface ArgRowProps {
  readonly field: InputField
  readonly builtFields: readonly string[]
  readonly arg: CompositionForwardArg | undefined
  readonly onChange: (arg: CompositionForwardArg | undefined) => void
}

function ArgRow({ field, builtFields, arg, onChange }: ArgRowProps): ReactNode {
  const { t } = useTranslation()
  const choice = arg === undefined ? null : choiceOf(arg)
  const kind: ChoiceKind = choice === null ? 'unset' : choice.kind
  const kinds: readonly ChoiceKind[] = [
    ...(field.required ? [] : (['unset'] as const)),
    ...(builtFields.length > 0 ? (['input'] as const) : []),
    ...(field.type === 'structured' ? [] : (['constant'] as const)),
    'structured',
  ]
  const pick = (next: string): void => {
    if (next === 'unset') return onChange(undefined)
    const wanted = kinds.find((k) => k === next)
    if (wanted === undefined || wanted === 'unset') return
    const start = defaultChoice(field, builtFields)
    if (wanted === start.kind) return onChange(argOf(start))
    if (wanted === 'input') return onChange({ $input: builtFields[0] ?? '' })
    if (wanted === 'constant') return onChange(constantStart(field))
    onChange({})
  }
  return (
    <li className="grid grid-cols-1 gap-1 sm:grid-cols-[8rem_10rem_1fr] sm:items-start">
      <span className="font-mono text-[11px] text-foreground-muted break-words">
        {field.name}
        {field.required ? ' *' : ''}
      </span>
      {kinds.length > 1 ? (
        <Select
          aria-label={t('commands.args.kind', { field: field.name })}
          value={kind}
          onChange={(event) => pick(event.target.value)}
          options={kinds.map((k) => ({ value: k, label: t(`commands.args.kinds.${k}`) }))}
        />
      ) : (
        <span className="text-[11px] text-foreground-muted">
          {t(`commands.args.kinds.${kinds[0] ?? 'structured'}`)}
        </span>
      )}
      <ArgValue field={field} builtFields={builtFields} choice={choice} onChange={onChange} />
    </li>
  )
}

function constantStart(field: InputField): CompositionForwardArg {
  if (field.type === 'boolean') return true
  if (field.type === 'number') return 0
  return ''
}

interface ArgValueProps {
  readonly field: InputField
  readonly builtFields: readonly string[]
  readonly choice: ArgChoice | null
  readonly onChange: (arg: CompositionForwardArg | undefined) => void
}

function ArgValue({ field, builtFields, choice, onChange }: ArgValueProps): ReactNode {
  const { t } = useTranslation()
  if (choice === null)
    return <span className="text-[11px] text-foreground-subtle">{t('commands.args.omitted')}</span>
  if (choice.kind === 'input') {
    return (
      <Select
        aria-label={t('commands.args.fromInput', { field: field.name })}
        value={choice.field}
        onChange={(event) => onChange({ $input: event.target.value })}
        options={builtFields.map((name) => ({ value: name, label: name }))}
      />
    )
  }
  if (choice.kind === 'structured') {
    return <StructuredInput field={field} value={choice.value} onChange={onChange} />
  }
  if (field.type === 'boolean') {
    return (
      <Select
        aria-label={t('commands.args.constant', { field: field.name })}
        value={String(choice.value === true)}
        onChange={(event) => onChange(event.target.value === 'true')}
        options={[
          { value: 'true', label: t('commands.args.true') },
          { value: 'false', label: t('commands.args.false') },
        ]}
      />
    )
  }
  return (
    <Input
      aria-label={t('commands.args.constant', { field: field.name })}
      type={field.type === 'number' ? 'number' : 'text'}
      value={String(choice.value)}
      onChange={(event) => {
        if (field.type !== 'number') return onChange(event.target.value)
        const n = Number(event.target.value)
        if (event.target.value !== '' && !Number.isNaN(n)) onChange(n)
      }}
    />
  )
}

interface StructuredInputProps {
  readonly field: InputField
  readonly value: CompositionForwardArg
  readonly onChange: (arg: CompositionForwardArg | undefined) => void
}

/** A nested value (`control.setValue`'s `control`) is edited as JSON; text that is not a template value is not applied. */
function StructuredInput({ field, value, onChange }: StructuredInputProps): ReactNode {
  const { t } = useTranslation()
  const [text, setText] = useState(JSON.stringify(value))
  const invalid = parseStructuredArg(text) === null
  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label={t('commands.args.structured', { field: field.name })}
        value={text}
        className="font-mono"
        onChange={(event) => {
          setText(event.target.value)
          const parsed = parseStructuredArg(event.target.value)
          if (parsed !== null) onChange(parsed)
        }}
      />
      {invalid && (
        <p role="alert" className="text-[11px] text-danger">
          {t('commands.args.invalidStructured')}
        </p>
      )}
    </div>
  )
}
