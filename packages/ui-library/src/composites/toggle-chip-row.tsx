/**
 * ToggleChipRow — one horizontally scrolling row of on/off chips, the first
 * of which is "All". Every chip starts on; a tap flips it. "All" turns every
 * chip on, and turns them all off when they already are. The chips are the
 * same pills as the table filter bar's facets.
 */
import type { JSX } from 'react'
import { CHIP_OFF, CHIP_ON } from './data-table-filter-bar'

export interface ToggleChip {
  readonly id: string
  readonly label: string
}

export interface ToggleChipRowProps {
  readonly chips: readonly ToggleChip[]
  /** Ids that are switched OFF. Empty = all on. */
  readonly off: ReadonlySet<string>
  readonly onChange: (off: ReadonlySet<string>) => void
  readonly allLabel: string
  readonly ariaLabel: string
  readonly testId?: string
}

export function ToggleChipRow({
  chips,
  off,
  onChange,
  allLabel,
  ariaLabel,
  testId,
}: ToggleChipRowProps): JSX.Element {
  const allOn = chips.every((c) => !off.has(c.id))
  const toggle = (id: string): void => {
    const next = new Set(off)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      className="flex gap-1 overflow-x-auto pb-1"
    >
      <button // ui-check-ok: the filter bar's own pill chip (shared CHIP_ON/CHIP_OFF)
        type="button"
        aria-pressed={allOn}
        className={`shrink-0 ${allOn ? CHIP_ON : CHIP_OFF}`}
        onClick={() => onChange(allOn ? new Set(chips.map((c) => c.id)) : new Set())}
      >
        {allLabel}
      </button>
      {chips.map((chip) => {
        const on = !off.has(chip.id)
        return (
          <button // ui-check-ok: the filter bar's own pill chip (shared CHIP_ON/CHIP_OFF)
            key={chip.id}
            type="button"
            aria-pressed={on}
            className={`shrink-0 ${on ? CHIP_ON : CHIP_OFF}`}
            onClick={() => toggle(chip.id)}
          >
            {chip.label}
          </button>
        )
      })}
    </div>
  )
}
