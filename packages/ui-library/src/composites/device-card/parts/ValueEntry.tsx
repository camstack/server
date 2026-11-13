import { type ReactElement, useEffect, useState } from 'react'
import { Input } from '../../../primitives/input'
import { useCardGating } from '../shell/gating'
import { CardButton } from './CardButton'

export interface ValueEntryProps {
  /** `text`, or the browser's date / time / datetime-local editor. */
  readonly type: 'text' | 'date' | 'time' | 'datetime-local'
  /** The device's value in the editor's shape. */
  readonly value: string
  readonly ariaLabel: string
  readonly saveLabel: string
  readonly onSave: (value: string) => void
  readonly testId?: string
}

/**
 * A typed value and its Save: the draft is sent only on Save (or Enter), and
 * follows the device again when the device's value changes. Obeys the shell's
 * gating like every control that actuates.
 */
export function ValueEntry({
  type,
  value,
  ariaLabel,
  saveLabel,
  onSave,
  testId,
}: ValueEntryProps): ReactElement {
  const gating = useCardGating()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const changed = draft !== value
  return (
    <div className="flex w-full max-w-80 items-center gap-2">
      <Input
        type={type}
        aria-label={ariaLabel}
        data-testid={testId}
        value={draft}
        disabled={gating.blocked}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && changed && !gating.blocked) onSave(draft)
        }}
        className="min-w-0 flex-1"
      />
      <CardButton
        tone="primary"
        disabled={!changed}
        data-testid={testId === undefined ? undefined : `${testId}-save`}
        onClick={() => onSave(draft)}
      >
        {saveLabel}
      </CardButton>
    </div>
  )
}
