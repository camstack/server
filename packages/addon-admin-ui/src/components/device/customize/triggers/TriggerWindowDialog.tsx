/**
 * When a linked trigger may run: the template editor's own time-window control and the
 * device-state control (a derived night), each off = always. The limit belongs to the whole automation, so it is the same
 * for every source of it.
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

export interface TriggerWindowDialogProps {
  readonly deviceName: string
  readonly window: TemplateTimeWindowValue | null
  readonly state: TemplateDeviceStateValue | null
  readonly busy: boolean
  readonly onSave: (
    window: TemplateTimeWindowValue | null,
    state: TemplateDeviceStateValue | null,
  ) => void
  readonly onClose: () => void
}

export function TriggerWindowDialog({
  deviceName,
  window,
  state,
  busy,
  onSave,
  onClose,
}: TriggerWindowDialogProps): ReactNode {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<TemplateTimeWindowValue | null>(window)
  const [stateDraft, setStateDraft] = useState<TemplateDeviceStateValue | null>(state)
  const title = t('customize.triggers.windowTitle', { name: deviceName })
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          <TimeWindowControl
            testId="trigger-window"
            value={draft ?? undefined}
            disabled={busy}
            onChange={(next) => {
              const parsed = TemplateTimeWindowValueSchema.safeParse(next)
              setDraft(parsed.success ? parsed.data : null)
            }}
          />
          <p className="text-xs text-foreground-subtle">{t('build.templates.deviceState.only')}</p>
          <DeviceStateControl
            testId="trigger-state"
            value={stateDraft ?? undefined}
            disabled={busy}
            onChange={(next) => {
              const parsed = TemplateDeviceStateValueSchema.safeParse(next)
              setStateDraft(parsed.success ? parsed.data : null)
            }}
          />
          <p className="text-xs text-foreground-subtle">{t('customize.triggers.windowShared')}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={busy} onClick={() => onSave(draft, stateDraft)}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
