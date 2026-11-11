/**
 * A "Device command" step: pick a device, pick one of the commands its bound
 * caps offer (the cap vocabulary, D920), fill the open args inline.
 *
 * The step reads as the vocabulary phrase — "Dispense [30] g from FRESHELEMENT 3"
 * — with each open arg an inline field. A step the vocabulary cannot represent
 * (a `{ $var }` or several devices as the target, or a command the device no
 * longer offers) is shown through the generic Device → Action row instead and
 * kept exactly as stored; the "Advanced" switch offers that row for any step.
 *
 * Inside a repeat over devices (#500) the step can be aimed at "the device of
 * this round" instead: it is stored on the `item` variable and offers the
 * commands EVERY device of the loop has (`commonVocabActions`).
 */

import { vocabularyActionsForDevice } from '@camstack/types'
import type { ResolvedVocabAction } from '@camstack/types'
import {
  Badge,
  Button,
  type DeviceListState,
  DeviceValuePicker,
  OptionSelect,
  type OptionSelectOption,
  Switch,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type CapDeviceTarget,
  DeviceDoActionFields,
} from '../../../components/device-do-action/DeviceDoActionFields'
import {
  useDeviceBoundCaps,
  useDevicesBoundCaps,
} from '../../../components/device-do-action/use-device-bound-caps'
import type { AutomationDevice } from '../automation/automation-data'
import type { ScopeVariable } from './ArgField'
import { BUILD_EXCLUDED_TYPES } from './build-device-filters'
import { DynamicArgField } from './DynamicArgField'
import {
  buildCapStep,
  type CapStep,
  type CommandDevice,
  commandId,
  commonVocabActions,
  defaultArgValues,
  isRoundTarget,
  matchRoundCommand,
  matchVocabCommand,
  ROUND_DEVICE,
  pickerTargetOf,
  singleDeviceOf,
  splitPhrase,
  type StepArgValue,
  vocabLocale,
} from './command-vocab'

export interface CommandStepProps {
  readonly step: CapStep
  readonly devices: readonly AutomationDevice[]
  readonly devicesState?: DeviceListState
  readonly variables: readonly ScopeVariable[]
  /**
   * The devices of the repeat this step sits in, when that repeat runs once
   * for each device. Present (even empty) = the step may be aimed at the
   * device of the round; absent = it is not in such a loop.
   */
  readonly roundDevices?: readonly number[]
  readonly onChange: (next: CapStep) => void
}

const NO_DEVICES: readonly number[] = []

/** Recipe schema wants a mutable `number[]`; the picker may hand a readonly one. */
function mutableTarget(deviceId: CapDeviceTarget): number | number[] | { $var: string } {
  if (typeof deviceId === 'number') return deviceId
  if (typeof deviceId === 'object' && deviceId !== null && '$var' in deviceId) {
    return { $var: deviceId.$var }
  }
  return [...deviceId]
}

function commandOptions(
  actions: readonly ResolvedVocabAction[],
  locale: 'en' | 'it',
  deviceName: string,
): readonly OptionSelectOption[] {
  return actions.map((a) => ({
    value: commandId(a),
    label: a.label[locale],
    description: a.phrase[locale].replace('{device}', deviceName),
  }))
}

export function CommandStep({
  step,
  devices,
  devicesState = 'answered',
  variables,
  roundDevices,
  onChange,
}: CommandStepProps) {
  const { t, i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const [advanced, setAdvanced] = useState(false)
  const single = singleDeviceOf(step)
  const plainTarget = single !== null
  const deviceId = single ?? 0
  const device = devices.find((d) => d.id === deviceId)
  const caps = useDeviceBoundCaps(plainTarget ? deviceId : 0)
  const round = roundDevices !== undefined && isRoundTarget(step)
  const loopIds = round ? roundDevices : NO_DEVICES
  const loopCaps = useDevicesBoundCaps(loopIds)
  const actions = useMemo(() => {
    if (round) {
      const bound = loopCaps.data
      if (bound === undefined) return []
      return commonVocabActions(
        loopIds.map((id) =>
          vocabularyActionsForDevice(bound.get(id) ?? [], devices.find((d) => d.id === id)?.type),
        ),
      )
    }
    return caps.data === undefined ? [] : vocabularyActionsForDevice(caps.data, device?.type)
  }, [round, loopCaps.data, loopIds, devices, caps.data, device?.type])
  const match = useMemo(
    () => (round ? matchRoundCommand(actions, step) : matchVocabCommand(actions, step)),
    [round, actions, step],
  )
  const fresh = step.cap === ''
  const loading = round
    ? loopIds.length > 0 && loopCaps.data === undefined && !loopCaps.isError
    : plainTarget && deviceId > 0 && caps.data === undefined && !caps.isError
  const vocabMode = (plainTarget || round) && !advanced && (fresh || match !== null || loading)
  const commandDevice: CommandDevice = round ? ROUND_DEVICE : deviceId
  const roundName = t('automation.repeat.itemHint', 'the device of this round')
  const targetName = round ? roundName : (device?.name ?? '')
  const noTarget = round ? loopIds.length === 0 : deviceId === 0

  if (!vocabMode) {
    return (
      <GenericRow
        step={step}
        devices={devices}
        devicesState={devicesState}
        onChange={onChange}
        onBack={
          (plainTarget || round) && !fresh && match !== null ? () => setAdvanced(false) : null
        }
      />
    )
  }

  return (
    <div className="space-y-2" data-testid="command-step">
      <div className="flex flex-wrap items-center gap-2">
        {!round && device?.type !== undefined && <Badge variant="neutral">{device.type}</Badge>}
        {roundDevices !== undefined && (
          <Switch
            data-testid="command-step-round"
            checked={round}
            label={t('flow.command.roundDevice', 'On the device of this round')}
            aria-label={t('flow.command.roundDevice', 'On the device of this round')}
            onCheckedChange={(on) =>
              onChange({
                kind: 'cap',
                deviceId: on ? { $var: ROUND_DEVICE.$var } : 0,
                cap: '',
                method: '',
              })
            }
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setAdvanced(true)}
          data-testid="command-step-advanced"
        >
          {t('flow.command.advanced', 'Advanced')}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {round ? (
          <p
            className="self-center text-xs text-foreground-subtle"
            data-testid="command-step-round-hint"
          >
            {t(
              'flow.command.roundHint',
              'Runs on each device of the loop in turn. Only the commands all of them have are offered.',
            )}
          </p>
        ) : (
          <DeviceValuePicker
            pick="device"
            excludeTypes={BUILD_EXCLUDED_TYPES}
            recentKey="build-targets"
            value={deviceId > 0 ? { deviceId } : null}
            testId="command-step-device"
            onChange={(picked) => {
              const id = picked?.deviceId ?? 0
              if (id !== deviceId) onChange({ kind: 'cap', deviceId: id, cap: '', method: '' })
            }}
          />
        )}
        <OptionSelect
          mode="single"
          singleDisplay="field"
          options={commandOptions(actions, locale, targetName)}
          value={match === null ? '' : commandId(match.action)}
          placeholder={
            noTarget
              ? round
                ? t('flow.command.pickLoopDevicesFirst', 'Pick the devices of the loop first')
                : t('flow.command.pickDeviceFirst', 'Pick a device first')
              : t('flow.command.pickCommand', 'Pick a command')
          }
          disabled={noTarget || loading}
          searchable={actions.length >= 8}
          emptyMessage={
            round
              ? t('flow.command.noCommonCommands', 'The devices of this loop share no command.')
              : t('flow.command.noCommands', 'This device has no commands to offer.')
          }
          onChange={(id) => {
            const next = actions.find((a) => commandId(a) === id)
            if (next !== undefined) {
              onChange(buildCapStep(next, commandDevice, defaultArgValues(next)))
            }
          }}
        />
      </div>
      {round && loopIds.length === 0 && (
        <p className="text-xs text-foreground-subtle" data-testid="command-step-round-empty">
          {t('flow.command.pickLoopDevicesFirst', 'Pick the devices of the loop first')}
        </p>
      )}
      {round && !loading && loopIds.length > 0 && actions.length === 0 && (
        <p className="text-xs text-foreground-subtle" data-testid="command-step-round-none">
          {t('flow.command.noCommonCommands', 'The devices of this loop share no command.')}
        </p>
      )}
      {match !== null && (
        <Sentence
          action={match.action}
          deviceId={deviceId}
          values={match.values}
          deviceName={targetName}
          locale={locale}
          variables={variables}
          onChange={(values) => onChange(buildCapStep(match.action, commandDevice, values))}
        />
      )}
    </div>
  )
}

interface SentenceProps {
  readonly action: ResolvedVocabAction
  readonly deviceId: number
  readonly values: Readonly<Record<string, StepArgValue>>
  readonly deviceName: string
  readonly locale: 'en' | 'it'
  readonly variables: readonly ScopeVariable[]
  readonly onChange: (values: Readonly<Record<string, StepArgValue>>) => void
}

/** The command phrase, each open arg an inline field. */
function Sentence({
  action,
  deviceId,
  values,
  deviceName,
  locale,
  variables,
  onChange,
}: SentenceProps) {
  const parts: ReactNode[] = []
  splitPhrase(action.phrase[locale]).forEach((token, i) => {
    if (token.kind === 'text') {
      parts.push(<span key={`t${String(i)}`}>{token.text}</span>)
      return
    }
    if (token.key === 'device') {
      parts.push(
        <span key="device" className="font-medium">
          {deviceName}
        </span>,
      )
      return
    }
    const arg = action.openArgs.find((a) => a.key === token.key)
    const current = values[token.key]
    if (arg === undefined || current === undefined) return
    parts.push(
      <DynamicArgField
        key={token.key}
        deviceId={deviceId}
        cap={action.cap}
        arg={arg}
        locale={locale}
        variables={variables}
        value={current}
        onChange={(next) => onChange({ ...values, [token.key]: next })}
      />,
    )
  })
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">{parts}</div>
}

interface GenericRowProps {
  readonly step: CapStep
  readonly devices: readonly AutomationDevice[]
  readonly devicesState: DeviceListState
  readonly onChange: (next: CapStep) => void
  readonly onBack: (() => void) | null
}

function GenericRow({ step, devices, devicesState, onChange, onBack }: GenericRowProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2" data-testid="command-step-generic">
      {onBack !== null && (
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t('flow.command.backToSentence', 'Back to the sentence')}
        </Button>
      )}
      <DeviceDoActionFields
        value={{ ...step, deviceId: pickerTargetOf(step) }}
        allowTriggerDevice
        allowMultiSameFamily
        devices={devices}
        listState={devicesState}
        onChange={(next) =>
          onChange({
            kind: 'cap',
            deviceId: mutableTarget(next.deviceId),
            cap: next.cap,
            method: next.method,
            ...(next.args !== undefined ? { args: { ...next.args } } : {}),
          })
        }
      />
    </div>
  )
}
