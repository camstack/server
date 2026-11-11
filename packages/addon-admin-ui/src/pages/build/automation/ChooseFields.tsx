/**
 * The fields of a `choose` step: branches read top to bottom (the first whose
 * condition is true runs) and an optional "otherwise" list. A branch holds
 * plain steps only, so the nesting stops here.
 */
import type { AutomationChooseStep, AutomationRecipe } from '@camstack/types'
import { Button, type DeviceListState, ErrorBox, Switch } from '@camstack/ui-library'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ScopeVariable } from '../flow/ArgField'
import { ActionList } from './ActionList'
import type { AutomationDevice } from './automation-data'
import {
  addBranch,
  BRANCH_KINDS,
  canAddBranch,
  canRemoveBranch,
  isBranchStep,
  removeBranch,
  replaceBranch,
  setElse,
} from './choose-model'
import { PickerLabel } from './FieldPicker'
import { guardProblem } from './StepGuard'
import { WhenTree } from './WhenTree'

export interface ChooseFieldsProps {
  /** The step's position in its list, for the test ids. */
  readonly index: number
  readonly step: AutomationChooseStep
  readonly devices: readonly AutomationDevice[]
  readonly devicesState?: DeviceListState
  readonly variables?: readonly ScopeVariable[]
  readonly onChange: (next: AutomationChooseStep) => void
}

export function ChooseFields({
  index,
  step,
  devices,
  devicesState,
  variables,
  onChange,
}: ChooseFieldsProps) {
  const { t } = useTranslation()
  const listProps = {
    nested: true,
    flowControl: true,
    devices,
    allowedKinds: BRANCH_KINDS,
    ...(devicesState === undefined ? {} : { devicesState }),
    ...(variables === undefined ? {} : { variables }),
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-subtle">
        {t(
          'automation.choose.hint',
          'Read top to bottom: the first branch whose condition is true runs, and only that one. If a condition cannot be read, nothing runs.',
        )}
      </p>
      {step.branches.map((branch, at) => {
        const recipe: AutomationRecipe = { when: branch.if, actions: [] }
        const problem = guardProblem(branch.if)
        return (
          <div
            key={String(at)}
            className="space-y-2 border-l-2 border-border-subtle pl-3"
            data-testid={`choose-branch-${String(index)}-${String(at)}`}
          >
            <div className="flex items-center gap-2">
              <PickerLabel>
                {at === 0
                  ? t('automation.choose.if', 'If')
                  : t('automation.choose.elseIf', 'Otherwise, if')}
              </PickerLabel>
              <Button
                variant="ghost"
                className="ml-auto"
                disabled={!canRemoveBranch(step)}
                data-testid={`choose-remove-${String(index)}-${String(at)}`}
                onClick={() => onChange(removeBranch(step, at))}
                title={
                  canRemoveBranch(step)
                    ? t('automation.choose.removeBranch', 'Remove this branch')
                    : t('automation.choose.lastBranch', 'A choose keeps at least one branch')
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <WhenTree
              hideRule
              context="guard"
              recipe={recipe}
              devices={devices}
              onChange={(next) => onChange(replaceBranch(step, at, { ...branch, if: next.when }))}
            />
            {problem !== null && <ErrorBox variant="warning" message={problem} />}
            <PickerLabel>{t('automation.choose.then', 'Then run')}</PickerLabel>
            <ActionList
              {...listProps}
              actions={branch.steps}
              onChange={(next) =>
                onChange(replaceBranch(step, at, { ...branch, steps: next.filter(isBranchStep) }))
              }
            />
          </div>
        )
      })}
      <Button
        variant="outline"
        data-testid={`choose-add-${String(index)}`}
        disabled={!canAddBranch(step)}
        onClick={() => onChange(addBranch(step))}
        title={
          canAddBranch(step)
            ? undefined
            : t('automation.choose.maxBranches', 'A choose takes at most 6 branches')
        }
      >
        <Plus className="h-4 w-4" /> {t('automation.choose.addBranch', 'Add a branch')}
      </Button>
      <Switch
        data-testid={`choose-else-${String(index)}`}
        checked={step.else !== undefined}
        label={t('automation.choose.else', 'Otherwise, run…')}
        aria-label={t('automation.choose.else', 'Otherwise, run…')}
        onCheckedChange={(on) => onChange(setElse(step, on ? [] : undefined))}
      />
      {step.else !== undefined && (
        <div className="border-l-2 border-border-subtle pl-3">
          <ActionList
            {...listProps}
            actions={step.else}
            onChange={(next) => onChange(setElse(step, next.filter(isBranchStep)))}
          />
        </div>
      )}
    </div>
  )
}
