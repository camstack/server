/**
 * The fields of a `wait-until` step: the condition the run waits for, how
 * long at most, and what a wait that ran out does.
 */
import type { AutomationRecipe, AutomationWaitUntilStep } from '@camstack/types'
import { ErrorBox, Input, Select } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from './automation-data'
import { PickerLabel } from './FieldPicker'
import { guardProblem } from './StepGuard'
import { WhenTree } from './WhenTree'
import { isTimeoutUnit, joinTimeout, splitTimeout, TIMEOUT_UNITS } from './wait-until-model'

export interface WaitUntilFieldsProps {
  /** The step's position in its list, for the test ids. */
  readonly index: number
  readonly step: AutomationWaitUntilStep
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationWaitUntilStep) => void
}

export function WaitUntilFields({ index, step, devices, onChange }: WaitUntilFieldsProps) {
  const { t } = useTranslation()
  const recipe: AutomationRecipe = { when: step.when, actions: [] }
  const problem = guardProblem(step.when)
  const timeout = splitTimeout(step.timeoutS)
  const unitLabel = {
    s: t('automation.waitUntil.unitSeconds', 'seconds'),
    min: t('automation.waitUntil.unitMinutes', 'minutes'),
    h: t('automation.waitUntil.unitHours', 'hours'),
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground-subtle">
        {t(
          'automation.waitUntil.hint',
          'The run pauses here until this is true. A value that cannot be read is not "true": the run keeps waiting.',
        )}
      </p>
      <WhenTree
        hideRule
        context="guard"
        recipe={recipe}
        devices={devices}
        onChange={(next) => onChange({ ...step, when: next.when })}
      />
      {problem !== null && <ErrorBox variant="warning" message={problem} />}
      <div className="flex flex-wrap items-end gap-2">
        <label className="w-24">
          <PickerLabel>{t('automation.waitUntil.timeout', 'At most')}</PickerLabel>
          <Input
            type="number"
            min={1}
            data-testid={`wait-until-timeout-${String(index)}`}
            value={String(timeout.value)}
            onChange={(e) =>
              onChange({ ...step, timeoutS: joinTimeout(Number(e.target.value), timeout.unit) })
            }
          />
        </label>
        <div className="w-32">
          <Select
            data-testid={`wait-until-unit-${String(index)}`}
            aria-label={t('automation.waitUntil.unit', 'Unit')}
            value={timeout.unit}
            onChange={(e) =>
              onChange({
                ...step,
                timeoutS: joinTimeout(
                  timeout.value,
                  isTimeoutUnit(e.target.value) ? e.target.value : timeout.unit,
                ),
              })
            }
            options={TIMEOUT_UNITS.map((unit) => ({ value: unit, label: unitLabel[unit] }))}
          />
        </div>
        <label className="min-w-56 flex-1">
          <PickerLabel>
            {t('automation.waitUntil.onTimeout', 'If it does not happen in time')}
          </PickerLabel>
          <Select
            data-testid={`wait-until-on-timeout-${String(index)}`}
            value={step.onTimeout}
            onChange={(e) =>
              onChange({ ...step, onTimeout: e.target.value === 'stop' ? 'stop' : 'continue' })
            }
            options={[
              {
                value: 'continue',
                label: t('automation.waitUntil.continue', 'Go on with the next step'),
              },
              { value: 'stop', label: t('automation.waitUntil.stop', 'Stop the run as a failure') },
            ]}
          />
        </label>
      </div>
    </div>
  )
}
