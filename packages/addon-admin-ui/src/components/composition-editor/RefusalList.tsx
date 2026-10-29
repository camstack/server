/**
 * The validator's refusals, one line each, by code (D391): what the helper
 * wizard and the commands card show when a save or a check is refused.
 */
import type { ReactNode } from 'react'
import type { RefusalLine } from './helper-form-model'

export interface RefusalListProps {
  readonly lines: readonly RefusalLine[]
  readonly testId?: string
}

export function RefusalList({ lines, testId = 'helper-refusals' }: RefusalListProps): ReactNode {
  if (lines.length === 0) return null
  return (
    <ul role="alert" className="flex flex-col gap-1" data-testid={testId}>
      {lines.map((line) => (
        <li key={`${line.path}:${line.code}:${line.message}`} className="text-xs text-danger">
          <span className="font-medium">{line.code}</span>
          {line.message === '' ? '' : ` — ${line.message}`}
        </li>
      ))}
    </ul>
  )
}
