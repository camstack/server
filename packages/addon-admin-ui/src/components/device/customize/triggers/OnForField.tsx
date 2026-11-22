/**
 * How long a linked trigger holds its device on: the shared per-unit duration
 * fields. What is typed is kept here and written once, when the fields are
 * left, so one edit is one save.
 */
import { ON_FOR_MAX_SECONDS } from '@camstack/types'
import { DurationPartsInput } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useDurationLabels } from '../../../../lib/use-duration-labels'

export interface OnForFieldProps {
  readonly seconds: number
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
  readonly testId: string
  readonly onCommit: (seconds: number) => void
}

const MIN_SECONDS = 1

export function OnForField({
  seconds,
  label,
  hint,
  disabled,
  testId,
  onCommit,
}: OnForFieldProps): ReactNode {
  const labels = useDurationLabels()
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? seconds
  const commit = (): void => {
    if (draft === null) return
    setDraft(null)
    if (draft !== seconds && draft >= MIN_SECONDS && draft <= ON_FOR_MAX_SECONDS) onCommit(draft)
  }
  return (
    <span
      title={hint}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) commit()
      }}
    >
      <DurationPartsInput
        seconds={shown}
        min={MIN_SECONDS}
        max={ON_FOR_MAX_SECONDS}
        labels={labels}
        aria-label={label}
        disabled={disabled}
        testIdPrefix={testId}
        onChange={setDraft}
      />
    </span>
  )
}
