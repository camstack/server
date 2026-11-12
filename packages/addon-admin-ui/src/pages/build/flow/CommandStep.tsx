/**
 * A "Device command" step, read as one sentence — "Open Kitchen blind to 40 %" —
 * with a Change button. Change opens the one device modal (`SourceSelector`,
 * `intent: 'action'`): pick the target and the command, fill its open args,
 * Confirm. The step is stored by vocabulary action id (D983):
 * `{ kind: 'command', target, actionId, args }`.
 *
 * Inside a repeat over devices (#500) the modal also offers "the device of this
 * round", with the commands EVERY device of the loop has.
 */

import type { ActionTarget, ResolvedVocabAction } from '@camstack/types'
import { Button, ItemFormDialog } from '@camstack/ui-library'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type ActionPickDraft,
  SourceSelectorAction,
} from '../../../components/device/customize/source-selector/SourceSelectorAction'
import type { AutomationDevice } from '../automation/automation-data'
import { ArgField, type ScopeVariable } from './ArgField'
import { BUILD_EXCLUDED_TYPES } from './build-device-filters'
import { describeCommandStep, resolvedActionById, type TargetWords } from './command-phrase'
import {
  buildCommandStep,
  type CommandStep as CommandStepValue,
  defaultArgValues,
  firstArgIssue,
  matchCommand,
  singleDeviceOf,
  type StepArgValues,
  vocabLocale,
} from './command-vocab'
import { DynamicArgField } from './DynamicArgField'

export interface CommandStepProps {
  readonly step: CommandStepValue
  readonly devices: readonly AutomationDevice[]
  readonly variables: readonly ScopeVariable[]
  /**
   * The devices of the repeat this step sits in, when that repeat runs once
   * for each device. Present (even empty) = the step may be aimed at the
   * device of the round; absent = it is not in such a loop.
   */
  readonly roundDevices?: readonly number[]
  /** Exactly one device, never a variable (a remote button binding). */
  readonly singleTarget?: boolean
  /**
   * Open the modal on mount when no command is picked yet (a step just added).
   * False = an empty "Choose" row that opens only on click (a selected remote button).
   */
  readonly autoOpen?: boolean
  readonly onChange: (next: CommandStepValue) => void
}

function useTargetWords(devices: readonly AutomationDevice[]): TargetWords {
  const { t } = useTranslation()
  return {
    deviceName: (id) => devices.find((d) => d.id === id)?.name ?? `#${String(id)}`,
    triggerDevice: t('flow.command.triggerDevice'),
    roundDevice: t('automation.repeat.itemHint', 'the device of this round'),
    someDevices: t('flow.command.domainDevices'),
  }
}

export function CommandStep({
  step,
  devices,
  variables,
  roundDevices,
  singleTarget = false,
  autoOpen = true,
  onChange,
}: CommandStepProps) {
  const { t, i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const words = useTargetWords(devices)
  const [open, setOpen] = useState(autoOpen && step.actionId === '')
  const sentence = describeCommandStep(step, locale, words, deviceTypeOf(step.target, devices))
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="command-step">
      <p className="min-w-0 flex-1 text-sm text-foreground" data-testid="command-step-phrase">
        {sentence ?? (
          <span className="text-foreground-subtle">{t('flow.command.pickCommand')}</span>
        )}
      </p>
      <Button
        variant="outline"
        size="sm"
        data-testid="command-step-change"
        onClick={() => setOpen(true)}
      >
        {step.actionId === '' ? t('flow.command.choose') : t('flow.command.change')}
      </Button>
      {open && (
        <CommandPickerDialog
          step={step}
          devices={devices}
          variables={variables}
          singleTarget={singleTarget}
          {...(roundDevices === undefined ? {} : { roundDevices })}
          onCancel={() => setOpen(false)}
          onConfirm={(next) => {
            setOpen(false)
            onChange(next)
          }}
        />
      )}
    </div>
  )
}

function deviceTypeOf(
  target: ActionTarget | null,
  devices: readonly AutomationDevice[],
): string | undefined {
  if (target?.kind !== 'devices') return undefined
  const first = target.ids[0]
  return devices.find((d) => d.id === first)?.type
}

interface CommandPickerDialogProps {
  readonly step: CommandStepValue
  readonly devices: readonly AutomationDevice[]
  readonly variables: readonly ScopeVariable[]
  readonly roundDevices?: readonly number[]
  readonly singleTarget: boolean
  readonly onCancel: () => void
  readonly onConfirm: (next: CommandStepValue) => void
}

function initialDraft(step: CommandStepValue): ActionPickDraft {
  const emptyDevices = step.target.kind === 'devices' && step.target.ids.length === 0
  return {
    target: emptyDevices ? null : step.target,
    actionId: step.actionId === '' ? null : step.actionId,
  }
}

/** The device modal in action mode, with the command's open args as step 3. */
export function CommandPickerDialog({
  step,
  devices,
  variables,
  roundDevices,
  singleTarget,
  onCancel,
  onConfirm,
}: CommandPickerDialogProps) {
  const { t, i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const [draft, setDraft] = useState<ActionPickDraft>(() => initialDraft(step))
  const action =
    draft.actionId === null
      ? undefined
      : resolvedActionById(draft.actionId, deviceTypeOf(draft.target, devices))
  const [values, setValues] = useState<StepArgValues>(() =>
    action === undefined ? {} : (matchCommand([action], step)?.values ?? defaultArgValues(action)),
  )
  const issue = action === undefined ? null : firstArgIssue(action, values)
  const ready = draft.target !== null && action !== undefined && issue === null
  const change = (next: ActionPickDraft): void => {
    if (next.actionId !== draft.actionId) {
      const picked =
        next.actionId === null
          ? undefined
          : resolvedActionById(next.actionId, deviceTypeOf(next.target, devices))
      setValues(picked === undefined ? {} : defaultArgValues(picked))
    }
    setDraft(next)
  }
  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={t('flow.command.dialogTitle')}
      width="xl"
      fill
      testId="command-picker-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={!ready}
            data-testid="command-picker-confirm"
            onClick={() => {
              if (draft.target === null || action === undefined || issue !== null) return
              onConfirm(buildCommandStep(action, draft.target, values))
            }}
          >
            {t('flow.command.use')}
          </Button>
        </>
      }
    >
      <SourceSelectorAction
        kind="action"
        intent="action"
        value={draft}
        onChange={change}
        allowTriggerDevice={!singleTarget}
        multiple={!singleTarget}
        excludeTypes={BUILD_EXCLUDED_TYPES}
        fillHeight
        {...(roundDevices === undefined ? {} : { roundDevices })}
        args={
          action !== undefined && action.openArgs.length > 0 ? (
            <CommandArgs
              action={action}
              deviceId={draft.target === null ? null : singleDeviceOf({ target: draft.target })}
              values={values}
              locale={locale}
              variables={variables}
              onChange={setValues}
            />
          ) : null
        }
      />
    </ItemFormDialog>
  )
}

interface CommandArgsProps {
  readonly action: ResolvedVocabAction
  /** The one device the command goes to, when it is one: a `dynamic` list is read from it. */
  readonly deviceId: number | null
  readonly values: StepArgValues
  readonly locale: 'en' | 'it'
  readonly variables: readonly ScopeVariable[]
  readonly onChange: (values: StepArgValues) => void
}

/** Step 3: one labelled field per open arg. */
function CommandArgs({ action, deviceId, values, locale, variables, onChange }: CommandArgsProps) {
  return (
    <div className="flex flex-wrap items-start gap-3" data-testid="command-args">
      {action.openArgs.map((arg) => {
        const value = values[arg.key]
        if (value === undefined) return null
        const set = (next: typeof value): void => onChange({ ...values, [arg.key]: next })
        return (
          <label key={arg.key} className="flex flex-col gap-1 text-[11px] text-foreground">
            {arg.label[locale]}
            {deviceId === null ? (
              <ArgField
                arg={arg}
                locale={locale}
                variables={variables}
                value={value}
                onChange={set}
              />
            ) : (
              <DynamicArgField
                deviceId={deviceId}
                cap={action.cap}
                arg={arg}
                locale={locale}
                variables={variables}
                value={value}
                onChange={set}
              />
            )}
          </label>
        )
      })}
    </div>
  )
}
