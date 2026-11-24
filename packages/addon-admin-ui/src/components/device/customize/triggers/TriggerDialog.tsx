/**
 * The one dialog "Triggered by" opens, to add a trigger and to edit one: the source
 * device through the common `SourceSelector`, then the conditions of that source (its
 * events and parts, or a camera's classes) and when the trigger may run (a time
 * window, and a device that must read a value). It owns a local draft and hands
 * the result to the section on Save; it writes nothing.
 */
import {
  type TemplateDeviceStateValue,
  TemplateDeviceStateValueSchema,
  type TemplateTimeWindowValue,
  TemplateTimeWindowValueSchema,
} from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DeviceStateControl,
  TimeWindowControl,
} from '../../../../pages/build/templates/TemplateInputsForm'
import type { AssignmentCandidate } from '../assignments/assignment-candidates'
import type { Known } from '../known'
import { SourceSelector } from '../source-selector/SourceSelector'
import { ClassFields, FiredFields } from './TriggerConditionFields'
import {
  type DetectionClass,
  type FiredPick,
  replacesFilter,
  type TriggerConditions,
  type TriggerFilter,
  type TriggerSourceKind,
} from './linked-triggers-model'

/** What an edit starts from: the stored source and its conditions. */
export interface TriggerDialogInitial {
  readonly deviceId: number
  readonly kind: TriggerSourceKind
  readonly filter: TriggerFilter
  readonly pick: FiredPick
  readonly classes: readonly DetectionClass[]
  readonly activeWindow: TemplateTimeWindowValue | null
  readonly activeWhen: TemplateDeviceStateValue | null
}

/**
 * What Save hands back. `fired` and `classes` are set only when the operator
 * changed them: an untouched condition stays exactly as stored, whatever shape it has.
 */
export interface TriggerDialogResult extends TriggerConditions {
  readonly deviceId: number
  readonly kind: TriggerSourceKind
}

export interface TriggerDialogProps {
  readonly title: string
  /** The devices that may be the source; on an edit it includes the current one. */
  readonly candidates: Known<readonly AssignmentCandidate[]>
  readonly kindOf: (deviceId: number) => TriggerSourceKind | null
  /** Null: a new trigger. */
  readonly initial: TriggerDialogInitial | null
  readonly busy: boolean
  readonly onSave: (result: TriggerDialogResult) => void
  readonly onClose: () => void
}

const NO_PICK: FiredPick = { events: [], parts: [] }
const DEFAULT_CLASSES: readonly DetectionClass[] = ['person']

export function TriggerDialog({
  title,
  candidates,
  kindOf,
  initial,
  busy,
  onSave,
  onClose,
}: TriggerDialogProps): ReactNode {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<readonly number[]>(
    initial === null ? [] : [initial.deviceId],
  )
  const [fired, setFired] = useState<FiredPick | null>(null)
  const [classes, setClasses] = useState<readonly DetectionClass[] | null>(null)
  const [activeWindow, setActiveWindow] = useState<TemplateTimeWindowValue | null>(
    initial?.activeWindow ?? null,
  )
  const [state, setState] = useState<TemplateDeviceStateValue | null>(initial?.activeWhen ?? null)
  const deviceId = picked[0] ?? null
  // The row's own source keeps its stored kind: the live lookup can be unanswered
  // (offline, removed, caps pending) and must not hide what is already stored.
  const kind =
    deviceId === null
      ? null
      : initial !== null && deviceId === initial.deviceId
        ? initial.kind
        : kindOf(deviceId)
  // A condition the stored source cannot carry over to another kind starts from "any".
  const sameKind = initial !== null && kind === initial.kind
  const firedShown = fired ?? (sameKind ? initial.pick : NO_PICK)
  const classesShown =
    classes ?? (sameKind && initial.classes.length > 0 ? initial.classes : DEFAULT_CLASSES)
  const replaces = sameKind && fired === null && replacesFilter(initial.filter)

  const pick = (ids: readonly number[]): void => {
    setPicked(ids)
    setFired(null)
    setClasses(null)
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          <SourceSelector
            kind="devices"
            selection="single"
            candidates={candidates}
            picked={picked}
            onPickedChange={pick}
            onChoose={(chosen) => pick(chosen.map((c) => c.deviceId))}
          />
          {deviceId !== null && (
            <div className="flex flex-col gap-3" data-testid="trigger-conditions">
              {kind === 'emitter' && (
                <>
                  {replaces && (
                    <p className="text-xs text-foreground-subtle">
                      {t('customize.triggers.replacesNote')}
                    </p>
                  )}
                  <FiredFields
                    key={deviceId}
                    deviceId={deviceId}
                    pick={firedShown}
                    onChange={setFired}
                  />
                </>
              )}
              {kind === 'camera' && <ClassFields classes={classesShown} onChange={setClasses} />}
              {kind === 'motion' && (
                <p className="text-xs text-foreground-subtle">
                  {t('customize.triggers.motionDetected')}
                </p>
              )}
              <TimeWindowControl
                testId="trigger-window"
                value={activeWindow ?? undefined}
                disabled={busy}
                onChange={(next) => {
                  const parsed = TemplateTimeWindowValueSchema.safeParse(next)
                  setActiveWindow(parsed.success ? parsed.data : null)
                }}
              />
              <p className="text-xs text-foreground-subtle">
                {t('build.templates.deviceState.only')}
              </p>
              <DeviceStateControl
                testId="trigger-state"
                value={state ?? undefined}
                disabled={busy}
                onChange={(next) => {
                  const parsed = TemplateDeviceStateValueSchema.safeParse(next)
                  setState(parsed.success ? parsed.data : null)
                }}
              />
              <p className="text-xs text-foreground-subtle">
                {t('customize.triggers.windowShared')}
              </p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={busy || deviceId === null || kind === null}
            onClick={() => {
              if (deviceId === null || kind === null) return
              onSave({
                deviceId,
                kind,
                fired,
                classes,
                activeWindow,
                activeWhen: state,
              })
            }}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
