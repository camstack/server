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
import { AutomationCodeEditor } from '../../../components/code/AutomationCodeEditor'
import {
  Badge,
  Button,
  DurationInput,
  Input,
  Select,
  Switch,
  type DeviceListState,
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
import { NotifyFields } from './NotifyFields'
import { ProbeFields } from './ProbeFields'
import { HttpRequestFields } from './HttpRequestFields'
import { RunActionFields } from './RunActionFields'
import { MoveButtons, type MoveTexts } from './MoveButtons'
import { type ActionKind, moveItem, newAction, removeAt, replaceAt } from './recipe-parts'
import { ChooseFields } from './ChooseFields'
import { isParallelMember, PARALLEL_KINDS } from './choose-model'
import { SetVarsFields } from './SetVarsFields'
import { RepeatFields } from './RepeatFields'
import { StepGuard, StepIf } from './StepGuard'
import { WaitUntilFields } from './WaitUntilFields'
import { clampWait } from './wait-until-model'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { type StepChoice, type StepKindOption, StepKindPicker } from './StepKindPicker'

export const ACTION_KINDS: readonly { readonly value: ActionKind; readonly labelKey: string }[] = [
  { value: 'command', labelKey: 'automation.actionList.kindCap' },
  { value: 'action', labelKey: 'automation.actionList.kindAction' },
  { value: 'notify', labelKey: 'automation.actionList.kindNotify' },
  { value: 'probe', labelKey: 'automation.actionList.kindProbe' },
  { value: 'http-request', labelKey: 'automation.actionList.kindHttp' },
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

/**
 * The kinds a list offers: the ones `allowedKinds` names (default: all), minus
 * the flow kinds when the list is not an automation's own. The Then editor and
 * the Action editor both ask this, so they cannot offer different kinds by
 * accident (`step-kinds-parity.spec.ts`).
 */
export function offeredStepKinds(
  allowedKinds: readonly ActionKind[] | undefined,
  flowControl: boolean,
): readonly ActionKind[] {
  return ACTION_KINDS.filter(
    (k) =>
      (allowedKinds === undefined || allowedKinds.includes(k.value)) &&
      (flowControl || !FLOW_KINDS.includes(k.value)),
  ).map((k) => k.value)
}

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
   * The list offers the flow steps (stop, set, choose, wait-until, parallel,
   * repeat) and "continue if this fails": an automation's Then, and an Action.
   * A scheduler point does not.
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
  const [picking, setPicking] = useState(false)
  const offered = offeredStepKinds(allowedKinds, flowControl)
  const kinds = ACTION_KINDS.filter((k) => offered.includes(k.value))
  // the order the operator reads the choices in
  const pickOrder: readonly StepChoice[] = [
    'command',
    'notify',
    'probe',
    'http-request',
    'wait',
    'wait-until',
    'set',
    'choose',
    'parallel',
    'repeat',
    'code',
    'action',
    'stop',
  ]
  const pickOptions: readonly StepKindOption[] = pickOrder.flatMap((choice) => {
    const hit = kinds.find((k) => k.value === choice)
    return hit === undefined ? [] : [{ value: choice, labelKey: hit.labelKey }]
  })
  const addChosen = (choice: StepChoice): void => {
    setPicking(false)
    onChange([...actions, newAction(choice)])
  }
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
          data-testid={`step-card-${String(index)}`}
          data-disabled={action.enabled === false ? 'true' : 'false'}
          className={`space-y-2 rounded border p-3 ${action.enabled === false ? 'opacity-60' : ''} ${
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
              <Switch
                data-testid={`step-enabled-${String(index)}`}
                checked={action.enabled !== false}
                title={t('automation.actionList.stepDisabledHint')}
                aria-label={t('automation.actionList.stepEnabled', 'Step enabled')}
                onCheckedChange={(on) => {
                  const { enabled: _flag, ...rest } = action
                  onChange(replaceAt(actions, index, on ? rest : { ...rest, enabled: false }))
                }}
              />
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
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <PickerLabel>{t('automation.actionList.waitFor', 'Wait for')}</PickerLabel>
                <DurationInput
                  aria-label={t('automation.actionList.waitFor', 'Wait for')}
                  value={action.seconds}
                  max={WAIT_MAX_SECONDS}
                  fractional
                  testIdPrefix={`wait-${String(index)}`}
                  onChange={(seconds) =>
                    onChange(replaceAt(actions, index, { ...action, seconds: clampWait(seconds) }))
                  }
                />
              </div>
            </div>
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
            <div className="block">
              <PickerLabel>{t('automation.actionList.code', 'Code')}</PickerLabel>
              <AutomationCodeEditor
                value={action.code}
                onChange={(code) => onChange(replaceAt(actions, index, { ...action, code }))}
              />
              <span className="mt-1 block text-xs text-foreground-subtle">
                <Trans i18nKey="automation.actionList.codeHint" components={{ code: <code /> }} />
              </span>
            </div>
          )}

          {action.kind === 'command' && (
            <CommandStep
              step={action}
              devices={devices}
              variables={variables}
              {...(roundDevices === undefined ? {} : { roundDevices })}
              onChange={(next) =>
                onChange(
                  replaceAt(actions, index, {
                    ...next,
                    ...(action.enabled === false ? { enabled: false } : {}),
                    ...(action.continueOnError === true ? { continueOnError: true } : {}),
                    ...(action.if === undefined ? {} : { if: action.if }),
                    ...(action.else === undefined ? {} : { else: action.else }),
                  }),
                )
              }
            />
          )}

          {action.kind === 'notify' && (
            <NotifyFields
              index={index}
              step={action}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {action.kind === 'probe' && (
            <ProbeFields
              index={index}
              step={action}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {action.kind === 'http-request' && (
            <HttpRequestFields
              index={index}
              step={action}
              onChange={(next) => onChange(replaceAt(actions, index, next))}
            />
          )}

          {action.kind === 'action' && (
            <RunActionFields
              step={action}
              onChange={(next) =>
                onChange(
                  replaceAt(actions, index, {
                    ...next,
                    ...(action.enabled === false ? { enabled: false } : {}),
                    ...(action.continueOnError === true ? { continueOnError: true } : {}),
                  }),
                )
              }
            />
          )}

          {flowControl &&
            (action.kind === 'command' ||
              action.kind === 'action' ||
              action.kind === 'notify' ||
              action.kind === 'probe' ||
              action.kind === 'http-request') && (
              <Switch
                data-testid={`continue-on-error-${String(index)}`}
                checked={action.continueOnError === true}
                label={t('automation.actionList.continueOnError', 'Continue if this step fails')}
                aria-label={t(
                  'automation.actionList.continueOnError',
                  'Continue if this step fails',
                )}
                onCheckedChange={(on) => {
                  const { continueOnError: _flag, ...rest } = action
                  onChange(
                    replaceAt(actions, index, on ? { ...rest, continueOnError: true } : rest),
                  )
                }}
              />
            )}

          {!nested && (action.kind === 'wait' || action.kind === 'command') && (
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

      <StepKindPicker
        open={picking}
        options={pickOptions}
        onOpenChange={setPicking}
        onPick={addChosen}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={maxSteps !== undefined && actions.length >= maxSteps}
          data-testid="add-step"
          onClick={() => setPicking(true)}
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
  return hit?.value ?? 'command'
}
