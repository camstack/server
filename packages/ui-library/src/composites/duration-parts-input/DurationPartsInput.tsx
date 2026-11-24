/**
 * A duration in SECONDS as hours, minutes and seconds side by side — the
 * default shape of {@link DurationInput}, kept as the name its callers use.
 */
import type { ReactNode } from 'react'
import { DurationInput } from './DurationInput.js'
import type { DurationPart } from './duration-parts.js'

export type DurationPartLabels = Readonly<Record<DurationPart, string>>

/** The accessible name of each field; pass translated ones. */
export const DEFAULT_DURATION_PART_LABELS: DurationPartLabels = {
  hours: 'Hours',
  minutes: 'Minutes',
  seconds: 'Seconds',
}

const PART_UNITS = ['hours', 'minutes', 'seconds'] as const

export interface DurationPartsInputProps {
  /** The duration, in seconds. */
  readonly seconds: number
  readonly onChange: (seconds: number) => void
  /** Bounds in seconds; outside them the fields are marked, the number is still emitted. */
  readonly min?: number
  readonly max?: number
  /** The seconds field takes a fraction (a half-second wait). */
  readonly fractionalSeconds?: boolean
  readonly labels?: DurationPartLabels
  readonly disabled?: boolean
  /** Names the three fields as one group. */
  readonly 'aria-label'?: string
  /** `<prefix>-hours`, `<prefix>-minutes`, `<prefix>-seconds`. */
  readonly testIdPrefix?: string
  readonly className?: string
}

export function DurationPartsInput({
  seconds,
  fractionalSeconds = false,
  labels = DEFAULT_DURATION_PART_LABELS,
  ...rest
}: DurationPartsInputProps): ReactNode {
  return (
    <DurationInput
      {...rest}
      value={seconds}
      storageUnit="s"
      units={PART_UNITS}
      fractional={fractionalSeconds}
      labels={labels}
    />
  )
}
