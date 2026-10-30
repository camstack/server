/**
 * One open argument of a device command, shaped by the vocabulary offer: a
 * number with its unit and bounds, a closed list, a yes/no, free text. Any of
 * them can be replaced by a variable chip — the "{x}" button lists the
 * variables in scope, and typing "{" opens the same list.
 */

import type { LooseVocabOpenArg, VocabLocale } from '@camstack/types'
import {
  QuantityValueInput,
  boundsInPicked,
  typedToStored,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
  Input,
  SelectedChip,
} from '@camstack/ui-library'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DraftNumberInput } from './DraftNumberInput'
import { FixedSelect } from './FixedSelect'
import {
  type ArgIssue,
  argIssue,
  defaultArgValue,
  quantityOffer,
  type StepArgValue,
} from './command-vocab'

/** A value an argument may name instead of a typed one. */
export interface ScopeVariable {
  readonly name: string
  /** What it holds, shown next to the name ("the portion, a number"). */
  readonly hint: string
}

export interface ArgFieldProps {
  readonly arg: LooseVocabOpenArg
  readonly locale: VocabLocale
  readonly variables: readonly ScopeVariable[]
  readonly value: StepArgValue
  readonly onChange: (next: StepArgValue) => void
}

function fixedText(value: StepArgValue): string {
  return value.kind === 'fixed' ? String(value.value) : ''
}

export function ArgField({ arg, locale, variables, value, onChange }: ArgFieldProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const label = arg.label[locale]
  const issue = argIssue(arg, value)

  const field =
    value.kind === 'var' ? (
      <SelectedChip label={value.name} onRemove={() => onChange(defaultArgValue(arg))} />
    ) : (
      <FixedInput
        arg={arg}
        locale={locale}
        value={value}
        onChange={onChange}
        onBrace={() => setMenuOpen(true)}
      />
    )

  return (
    <span className="inline-flex flex-col gap-0.5 align-top" data-testid={`arg-${arg.key}`}>
      <span className="inline-flex items-center gap-1">
        {field}
        {variables.length > 0 && (
          <Dropdown open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownTrigger
              aria-label={t('flow.arg.useVariable', 'Use a variable for {{label}}', { label })}
              className="h-8 rounded-md border border-border bg-surface px-2 font-mono text-xs text-foreground hover:bg-surface-hover"
            >
              {'{x}'}
            </DropdownTrigger>
            <DropdownContent>
              {variables.map((v) => (
                <DropdownItem key={v.name} onClick={() => onChange({ kind: 'var', name: v.name })}>
                  {`${v.name}  ·  ${v.hint}`}
                </DropdownItem>
              ))}
            </DropdownContent>
          </Dropdown>
        )}
      </span>
      <ArgHint arg={arg} value={value} issue={issue} />
    </span>
  )
}

interface FixedInputProps {
  readonly arg: LooseVocabOpenArg
  readonly locale: VocabLocale
  readonly value: Extract<StepArgValue, { kind: 'fixed' }>
  readonly onChange: (next: StepArgValue) => void
  readonly onBrace: () => void
}

function FixedInput({ arg, locale, value, onChange, onBrace }: FixedInputProps) {
  const { t } = useTranslation()
  const offer = arg.offer
  const label = arg.label[locale]
  if (offer.kind === 'enum') {
    return (
      <FixedSelect
        widthClass="w-40"
        aria-label={label}
        value={String(value.value)}
        onChange={(e) => {
          const picked = offer.values.find((v) => String(v.value) === e.target.value)
          if (picked !== undefined) onChange({ kind: 'fixed', value: picked.value })
        }}
        options={offer.values.map((v) => ({ value: String(v.value), label: v.label[locale] }))}
      />
    )
  }
  if (offer.kind === 'boolean') {
    return (
      <FixedSelect
        widthClass="w-28"
        aria-label={label}
        value={value.value === true ? 'yes' : 'no'}
        onChange={(e) => onChange({ kind: 'fixed', value: e.target.value === 'yes' })}
        options={[
          { value: 'yes', label: t('common.yes', 'Yes') },
          { value: 'no', label: t('common.no', 'No') },
        ]}
      />
    )
  }
  const quantity = quantityOffer(arg)
  if (quantity !== undefined) {
    return (
      <QuantityValueInput
        quantity={quantity.quantity}
        storedUnit={quantity.unit}
        value={typeof value.value === 'number' ? value.value : undefined}
        unit={value.unit}
        min={quantity.min}
        max={quantity.max}
        aria-label={label}
        onBrace={onBrace}
        onChange={(typed) => {
          const stored = typedToStored(typed, quantity.unit)
          onChange({ kind: 'fixed', value: stored.value, unit: stored.unit })
        }}
      />
    )
  }
  if (offer.kind === 'number') {
    return (
      <NumberInput
        label={label}
        unit={offer.unit}
        value={value}
        onChange={onChange}
        onBrace={onBrace}
      />
    )
  }
  return (
    <Input
      aria-label={label}
      type={offer.kind === 'text' && offer.secret === true ? 'password' : 'text'}
      className="w-40"
      value={fixedText(value)}
      onChange={(e) => {
        if (e.target.value.includes('{')) {
          onBrace()
          return
        }
        onChange({ kind: 'fixed', value: e.target.value })
      }}
    />
  )
}

interface NumberInputProps {
  readonly label: string
  readonly unit: string | undefined
  readonly value: Extract<StepArgValue, { kind: 'fixed' }>
  readonly onChange: (next: StepArgValue) => void
  readonly onBrace: () => void
}

function NumberInput({ label, unit, value, onChange, onBrace }: NumberInputProps) {
  return (
    <>
      <DraftNumberInput
        aria-label={label}
        className="w-20"
        value={typeof value.value === 'number' ? value.value : undefined}
        onValue={(n) => onChange({ kind: 'fixed', value: n ?? Number.NaN })}
        onBrace={onBrace}
      />
      {unit !== undefined && <span className="text-sm text-foreground-muted">{unit}</span>}
    </>
  )
}

interface ArgHintProps {
  readonly arg: LooseVocabOpenArg
  readonly value: StepArgValue
  readonly issue: ArgIssue | null
}

function ArgHint({ arg, value, issue }: ArgHintProps) {
  const { t } = useTranslation()
  const offer = arg.offer
  if (value.kind !== 'fixed' || offer.kind !== 'number') return null
  if (offer.min === undefined && offer.max === undefined) return null
  const quantity = quantityOffer(arg)
  const shownUnit = quantity === undefined ? offer.unit : (value.unit ?? quantity.unit)
  const shown =
    quantity === undefined
      ? { min: offer.min, max: offer.max }
      : boundsInPicked(
          { min: offer.min, max: offer.max },
          quantity.unit,
          shownUnit ?? quantity.unit,
        )
  const unitText = shownUnit ?? ''
  // A converted bound is a hint, not a measurement: 4 significant digits read cleanly.
  const round = (n: number | undefined): number | undefined =>
    n === undefined || quantity === undefined ? n : Number(n.toPrecision(4))
  const bounds = { min: round(shown.min), max: round(shown.max) }
  const range =
    bounds.min !== undefined && bounds.max !== undefined
      ? t('flow.arg.range', '{{min}} to {{max}} {{unit}}', {
          min: bounds.min,
          max: bounds.max,
          unit: unitText,
        })
      : bounds.min !== undefined
        ? t('flow.arg.atLeast', 'at least {{min}} {{unit}}', { min: bounds.min, unit: unitText })
        : t('flow.arg.atMost', 'at most {{max}} {{unit}}', { max: bounds.max, unit: unitText })
  return (
    <span
      className={`text-[11px] ${issue === null ? 'text-foreground-subtle' : 'text-danger'}`}
      role={issue === null ? undefined : 'alert'}
    >
      {range.trim()}
    </span>
  )
}
