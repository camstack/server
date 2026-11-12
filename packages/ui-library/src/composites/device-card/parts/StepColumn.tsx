import type { ReactElement, ReactNode } from 'react'
import type { CardGlyph } from '../icons'
import { CardButton } from './CardButton'

export interface StepButton {
  readonly glyph: CardGlyph
  /** The button's accessible name ("Next program", "Volume up"). */
  readonly label: string
  /** Absent: the step does not exist, its button is not drawn. */
  readonly onPress?: () => void
  readonly disabled?: boolean
}

export interface StepColumnProps {
  readonly up: StepButton
  readonly down: StepButton
  /** The current value, bold; null draws no value (not known). */
  readonly value: ReactNode
  /** The lines under the value ("vol", "2 h 35", "fine 11:58"). */
  readonly notes?: readonly ReactNode[]
  readonly testId?: string
}

function Step({
  step,
  testId,
}: {
  readonly step: StepButton
  readonly testId?: string
}): ReactElement | null {
  if (step.onPress === undefined) return null
  return (
    <CardButton
      glyph={step.glyph}
      aria-label={step.label}
      title={step.label}
      disabled={step.disabled}
      onClick={step.onPress}
      data-testid={testId}
      className="min-w-11 px-2"
    />
  )
}

/**
 * A side column that steps through values: a button above, the value with
 * its notes, a button below — a program, a suction level, a volume. A step
 * the device does not offer is not drawn.
 */
export function StepColumn({ up, down, value, notes = [], testId }: StepColumnProps): ReactElement {
  return (
    <div className="flex flex-col items-center gap-2" data-testid={testId}>
      <Step step={up} testId={testId === undefined ? undefined : `${testId}-up`} />
      {value === null && notes.length === 0 ? null : (
        <div className="grid min-w-23 gap-0.5 text-center">
          {value === null ? null : (
            <b
              className="text-sm font-semibold leading-tight"
              data-testid={testId === undefined ? undefined : `${testId}-value`}
            >
              {value}
            </b>
          )}
          {notes.map((note, i) => (
            <small key={i} className="text-xs text-foreground-muted">
              {note}
            </small>
          ))}
        </div>
      )}
      <Step step={down} testId={testId === undefined ? undefined : `${testId}-down`} />
    </div>
  )
}
