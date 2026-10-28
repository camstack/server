/**
 * A number field that keeps what is typed ("0.", "", "-") while the stored
 * value is a number. `onValue` gets the parsed number, or null while the text
 * is not one.
 */
import { Input } from '@camstack/ui-library'
import { type ComponentProps, useState } from 'react'

export type DraftNumberInputProps = Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange' | 'type' | 'inputMode'
> & {
  readonly value: number | undefined
  readonly onValue: (value: number | null) => void
  /** Called with the text when it contains "{" (the variable menu opens). */
  readonly onBrace?: () => void
}

function shown(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '' : String(value)
}

export function DraftNumberInput({
  value,
  onValue,
  onBrace,
  onBlur,
  ...rest
}: DraftNumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={draft ?? shown(value)}
      onChange={(e) => {
        const text = e.target.value
        if (text.includes('{')) {
          onBrace?.()
          return
        }
        setDraft(text)
        const parsed = text.trim() === '' ? Number.NaN : Number(text)
        onValue(Number.isFinite(parsed) ? parsed : null)
      }}
      onBlur={(e) => {
        setDraft(null)
        onBlur?.(e)
      }}
    />
  )
}
