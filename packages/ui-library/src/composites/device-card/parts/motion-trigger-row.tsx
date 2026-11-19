import { type BottomRow, rowButtons } from '../shell/bottom-rows'
import { CardButton } from './CardButton'

export interface MotionTriggerRowProps {
  /** The served "on motion" value; null when the device offers none (no row). */
  readonly on: boolean | null
  readonly pending: boolean
  readonly label: string
  readonly testId: string
  readonly onToggle: (enabled: boolean) => void
}

/**
 * The "on motion" toggle every card with a `motion-trigger` binding carries as
 * a secondary row below the scene. Null when the device offers none.
 */
export function motionTriggerRow(props: MotionTriggerRowProps): BottomRow | null {
  const { on } = props
  if (on === null) return null
  return rowButtons('motion', {
    buttons: [
      <CardButton
        key="motion"
        tone={on ? 'on' : 'default'}
        aria-pressed={on}
        disabled={props.pending}
        data-testid={props.testId}
        onClick={() => props.onToggle(!on)}
      >
        {props.label}
      </CardButton>,
    ],
  })
}
