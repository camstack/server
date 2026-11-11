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
import {
  Badge,
  Button,
  Input,
  Select,
  Switch,
  type DeviceListState,
  Textarea,
} from '@camstack/ui-library'
import { PARALLEL_STEPS_MAX, STOP_REASON_MAX, WAIT_MAX_SECONDS } from '@camstack/types'
import { Plus, Trash2 } from 'lucide-react'
import { CommandStep } from '../flow/CommandStep'
import { toneBorderClass } from '../flow/RunsPanel'
import { StepResult } from '../flow/TraceResult'
import type { BlockTone, StepDetailView } from '../flow/trace-view'
import type { ScopeVariable } from '../flow/ArgField'
import { type AutomationDevice } from './automation-data'
import { PickerLabel } from './FieldPicker'
import { RunActionFields } from './RunActionFields'
import { MoveButtons, type MoveTexts } from './MoveButtons'
import { type ActionKind, moveItem, newAction, removeAt, replaceAt } from './recipe-parts'
import { ChooseFields } from './ChooseFields'
import { isParallelMember, PARALLEL_KINDS } from './choose-model'
import { SetVarsFields } from './SetVarsFields'
import { RepeatFields } from './RepeatFields'
import { StepGuard, StepIf } from './StepGuard'
import { WaitUntilFields } from './WaitUntilFields'
import { Trans, useTranslation } from 'react-i18next'

const ACTION_KINDS: readonly { readonly value: ActionKind; readonly labelKey: string }[] = [
  { value: 'cap', labelKey: 'automation.actionList.kindCap' },
  { value: 'action', labelKey: 'automation.actionList.kindAction' },
  { value: 'wait', labelKey: 'automation.actionList.kindWait' },
  { value: 'wait-until', labelKey: 'automation.actionList.kindWaitUntil' },
  { value: 'set', labelKey: 'automation.actionList.kindSet' },
  { value: 'stop', labelKey: 'automation.actionList.kindStop' },
  { value: 'choose', labelKey: 'automation.actionList.kindChoose' },
  { value: 'parallel', labelKey: 'automation.actionList.kindParallel' },
  { value: 'repeat', labelKey: 'automation.actionList.kindRepeat' },
  { value: 'code', labelKey: 'automation.actionList.kindCode' },
]

/** The steps that only an automation's own list runs (#500). */
const FLOW_KINDS: readonly ActionKind[] = [
  'set',
  'stop',
  'choose',
  'wait-until',
  'parallel',
  'repeat',
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
  /** What the selected run recorded per step, by index; shown inside the card. */
  readonly stepResults?: readonly (StepDetailView | undefined)[]
  /** An else list or a branch of a choose: its steps carry no `if` of their own. */
  readonly nested?: boolean
  /**
   * The list is an AUTOMATION's: it offers the stop and set steps and "continue
   * if this fails". A standalone list (an action, a scheduler point) does not.
   */
  readonly flowControl?: boolean
  /** The most steps the list takes; the add button is disabled there. Default: no bound here. */
  readonly maxSteps?: number
  /**
   * The list is the body of a repeat that runs once for each device: these are
   * its devices, and a command step may be aimed at the device of the round.
   */
  readonly roundDevices?: readonly number[]
  /** How deep this list sits: 0 = the automation's own, 1 = a block step's, 2 = a block step's inside that. */
  readonly depth?: number
  readonly onChange: (next: readonly AutomationAction[]) => void
}

export function ActionList({
  actions,
  devices,
  devicesState = 'answered',
  allowedKinds,
  variables = [],
  stepTones,
  stepResults,
  nested = false,
  flowControl = false,
  maxSteps,
  roundDevices,
  depth = 0,
  onChange,
}: ActionListProps) {
  const { t } = useTranslation()
  const kinds = ACTION_KINDS.filter(
    (k) =>
      (allowedKinds === undefined || allowedKinds.includes(k.value)) &&
      (flowControl || !FLOW_KINDS.includes(k.value)),
  )
  const guardHint = t(
    'automation.actionList.flowGuardHint',
    'Checked when this step is reached. If it is false, or a state cannot be read, the step does nothing.',
  )
  const moveTexts: MoveTexts = {
    up: t('automation.actionList.runThisStepEarlier', 'Run this step earlier'),
    down: t('automation.actionList.runThisStepLater', 'Run this step later'),
    atFirst: t('automation.actionList.alreadyFirstStep', 'This step already runs first'),
    atLast: t('automation.actionList.alreadyLastStep', 'This step already runs last'),
  }
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
                data-testid={`step-kind-${String(index)}`}
                value={action.kind}
                onChange={(e) =>
                  onChange(replaceAt(actions, index, newAction(asKind(e.target.value))))
                }
                options={kinds.map((k) => ({ value: k.value, label: t(k.labelKey) }))}
              />
            </label>
            <div className="ml-auto flex items-center gap-1">
              <MoveButtons
                move={{
                  up: index === 0 ? null : () => onChange(moveItem(actions, index, index - 1)),
                  down:
                    index === actions.length - 1
                      ? null
                      : () => onChange(moveItem(actions, index, index + 1)),
                }}
                texts={moveTexts}
              />
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
                max={WAIT_MAX_SECONDS}
                value={String(action.seconds)}
                onChange={(e) =>
                  onChange(
                    replaceAt(actions, index, { ...action, seconds: Number(e.target.value) }),
                  )
                }
              />
            </label>
          )}

          {action.kind === 'stop' && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-48 flex-1">
                <PickerLabel>{t('automation.actionList.stopReason', 'Reason')}</PickerLabel>
                <Input
                  data-testid={`stop-reason-${String(index)}`}
                  value={action.reason}
                  maxLength={STOP_REASON_MAX}
                  onChange={(e) =>
                    onChange(replaceAt(actions, index, { ...action, reason: e.target.value }))
                  }
                />
              </label>
              <label className="w-48">
                <PickerLabel>
                  {t('automation.actionList.stopOutcome', 'The run ends as')}
                </PickerLabel>
                <Select
                  data-testid={`stop-outcome-${String(index)}`}
                  value={action.outcome}
                  onChange={(e) =>
                    onChange(
                      replaceAt(actions, index, {
                        ...action,
                        outcome: e.target.value === 'failed' ? 'failed' : 'ok',
                      }),
                    )
                  }
                  options={[
                    { value: 'ok', label: t('automation.actionList.stopOk', 'A success') },
                    { value: 'failed', label: t('automation.actionList.stopFailed', 'A failure') },
                  ]}
                />
              </label>
            </div>
          )}

          {action.kind === 'set' && (
            <SetVarsFields
              index={index}
              vars={action.vars}
              onChange={(vars) => onChange(replaceAt(actions, index, { ...action, vars }))}
            />
          )}

          {action.kind === 'wait-until' && (
            <WaitUntilFields
              index={index}
              step={action}
              devices={devices}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {action.kind === 'repeat' && (
            <RepeatFields
              index={index}
              step={action}
              devices={devices}
              devicesState={devicesState}
              variables={variables}
              depth={depth}
              {...(roundDevices === undefined ? {} : { roundDevices })}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {action.kind === 'parallel' && (
            <div className="space-y-2" data-testid={`parallel-steps-${String(index)}`}>
              <p className="text-xs text-foreground-subtle">
                {t(
                  'automation.parallel.hint',
                  'These start together and the run goes on when all are done. If one fails, the run fails once the others finished.',
                )}
              </p>
              <div className="border-l-2 border-border-subtle pl-3">
                <ActionList
                  nested
                  flowControl
                  actions={action.steps}
                  devices={devices}
                  devicesState={devicesState}
                  variables={variables}
                  allowedKinds={PARALLEL_KINDS}
                  depth={depth + 1}
                  {...(roundDevices === undefined ? {} : { roundDevices })}
                  maxSteps={PARALLEL_STEPS_MAX}
                  onChange={(next) =>
                    onChange(
                      replaceAt(actions, index, {
                        ...action,
                        steps: next.filter(isParallelMember),
                      }),
                    )
                  }
                />
              </div>
            </div>
          )}

          {action.kind === 'choose' && (
            <ChooseFields
              index={index}
              step={action}
              devices={devices}
              devicesState={devicesState}
              variables={variables}
              depth={depth}
              {...(roundDevices === undefined ? {} : { roundDevices })}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {!nested && (action.kind === 'stop' || action.kind === 'set') && (
            <StepIf
              when={action.if}
              devices={devices}
              hint={guardHint}
              onChange={(next) => {
                const { if: _if, ...rest } = action
                onChange(
                  replaceAt(actions, index, next === undefined ? rest : { ...rest, if: next }),
                )
              }}
            />
          )}

          {action.kind === 'code' && (
            <label className="block">
              <PickerLabel>{t('automation.actionList.code', 'Code')}</PickerLabel>
              <Textarea
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
              {...(roundDevices === undefined ? {} : { roundDevices })}
              onChange={(next) =>
                onChange(
                  replaceAt(actions, index, {
                    ...next,
                    ...(action.continueOnError === true ? { continueOnError: true } : {}),
                    ...(action.if === undefined ? {} : { if: action.if }),
                    ...(action.else === undefined ? {} : { else: action.else }),
                  }),
                )
              }
            />
          )}

          {action.kind === 'action' && (
            <RunActionFields
              step={action}
              onChange={(next) =>
                onChange(
                  replaceAt(actions, index, {
                    ...next,
                    ...(action.continueOnError === true ? { continueOnError: true } : {}),
                  }),
                )
              }
            />
          )}

          {flowControl && (action.kind === 'cap' || action.kind === 'action') && (
            <Switch
              data-testid={`continue-on-error-${String(index)}`}
              checked={action.continueOnError === true}
              label={t('automation.actionList.continueOnError', 'Continue if this step fails')}
              aria-label={t('automation.actionList.continueOnError', 'Continue if this step fails')}
              onCheckedChange={(on) => {
                const { continueOnError: _flag, ...rest } = action
                onChange(replaceAt(actions, index, on ? { ...rest, continueOnError: true } : rest))
              }}
            />
          )}

          {!nested && (action.kind === 'wait' || action.kind === 'cap') && (
            <StepGuard
              step={action}
              devices={devices}
              devicesState={devicesState}
              variables={variables}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {stepResults?.[index] !== undefined && (
            <StepResult
              step={stepResults[index]}
              deviceName={(id) => devices.find((d) => d.id === id)?.name ?? `#${String(id)}`}
            />
          )}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={maxSteps !== undefined && actions.length >= maxSteps}
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
