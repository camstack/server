/**
 * Integer precision control bounded to 0–10. Empty means "inherit / clear";
 * out-of-range input is clamped so the form never writes a refused value.
 */
import type { ChangeEvent, ReactNode } from 'react'

const FIELD_CLASS =
  'w-full min-w-0 px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed'

const PRECISION_MIN = 0
const PRECISION_MAX = 10

export interface PrecisionInputProps {
  readonly value: string
  readonly onChange: (precision: string) => void
  readonly disabled?: boolean
  readonly placeholder?: string
  readonly className?: string
  readonly id?: string
  readonly 'aria-label'?: string
}

/** Clamp a raw number input to 0–10, or return '' when empty / non-numeric. */
export function clampPrecisionInput(raw: string): string {
  if (raw.trim() === '') return ''
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return ''
  if (parsed < PRECISION_MIN) return String(PRECISION_MIN)
  if (parsed > PRECISION_MAX) return String(PRECISION_MAX)
  return String(parsed)
}

export function PrecisionInput({
  value,
  onChange,
  disabled = false,
  placeholder,
  className,
  id,
  'aria-label': ariaLabel,
}: PrecisionInputProps): ReactNode {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(clampPrecisionInput(event.target.value))
  }

  return (
    <input
      type="number"
      min={PRECISION_MIN}
      max={PRECISION_MAX}
      step={1}
      id={id}
      className={className ?? FIELD_CLASS}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={handleChange}
      disabled={disabled}
    />
  )
}
