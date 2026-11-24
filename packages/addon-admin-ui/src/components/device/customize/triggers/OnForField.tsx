/**
 * How long a linked trigger holds its device on: the shared per-unit duration
 * fields. A valid time goes to the section's draft as it is typed; the write
 * happens when the section is saved, never from here.
 */
import { ON_FOR_MAX_SECONDS } from '@camstack/types'
import { DurationInput } from '@camstack/ui-library'
import type { ReactNode } from 'react'

export interface OnForFieldProps {
  readonly seconds: number
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
  readonly testId: string
  /** The most the target may be held on for; the 24 h bound when absent. */
  readonly maxSeconds?: number
  readonly onChange: (seconds: number) => void
}

const MIN_SECONDS = 1

export function OnForField({
  seconds,
  label,
  hint,
  disabled,
  testId,
  maxSeconds = ON_FOR_MAX_SECONDS,
  onChange,
}: OnForFieldProps): ReactNode {
  return (
    <span title={hint} className="max-w-full min-w-0">
      <DurationInput
        value={seconds}
        min={MIN_SECONDS}
        max={maxSeconds}
        aria-label={label}
        disabled={disabled}
        testIdPrefix={testId}
        className="flex-wrap"
        onChange={(next) => {
          // A time outside the bounds stays in the fields, marked, and is not drafted.
          if (next !== seconds && next >= MIN_SECONDS && next <= maxSeconds) onChange(next)
        }}
      />
    </span>
  )
}
