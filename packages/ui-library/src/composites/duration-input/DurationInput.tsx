/**
 * THE duration input: a duration as one number field per unit — hours,
 * minutes, seconds, milliseconds — in any subset the caller shows. The caller
 * also names the unit the value is STORED in (`ms`, `s` or `min`), so the form
 * never converts. Typing in one field keeps the others and emits the new
 * total; a field shows what was typed until it is left, then the total is
 * written the tidy way (90 minutes reads 1 h 30 min).
 *
 * Nothing is clamped: a duration outside `min` / `max` (storage unit) is
 * emitted and every field is marked, so the caller's own check says why.
 *
 * A duration that may be unset (`optional`): `value` may be `undefined`, the
 * fields then show empty (with the `placeholder` duration as a hint), and
 * clearing every field emits `undefined`.
 *
 * `deferred`: for a surface that acts on the value when it is set (a live
 * panel), `onChange` fires once, when focus leaves the whole group, instead of
 * on every keystroke — a half-typed "4" of "45" never reaches the caller,
 * and a group emptied to be retyped commits nothing (an empty box is not 0).
 *
 * The accessible name of each unit field is translated by the host
 * (`uiLibrary.duration.*`); `labels` overrides it.
 */
import { type FocusEvent, type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text.js'
import { Input } from '../../primitives/input.js'
import {
  type DurationStorageUnit,
  type DurationUnit,
  type DurationUnitValues,
  joinDuration,
  orderDurationUnits,
  splitDuration,
} from './duration-parts.js'

export type DurationUnitLabels = Readonly<Record<DurationUnit, string>>

/** The English names of the unit fields, when no host translates them. */
export const DEFAULT_DURATION_UNIT_LABELS: DurationUnitLabels = {
  hours: 'Hours',
  minutes: 'Minutes',
  seconds: 'Seconds',
  millis: 'Milliseconds',
}

/** Unit symbols: the same in every language the UI ships. */
const SUFFIX: DurationUnitLabels = { hours: 'h', minutes: 'min', seconds: 's', millis: 'ms' }

const DEFAULT_UNITS: readonly DurationUnit[] = ['hours', 'minutes', 'seconds']

interface UnitDraft {
  readonly unit: DurationUnit
  readonly text: string
}

interface DurationInputBaseProps {
  /** The unit `value`, `min`, `max` and `placeholder` are in. Default seconds. */
  readonly storageUnit?: DurationStorageUnit
  /** The fields shown; default hours, minutes, seconds. */
  readonly units?: readonly DurationUnit[]
  /** Bounds in `storageUnit`; outside them the fields are marked, the number is still emitted. */
  readonly min?: number
  readonly max?: number
  /** The smallest shown unit takes a fraction (a half-second wait). */
  readonly fractional?: boolean
  readonly labels?: Partial<DurationUnitLabels>
  readonly disabled?: boolean
  /** Emit once when focus leaves the group, not on every keystroke. */
  readonly deferred?: boolean
  /** Names the fields as one group. */
  readonly 'aria-label'?: string
  /** `<prefix>-hours`, `<prefix>-minutes`, `<prefix>-seconds`, `<prefix>-millis`. */
  readonly testIdPrefix?: string
  readonly className?: string
}

export interface RequiredDurationInputProps extends DurationInputBaseProps {
  readonly optional?: false
  /** The duration, in `storageUnit`. */
  readonly value: number
  readonly onChange: (value: number) => void
}

export interface OptionalDurationInputProps extends DurationInputBaseProps {
  readonly optional: true
  /** The duration, in `storageUnit`; `undefined` is "not set". */
  readonly value: number | undefined
  /** `undefined` when every field was cleared. */
  readonly onChange: (value: number | undefined) => void
  /** What an unset duration stands for, in `storageUnit`; shown in the empty fields. */
  readonly placeholder?: number
}

export type DurationInputProps = RequiredDurationInputProps | OptionalDurationInputProps

export function DurationInput(props: DurationInputProps): ReactNode {
  const {
    storageUnit = 's',
    units = DEFAULT_UNITS,
    min,
    max,
    fractional = false,
    labels,
    disabled = false,
    deferred = false,
    'aria-label': ariaLabel,
    testIdPrefix,
    className,
  } = props
  const t = useUiText()
  const [draft, setDraft] = useState<UnitDraft | null>(null)
  // Deferred only: what was typed and has not been emitted yet (`null` = "cleared", `undefined` = nothing typed).
  const [pending, setPending] = useState<number | null | undefined>(undefined)
  // Deferred only: every box was emptied, so there is nothing to commit (an empty box is not "0").
  const [blank, setBlank] = useState(false)
  const visible = orderDurationUnits(units)
  const smallest = visible[visible.length - 1]
  const shownValue = pending === undefined ? props.value : (pending ?? undefined)
  const unset = props.optional === true && shownValue === undefined
  const value = shownValue ?? 0
  const parts = splitDuration(value, storageUnit, visible)
  const hint =
    props.optional === true && props.placeholder !== undefined
      ? splitDuration(props.placeholder, storageUnit, visible)
      : undefined
  const invalid =
    !unset && ((min !== undefined && value < min) || (max !== undefined && value > max))

  const nameOf = (unit: DurationUnit): string =>
    labels?.[unit] ?? t(`uiLibrary.duration.${unit}`, DEFAULT_DURATION_UNIT_LABELS[unit])

  const type = (unit: DurationUnit, text: string): void => {
    const empty = text.trim() === ''
    const typed = empty ? 0 : Number(text)
    const whole = unit !== smallest || !fractional
    setDraft({ unit, text })
    if (!Number.isFinite(typed) || typed < 0 || (whole && !Number.isInteger(typed))) return
    const next: DurationUnitValues = { ...parts, [unit]: typed }
    const total = joinDuration(next, storageUnit)
    const cleared = props.optional === true && empty && total === 0
    // A deferred group emptied on the way to retyping commits nothing: an empty box is not "0".
    if (deferred) {
      setBlank(empty && total === 0 && !cleared)
      setPending(cleared ? null : total)
    } else emit(cleared ? undefined : total)
  }

  const emit = (total: number | undefined): void => {
    if (props.optional === true) props.onChange(total)
    else if (total !== undefined) props.onChange(total)
  }

  const flush = (event: FocusEvent<HTMLFieldSetElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return
    setDraft(null)
    if (!deferred || pending === undefined) return
    setPending(undefined)
    if (blank) {
      setBlank(false)
      return
    }
    emit(pending ?? undefined)
  }

  const shown = (unit: DurationUnit): string => {
    if (draft?.unit === unit) return draft.text
    return unset ? '' : String(parts[unit] ?? 0)
  }

  return (
    <fieldset
      aria-label={ariaLabel}
      disabled={disabled}
      onBlur={flush}
      className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ''}`}
    >
      {visible.map((unit) => {
        const takesFraction = unit === smallest && fractional
        return (
          <span key={unit} className="inline-flex items-center gap-1">
            <Input
              type="number"
              inputMode={takesFraction ? 'decimal' : 'numeric'}
              min={0}
              step={takesFraction ? 'any' : 1}
              className={unit === 'millis' ? 'w-20' : 'w-14'}
              aria-label={nameOf(unit)}
              aria-invalid={invalid}
              state={invalid ? 'error' : 'default'}
              disabled={disabled}
              placeholder={unset && hint !== undefined ? String(hint[unit] ?? 0) : undefined}
              data-testid={testIdPrefix === undefined ? undefined : `${testIdPrefix}-${unit}`}
              value={shown(unit)}
              onChange={(event) => type(unit, event.target.value)}
            />
            <span className="text-xs text-foreground-subtle">{SUFFIX[unit]}</span>
          </span>
        )
      })}
    </fieldset>
  )
}
