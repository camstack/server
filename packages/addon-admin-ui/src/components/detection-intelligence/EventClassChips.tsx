/**
 * The classes present in the events window as on/off chips (person, vehicle,
 * animal …). Every chip starts on; switching one off hides that class from the
 * list AND from everything that draws the same list (the density bar).
 */
import { ToggleChipRow, type ToggleChip } from '@dominevo/ui-library'
import { useMemo, type JSX } from 'react'
import { useTranslation } from 'react-i18next'

export interface EventClassChipsProps {
  /** Every row's class in the window, before this filter (duplicates allowed). */
  readonly classes: readonly string[]
  readonly hidden: ReadonlySet<string>
  readonly onChange: (hidden: ReadonlySet<string>) => void
}

/** Distinct classes, most frequent first, then by name. */
export function presentClasses(classes: readonly string[]): readonly string[] {
  const counts = new Map<string, number>()
  for (const c of classes) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c)
}

export function EventClassChips({
  classes,
  hidden,
  onChange,
}: EventClassChipsProps): JSX.Element | null {
  const { t } = useTranslation()
  const chips = useMemo<readonly ToggleChip[]>(
    () => presentClasses(classes).map((c) => ({ id: c, label: c })),
    [classes],
  )
  if (chips.length < 2) return null
  return (
    <ToggleChipRow
      chips={chips}
      off={hidden}
      onChange={onChange}
      allLabel={t('detectionIntelligence.eventClassChips.all', 'All classes')}
      ariaLabel={t('detectionIntelligence.eventClassChips.label', 'Classes')}
      testId="event-class-chips"
    />
  )
}
