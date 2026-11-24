/**
 * The condition fields of the one trigger dialog: which events and parts of the
 * source device fire it, or which detected classes of a camera. The event and part
 * choices are the device's own vocabulary (its `event-emitter` slice); until that
 * read answers nothing is offered, so an unanswered device never looks like one
 * with no events.
 */
import { ToggleChipRow, useDeviceStateGetCapSlice } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  EVENT_EMITTER_CAP,
  firedEvents,
  firedSources,
  firedVocabularyOf,
} from '../../../../pages/build/automation/fired-model'
import {
  chipIds,
  chipsOff,
  DETECTION_CLASSES,
  type DetectionClass,
  type FiredPick,
  pickedOf,
} from './linked-triggers-model'

export interface FiredFieldsProps {
  readonly deviceId: number
  readonly pick: FiredPick
  readonly onChange: (pick: FiredPick) => void
}

export function FiredFields({ deviceId, pick, onChange }: FiredFieldsProps): ReactNode {
  const { t } = useTranslation()
  const query = useDeviceStateGetCapSlice({
    deviceId,
    capName: EVENT_EMITTER_CAP,
  })
  const state = firedVocabularyOf({ status: query.status, data: query.data })
  const vocabulary = state.kind === 'known' ? state.vocabulary : []
  const parts = firedSources(vocabulary)
  const events = firedEvents(vocabulary, undefined)
  const partIds = chipIds(
    parts.map((p) => p.id),
    pick.parts,
  )
  const eventIds = chipIds(
    events.map((e) => e.id),
    pick.events,
  )
  const partLabel = new Map(parts.map((p) => [p.id, p.label]))
  const eventLabel = new Map(events.map((e) => [e.id, e.label]))
  return (
    <>
      {state.kind !== 'known' && (
        <p
          role={state.kind === 'unknown' ? 'alert' : 'status'}
          className={`text-xs ${state.kind === 'unknown' ? 'text-warning' : 'text-foreground-subtle'}`}
        >
          {state.kind === 'pending' ? t('automation.fired.loading') : t('automation.fired.unknown')}
        </p>
      )}
      {eventIds.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-foreground-muted">{t('customize.triggers.events')}</span>
          <ToggleChipRow
            chips={eventIds.map((id) => ({
              id,
              label: eventLabel.get(id) ?? id,
            }))}
            off={chipsOff(eventIds, pick.events)}
            allLabel={t('customize.triggers.anyEvent')}
            ariaLabel={t('customize.triggers.events')}
            onChange={(off) => {
              const next = pickedOf(eventIds, off)
              if (next !== null) onChange({ ...pick, events: next })
            }}
          />
        </div>
      )}
      {partIds.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-foreground-muted">{t('customize.triggers.parts')}</span>
          <ToggleChipRow
            chips={partIds.map((id) => ({
              id,
              label: partLabel.get(id) ?? id,
            }))}
            off={chipsOff(partIds, pick.parts)}
            allLabel={t('customize.triggers.anyPart')}
            ariaLabel={t('customize.triggers.parts')}
            onChange={(off) => {
              const next = pickedOf(partIds, off)
              if (next !== null) onChange({ ...pick, parts: next })
            }}
          />
        </div>
      )}
    </>
  )
}

export interface ClassFieldsProps {
  readonly classes: readonly DetectionClass[]
  readonly onChange: (classes: readonly DetectionClass[]) => void
}

/** Which detected classes of a camera fire the trigger. At least one stays on. */
export function ClassFields({ classes, onChange }: ClassFieldsProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-foreground-muted">{t('customize.triggers.classesLabel')}</span>
      <ToggleChipRow
        chips={DETECTION_CLASSES.map((id) => ({
          id,
          label: t(`customize.triggers.classes.${id}`),
        }))}
        off={new Set(DETECTION_CLASSES.filter((id) => !classes.includes(id)))}
        allLabel={t('customize.triggers.anyClass')}
        ariaLabel={t('customize.triggers.classesLabel')}
        onChange={(off) => {
          const next = DETECTION_CLASSES.filter((id) => !off.has(id))
          if (next.length > 0) onChange(next)
        }}
      />
    </div>
  )
}
