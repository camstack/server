/** One assignment card (spec §5) in the tab's {@link CustomizeCard}: header (icon, title, header control, "+ Add"), notices, rows. */
import { Button } from '@camstack/ui-library'
import { type LucideIcon, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssignmentAvailability } from '../assignment-availability'
import { CustomizeCard } from '../CustomizeCard'

export interface AssignmentSectionProps {
  readonly id: string
  readonly icon?: LucideIcon
  readonly title: string
  /** A control in the header (the doorbell's on/off). */
  readonly headerControl?: ReactNode
  readonly addLabel?: string
  /** Absent = no "+ Add" (nothing can be added yet: unread, single and full). */
  readonly onAdd?: () => void
  /** "+ Add" stays visible but cannot be used (a write is settling). */
  readonly addDisabled?: boolean
  /** One-line states (checking, unreadable, not forwarded, a refusal). */
  readonly notices?: ReactNode
  /**
   * The room's suggestions for this card (D749): "N suggested · <room>" beside
   * "+ Add", opening the picker on them. Drawn only while something can be added.
   */
  readonly suggestion?: CardSuggestion
  readonly children: ReactNode
}

export interface CardSuggestion {
  readonly count: number
  readonly location: string
  readonly onOpen: () => void
}

export function AssignmentSection({
  id,
  icon,
  title,
  headerControl,
  addLabel,
  onAdd,
  addDisabled = false,
  notices,
  suggestion,
  children,
}: AssignmentSectionProps): ReactNode {
  const { t } = useTranslation()
  const canAdd = onAdd !== undefined && addLabel !== undefined
  const suggests = canAdd && !addDisabled && suggestion !== undefined && suggestion.count > 0
  return (
    <CustomizeCard
      id={id}
      icon={icon}
      title={title}
      actions={
        <>
          {headerControl}
          {suggests && (
            <Button variant="ghost" size="sm" onClick={suggestion.onOpen}>
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {t('customize.suggest.hint', {
                count: suggestion.count,
                location: suggestion.location,
              })}
            </Button>
          )}
          {canAdd && (
            <Button variant="outline" size="sm" disabled={addDisabled} onClick={onAdd}>
              {addLabel}
            </Button>
          )}
        </>
      }
    >
      {notices !== undefined && (
        <div className="flex flex-col gap-1 px-3 pt-2 empty:hidden sm:px-4">{notices}</div>
      )}
      <ul className="flex flex-col divide-y divide-border">{children}</ul>
    </CustomizeCard>
  )
}

export interface AvailabilityNoticeProps {
  readonly availability: AssignmentAvailability
}

/** pending → one "Checking…" line; unknown → the reason; present/absent → nothing. */
export function AvailabilityNotice({ availability }: AvailabilityNoticeProps): ReactNode {
  const { t } = useTranslation()
  if (availability.kind === 'pending') {
    return (
      <p role="status" className="text-xs text-foreground-subtle">
        {t('customize.assign.checking')}
      </p>
    )
  }
  if (availability.kind === 'unknown') {
    return (
      <p role="alert" className="text-xs text-warning">
        {t('customize.assign.unknown', { reason: availability.reason })}
      </p>
    )
  }
  return null
}
