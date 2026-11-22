/**
 * Which events and which parts of the source device fire a linked trigger.
 * The choices are the device's own vocabulary (its `event-emitter` slice);
 * until that read answers nothing is offered, so an unanswered device never
 * looks like one with no events.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ToggleChipRow,
  useDeviceStateGetCapSlice,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  EVENT_EMITTER_CAP,
  firedEvents,
  firedSources,
  firedVocabularyOf,
} from '../../../../pages/build/automation/fired-model'
import { chipIds, chipsOff, type FiredPick, pickedOf } from './linked-triggers-model'

export interface TriggerFilterDialogProps {
  readonly deviceId: number
  readonly deviceName: string
  readonly pick: FiredPick
  readonly busy: boolean
  readonly onSave: (pick: FiredPick) => void
  readonly onClose: () => void
}

export function TriggerFilterDialog({
  deviceId,
  deviceName,
  pick,
  busy,
  onSave,
  onClose,
}: TriggerFilterDialogProps): ReactNode {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<FiredPick>(pick)
  const query = useDeviceStateGetCapSlice({ deviceId, capName: EVENT_EMITTER_CAP })
  const state = firedVocabularyOf({ status: query.status, data: query.data })
  const vocabulary = state.kind === 'known' ? state.vocabulary : []
  const parts = firedSources(vocabulary)
  const events = firedEvents(vocabulary, undefined)
  const partIds = chipIds(
    parts.map((p) => p.id),
    draft.parts,
  )
  const eventIds = chipIds(
    events.map((e) => e.id),
    draft.events,
  )
  const partLabel = new Map(parts.map((p) => [p.id, p.label]))
  const eventLabel = new Map(events.map((e) => [e.id, e.label]))
  const title = t('customize.triggers.filterTitle', { name: deviceName })

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          {state.kind !== 'known' && (
            <p
              role={state.kind === 'unknown' ? 'alert' : 'status'}
              className={`text-xs ${state.kind === 'unknown' ? 'text-warning' : 'text-foreground-subtle'}`}
            >
              {state.kind === 'pending'
                ? t('automation.fired.loading')
                : t('automation.fired.unknown')}
            </p>
          )}
          {eventIds.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-foreground-muted">
                {t('customize.triggers.events')}
              </span>
              <ToggleChipRow
                chips={eventIds.map((id) => ({ id, label: eventLabel.get(id) ?? id }))}
                off={chipsOff(eventIds, draft.events)}
                allLabel={t('customize.triggers.anyEvent')}
                ariaLabel={t('customize.triggers.events')}
                onChange={(off) => {
                  const next = pickedOf(eventIds, off)
                  if (next !== null) setDraft({ ...draft, events: next })
                }}
              />
            </div>
          )}
          {partIds.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-foreground-muted">{t('customize.triggers.parts')}</span>
              <ToggleChipRow
                chips={partIds.map((id) => ({ id, label: partLabel.get(id) ?? id }))}
                off={chipsOff(partIds, draft.parts)}
                allLabel={t('customize.triggers.anyPart')}
                ariaLabel={t('customize.triggers.parts')}
                onChange={(off) => {
                  const next = pickedOf(partIds, off)
                  if (next !== null) setDraft({ ...draft, parts: next })
                }}
              />
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={busy} onClick={() => onSave(draft)}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
