import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import type { CardTone } from '../shell/model'

const TONE_BG: Readonly<Record<CardTone, string>> = {
  primary: 'bg-primary',
  info: 'bg-info',
  warning: 'bg-warning',
  success: 'bg-success',
  danger: 'bg-danger',
  muted: 'bg-foreground-muted',
}

export interface StateDotProps {
  /** The state's tone; null is an unknown state, drawn hollow so it never reads as stopped. */
  readonly tone: CardTone | null
  /** A machine-readable state name for tests and styling hooks. */
  readonly state: string
  readonly testId?: string
}

/** A small round mark of a device's state, set before a line of text. */
export function StateDot({ tone, state, testId }: StateDotProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-state={state}
      data-testid={testId}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        tone === null ? 'border-2 border-foreground-muted' : TONE_BG[tone],
      )}
    />
  )
}
