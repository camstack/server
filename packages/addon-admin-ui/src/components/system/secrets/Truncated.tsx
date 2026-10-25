/**
 * One line, ellipsised, the full text on hover and a copy button beside it.
 * Never widens its parent: inside an auto-layout table cell a `truncate` alone
 * is inert, so the caller caps the width (`maxWidthClass`).
 */
import { CopyButton, cn } from '@camstack/ui-library'

export interface TruncatedProps {
  readonly value: string
  /** What the copy button copies, when it is not the shown text (a field's full ref). */
  readonly copyValue?: string
  readonly srLabel: string
  readonly maxWidthClass?: string
  readonly className?: string
}

export function Truncated({ value, copyValue, srLabel, maxWidthClass, className }: TruncatedProps) {
  const full = copyValue ?? value
  return (
    <span className={cn('flex min-w-0 items-center gap-0.5', maxWidthClass)}>
      <span className={cn('min-w-0 truncate font-mono', className)} title={full}>
        {value}
      </span>
      <CopyButton value={full} srLabel={srLabel} className="h-6 shrink-0 px-1.5" />
    </span>
  )
}
