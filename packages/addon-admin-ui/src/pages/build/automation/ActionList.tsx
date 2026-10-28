/**
 * THEN — the ordered half.
 *
 * Unlike triggers (ANY-of, unordered) and conditions (a boolean tree), actions
 * are a SEQUENCE, and the vertical axis is the order they run in. That is why
 * these are the only rows with move controls, and why the numbering is shown:
 * an operator reading "wait 5s" has to be able to see what it is waiting
 * between.
 *
 * The runner stops at the first failed step. That is worth saying on screen
 * rather than only in the generated comment — a half-run sequence is a state an
 * operator has to be able to reason about after the fact.
 *
 * `{$var}` targets exist because an automation's whole point can be "sound the
 * siren of the camera that saw the person", and a literal device id cannot say
 * that. The var is resolved from the run's bag BEFORE the action runs, so what
 * is dispatched is always a number.
 *
 * Cap steps use the shared Device→Action picker (same block as NC Sequences).
 */

import type { AutomationAction } from '@camstack/types'
import { Badge, Button, Input, Select, type DeviceListState } from '@camstack/ui-library'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { CommandStep } from '../flow/CommandStep'
import { toneBorderClass } from '../flow/RunsPanel'
import type { BlockTone } from '../flow/trace-view'
import type { ScopeVariable } from '../flow/ArgField'
import { type AutomationDevice } from './automation-data'
import { PickerLabel } from './FieldPicker'
import { RunActionFields } from './RunActionFields'
import { type ActionKind, moveItem, newAction, removeAt, replaceAt } from './recipe-parts'
import { Trans, useTranslation } from 'react-i18next'

const ACTION_KINDS: readonly { readonly value: ActionKind; readonly labelKey: string }[] = [
  { value: 'cap', labelKey: 'automation.actionList.kindCap' },
  { value: 'action', labelKey: 'automation.actionList.kindAction' },
  { value: 'wait', labelKey: 'automation.actionList.kindWait' },
  { value: 'code', labelKey: 'automation.actionList.kindCode' },
]

export interface ActionListProps {
  readonly actions: readonly AutomationAction[]
  readonly devices: readonly AutomationDevice[]
  readonly devicesState?: DeviceListState
  /** Which step kinds the operator may add or switch to. Default: all. */
  readonly allowedKinds?: readonly ActionKind[]
  /** Variables an argument may name (`{x}`). */
  readonly variables?: readonly ScopeVariable[]
  /** The selected run's outcome per step, by index; steps it did not reach are idle. */
  readonly stepTones?: readonly BlockTone[]
  readonly onChange: (next: readonly AutomationAction[]) => void
}

export function ActionList({
  actions,
  devices,
  devicesState = 'answered',
  allowedKinds,
  variables = [],
  stepTones,
  onChange,
}: ActionListProps) {
  const { t } = useTranslation()
  const kinds = ACTION_KINDS.filter(
    (k) => allowedKinds === undefined || allowedKinds.includes(k.value),
  )
  return (
    <div className="space-y-2">
      {actions.length === 0 && (
        <p className="text-xs text-warning">
          {t(
            'automation.actionList.noActionsYetAnAutomation',
            'No actions yet. An automation that does nothing is not an automation.',
          )}
        </p>
      )}

      {actions.map((action, index) => (
        <div
          key={`${action.kind}-${String(index)}`}
          className={`space-y-2 rounded border p-3 ${
            stepTones === undefined ? 'border-border' : toneBorderClass(stepTones[index] ?? 'idle')
          }`}
        >
          <div className="flex flex-wrap items-end gap-2">
            <Badge variant="default">{index + 1}</Badge>
            <label className="w-40">
              <PickerLabel>{t('automation.actionList.step', 'Step')}</PickerLabel>
              <Select
                value={action.kind}
                onChange={(e) =>
                  onChange(replaceAt(actions, index, newAction(asKind(e.target.value))))
                }
                options={kinds.map((k) => ({ value: k.value, label: t(k.labelKey) }))}
              />
            </label>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                disabled={index === 0}
                onClick={() => onChange(moveItem(actions, index, index - 1))}
                title={t('automation.actionList.runThisStepEarlier', 'Run this step earlier')}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                disabled={index === actions.length - 1}
                onClick={() => onChange(moveItem(actions, index, index + 1))}
                title={t('automation.actionList.runThisStepLater', 'Run this step later')}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                onClick={() => onChange(removeAt(actions, index))}
                title={t('automation.actionList.removeThisStep', 'Remove this step')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {action.kind === 'wait' && (
            <label className="block w-32">
              <PickerLabel>{t('automation.actionList.seconds', 'Seconds')}</PickerLabel>
              <Input
                type="number"
                min={0}
                max={300}
                value={String(action.seconds)}
                onChange={(e) =>
                  onChange(
                    replaceAt(actions, index, { kind: 'wait', seconds: Number(e.target.value) }),
                  )
                }
              />
            </label>
          )}

          {action.kind === 'code' && (
            <label className="block">
              <PickerLabel>{t('automation.actionList.code', 'Code')}</PickerLabel>
              <textarea
                className="h-32 w-full rounded-md border border-border bg-surface p-2 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                value={action.code}
                spellCheck={false}
                onChange={(e) =>
                  onChange(replaceAt(actions, index, { kind: 'code', code: e.target.value }))
                }
              />
              <span className="mt-1 block text-xs text-foreground-subtle">
                <Trans i18nKey="automation.actionList.codeHint" components={{ code: <code /> }} />
              </span>
            </label>
          )}

          {action.kind === 'cap' && (
            <CommandStep
              step={action}
              devices={devices}
              devicesState={devicesState}
              variables={variables}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {action.kind === 'action' && (
            <RunActionFields
              step={action}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => onChange([...actions, newAction(kinds[0]?.value ?? 'cap')])}
        >
          <Plus className="h-4 w-4" /> {t('automation.actionList.addStep')}
        </Button>
        {actions.length > 1 && (
          <span className="text-xs text-foreground-subtle">
            {t(
              'automation.actionList.stepsRunInOrderAnd',
              'Steps run in order and stop at the first failure.',
            )}
          </span>
        )}
      </div>
    </div>
  )
}

function asKind(value: string): ActionKind {
  const hit = ACTION_KINDS.find((k) => k.value === value)
  return hit?.value ?? 'cap'
}
