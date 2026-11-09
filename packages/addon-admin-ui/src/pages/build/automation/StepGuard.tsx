/**
 * The "If…" of one action step (#472): the SAME condition tree an automation
 * is gated by (`WhenTree`), read when the step is reached, plus an optional
 * Else list that runs when the condition reads false. A state that cannot be
 * read runs neither side.
 */
import type { AutomationAction, AutomationRecipe, AutomationWhen } from '@camstack/types'
import { Switch, type DeviceListState } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { ScopeVariable } from '../flow/ArgField'
import { ActionList } from './ActionList'
import type { AutomationDevice } from './automation-data'
import { WhenTree } from './WhenTree'

/** A step that can carry an `if`: a wait or a cap step. */
export type GuardableStep = Extract<AutomationAction, { kind: 'wait' | 'cap' }>
type ElseStep = NonNullable<GuardableStep['else']>[number]

const EMPTY_TREE: AutomationWhen = { kind: 'all', children: [] }

function isElseStep(action: AutomationAction): action is ElseStep {
  return action.kind === 'wait' || action.kind === 'cap'
}

export interface StepGuardProps {
  readonly step: GuardableStep
  readonly devices: readonly AutomationDevice[]
  readonly devicesState?: DeviceListState
  readonly variables?: readonly ScopeVariable[]
  readonly onChange: (next: GuardableStep) => void
}

function withoutGuard(step: GuardableStep): GuardableStep {
  const { if: _if, else: _else, ...rest } = step
  return rest
}

export function StepGuard({ step, devices, devicesState, variables, onChange }: StepGuardProps) {
  const { t } = useTranslation()
  const when = step.if
  const recipe: AutomationRecipe | null = when === undefined ? null : { when, actions: [] }
  return (
    <div className="space-y-2 border-t border-border-subtle pt-2">
      <Switch
        checked={when !== undefined}
        label={t('automation.stepGuard.if', 'Only if…')}
        aria-label={t('automation.stepGuard.if', 'Only if…')}
        onCheckedChange={(on) => onChange(on ? { ...step, if: EMPTY_TREE } : withoutGuard(step))}
      />
      {recipe !== null && (
        <>
          <p className="text-xs text-foreground-subtle">
            {t(
              'automation.stepGuard.hint',
              'Checked when this step is reached. If a state cannot be read, the step and its else are both skipped.',
            )}
          </p>
          <WhenTree
            recipe={recipe}
            devices={devices}
            onChange={(next) => onChange({ ...step, if: next.when })}
          />
          <Switch
            checked={step.else !== undefined}
            label={t('automation.stepGuard.else', 'Otherwise, run…')}
            aria-label={t('automation.stepGuard.else', 'Otherwise, run…')}
            onCheckedChange={(on) => {
              if (on) onChange({ ...step, else: [] })
              else {
                const { else: _else, ...rest } = step
                onChange(rest)
              }
            }}
          />
          {step.else !== undefined && (
            <div className="border-l-2 border-border-subtle pl-3">
              <ActionList
                nested
                actions={step.else}
                devices={devices}
                {...(devicesState === undefined ? {} : { devicesState })}
                {...(variables === undefined ? {} : { variables })}
                allowedKinds={['cap', 'wait']}
                onChange={(next) => onChange({ ...step, else: next.filter(isElseStep) })}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
