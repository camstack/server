/**
 * "Only when" — the state tree a scheduler or a profile carries as
 * `activeWhen`. The same WhenTree the automation editor uses; the save check
 * (`SchedulerStateTreeSchema`) is what refuses an event leaf, with its reason.
 */
import type { AutomationRecipe, AutomationWhen } from '@camstack/types'
import { Switch } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from '../automation/automation-data'
import { WhenTree } from '../automation/WhenTree'

export interface ActiveWhenFieldProps {
  readonly value: AutomationWhen | undefined
  readonly devices: readonly AutomationDevice[]
  readonly label: string
  readonly onChange: (next: AutomationWhen | undefined) => void
}

const EMPTY_TREE: AutomationWhen = { kind: 'all', children: [] }

export function ActiveWhenField({ value, devices, label, onChange }: ActiveWhenFieldProps) {
  const { t } = useTranslation()
  const recipe: AutomationRecipe | null = value === undefined ? null : { when: value, actions: [] }
  return (
    <div className="space-y-2">
      <Switch
        checked={value !== undefined}
        label={label}
        aria-label={label}
        onCheckedChange={(on) => onChange(on ? EMPTY_TREE : undefined)}
      />
      {recipe !== null && (
        <>
          <p className="text-xs text-foreground-subtle">
            {t(
              'schedulers.activeWhen.hint',
              'Only states count here, such as "someone is home". While they are false, nothing runs and holds pause.',
            )}
          </p>
          <WhenTree recipe={recipe} devices={devices} onChange={(next) => onChange(next.when)} />
        </>
      )}
    </div>
  )
}
