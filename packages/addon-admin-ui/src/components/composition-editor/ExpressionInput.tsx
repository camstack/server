import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { applySuggestion, expressionSuggestions } from './expression-suggestions'
import { Input } from '@camstack/ui-library'

export interface ExpressionInputProps {
  readonly label: string
  readonly value: string
  readonly bindings: readonly string[]
  readonly onChange: (next: string) => void
}

export function ExpressionInput({
  label,
  value,
  bindings,
  onChange,
}: ExpressionInputProps): ReactNode {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState(value.length)
  const suggestions = expressionSuggestions(value, cursor, bindings)
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-[11px]">
        {label}
        <Input
          ref={input}
          className="font-mono px-1.5 py-0.5 text-[11px] bg-background border border-border rounded"
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setCursor(e.target.selectionStart ?? e.target.value.length)
          }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? value.length)}
        />
      </label>
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label={t('compositionEditor.suggestions')}
          className="rounded border border-border bg-surface text-[11px]"
        >
          {suggestions.map((s) => (
            <li
              key={`${s.kind}:${s.label}`}
              role="option"
              aria-selected={false}
              tabIndex={0}
              className="flex justify-between gap-2 px-1 cursor-pointer hover:bg-surface-hover"
              onClick={() => {
                const next = applySuggestion(value, cursor, s)
                onChange(next.text)
                setCursor(next.cursor)
                input.current?.focus()
              }}
            >
              <span className="font-mono">{s.label}</span>
              {s.hintKey !== null && <span className="text-foreground-subtle">{t(s.hintKey)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
