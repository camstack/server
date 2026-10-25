/**
 * Text field with insertable placeholder chips — the same interaction model
 * as Notification Center's TemplateField, without the NC variable catalog.
 */
import { Input } from '../../primitives/input.js'
import { type ChangeEvent, useRef, type JSX } from 'react'

const LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1'
const TEXTAREA_CLASS =
  'w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-primary'

export interface PlaceholderChip {
  readonly id: string
  readonly label: string
  /** Exact text inserted at the cursor. */
  readonly token: string
}

export interface PlaceholderChipFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (next: string) => void
  /**
   * `undefined` = catalog has not answered: no chips, no warning (D315).
   * `[]` = answered empty.
   */
  readonly chips: readonly PlaceholderChip[] | undefined
  readonly multiline?: boolean
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly testId: string
  readonly maxLength?: number
}

export function insertAtSelection(
  value: string,
  selection: { readonly start: number; readonly end: number },
  token: string,
): { readonly value: string; readonly cursor: number } {
  const before = value.slice(0, selection.start)
  const after = value.slice(selection.end)
  return { value: `${before}${token}${after}`, cursor: before.length + token.length }
}

export function PlaceholderChipField({
  label,
  value,
  onChange,
  chips,
  multiline = false,
  placeholder,
  disabled = false,
  testId,
  maxLength,
}: PlaceholderChipFieldProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const insert = (token: string): void => {
    const element = multiline ? areaRef.current : inputRef.current
    const selection = {
      start: element?.selectionStart ?? value.length,
      end: element?.selectionEnd ?? value.length,
    }
    const result = insertAtSelection(value, selection, token)
    onChange(result.value)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(result.cursor, result.cursor)
    })
  }

  const handle = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
    onChange(e.target.value)

  return (
    <div className="space-y-1" data-testid={testId}>
      <label className={LABEL_CLASS}>{label}</label>
      {multiline ? (
        <textarea
          ref={areaRef}
          value={value}
          rows={2}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={handle}
          className={TEXTAREA_CLASS}
          data-testid={`${testId}-input`}
        />
      ) : (
        <Input
          ref={inputRef}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={handle}
          data-testid={`${testId}-input`}
        />
      )}
      {chips !== undefined && chips.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5" data-testid={`${testId}-chips`}>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              disabled={disabled}
              className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-50"
              onClick={() => insert(chip.token)}
              data-testid={`${testId}-chip-${chip.id}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
