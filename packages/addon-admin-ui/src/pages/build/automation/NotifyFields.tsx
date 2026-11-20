/**
 * THEN → "Send notification": pick one of the notification targets (the same
 * ones the notification centre sends to) and write the title and message.
 * Both may carry `{{vars.x}}` slots, filled from the run's variables.
 */

import type { AutomationNotifyStep } from '@camstack/types'
import { Input, Select, Skeleton, Textarea } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { useNotificationTargets } from '../../system/use-notification-targets'
import { PickerLabel } from './FieldPicker'

export interface NotifyFieldsProps {
  readonly index: number
  readonly step: AutomationNotifyStep
  readonly onChange: (next: AutomationNotifyStep) => void
}

/** The step with `title` set, or without one when blank. */
function withTitle(step: AutomationNotifyStep, title: string): AutomationNotifyStep {
  const { title: _old, ...rest } = step
  return title === '' ? rest : { ...rest, title }
}

export function NotifyFields({ index, step, onChange }: NotifyFieldsProps) {
  const { t } = useTranslation()
  const targets = useNotificationTargets()
  // an unanswered read is not "no targets" (D315)
  if (targets.data === undefined) {
    return targets.isError ? (
      <p className="text-xs text-danger">
        {t('automation.notify.targetsError', 'The notification targets could not be read.')}
      </p>
    ) : (
      <Skeleton className="h-8 w-64" />
    )
  }
  const chosen = targets.data.find((target) => target.id === step.targetId)
  const stale = step.targetId !== '' && chosen === undefined
  return (
    <div className="space-y-2" data-testid={`notify-step-${String(index)}`}>
      <label className="block max-w-sm">
        <PickerLabel>{t('automation.notify.target', 'Send through')}</PickerLabel>
        <Select
          data-testid={`notify-target-${String(index)}`}
          value={step.targetId}
          onChange={(e) => onChange({ ...step, targetId: e.target.value })}
          options={[
            { value: '', label: t('automation.notify.pickTarget', 'Pick a target') },
            ...(stale
              ? [
                  {
                    value: step.targetId,
                    label: t('automation.notify.targetGone', '{{id}} (no longer exists)', {
                      id: step.targetId,
                    }),
                  },
                ]
              : []),
            ...targets.data.map((target) => ({
              value: target.id,
              label: target.enabled
                ? target.name
                : t('automation.notify.targetOff', '{{name}} (off)', { name: target.name }),
            })),
          ]}
        />
      </label>
      <label className="block">
        <PickerLabel>{t('automation.notify.title', 'Title (optional)')}</PickerLabel>
        <Input
          data-testid={`notify-title-${String(index)}`}
          value={step.title ?? ''}
          onChange={(e) => onChange(withTitle(step, e.target.value))}
        />
      </label>
      <label className="block">
        <PickerLabel>{t('automation.notify.body', 'Message')}</PickerLabel>
        <Textarea
          data-testid={`notify-body-${String(index)}`}
          value={step.body}
          onChange={(e) => onChange({ ...step, body: e.target.value })}
        />
        <span className="mt-1 block text-xs text-foreground-subtle">
          {t('automation.notify.hint', 'Use {{vars.name}} to put a value of the run in the text.')}
        </span>
      </label>
    </div>
  )
}
