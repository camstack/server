import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { useCardGating } from './gating'

export interface ScenePowerProps {
  readonly on: boolean
  /** The accessible name of the switch ("Power", the device name). */
  readonly label: string
  readonly onToggle: (next: boolean) => void
  readonly testId?: string
  /** The drawing. */
  readonly children: ReactNode
}

/**
 * Power ON the scene: for a device whose only control is on / off, tapping the
 * drawing toggles it and no separate power button sits beside it. A switch to
 * assistive tech (`role="switch"`, `aria-checked`, the label), a keyboard
 * toggle (Enter and Space), and the shell's gating: offline or read only, the
 * drawing does not answer and says why in its title.
 */
export function ScenePower({
  on,
  label,
  onToggle,
  testId,
  children,
}: ScenePowerProps): ReactElement {
  const gating = useCardGating()
  const toggle = (): void => {
    if (!gating.blocked) onToggle(!on)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  }
  return (
    <div
      role="switch"
      tabIndex={gating.blocked ? -1 : 0}
      aria-checked={on}
      aria-disabled={gating.blocked}
      aria-label={label}
      title={gating.blocked ? (gating.reason ?? undefined) : label}
      data-testid={testId ?? 'dc-scene-power'}
      className={cn(
        'flex min-h-11 min-w-11 items-center justify-center rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary',
        gating.blocked ? 'cursor-default opacity-45' : 'cursor-pointer',
      )}
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}
