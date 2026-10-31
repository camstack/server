/**
 * Minimal labelled form atoms shared by the Register + Convert tabs. Kept
 * local to the addon (not in ui-library) since the styling matches the
 * benchmark page's inline inputs rather than the heavier TabbedSettingsForm.
 */
import type { ReactNode } from 'react'
import { Checkbox, Input } from '@camstack/ui-library'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1 block">
      <span className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide">
        {label}
      </span>
      {children}
    </label>
  )
}

interface TextFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
}

export function TextField({ label, value, onChange, placeholder }: TextFieldProps) {
  return (
    <Field label={label}>
      <Input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground focus:outline-none focus:border-primary/50"
      />
    </Field>
  )
}

interface NumberFieldProps {
  readonly label: string
  readonly value: number
  readonly onChange: (value: number) => void
  readonly min?: number
  readonly max?: number
  readonly step?: number
}

export function NumberField({ label, value, onChange, min, max, step }: NumberFieldProps) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? n : 0)
        }}
        className="w-full px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground focus:outline-none focus:border-primary/50"
      />
    </Field>
  )
}

interface CheckboxFieldProps {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
}

export function CheckboxField({ label, checked, onChange }: CheckboxFieldProps) {
  return (
    <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
      <Checkbox
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary"
      />
      {label}
    </label>
  )
}
