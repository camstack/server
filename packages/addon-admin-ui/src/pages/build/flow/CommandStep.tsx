/**
 * A "Device command" step: pick a device, pick one of the commands its bound
 * caps offer (the cap vocabulary, D920), fill the open args inline.
 *
 * The step reads as the vocabulary phrase — "Dispense [30] g from FRESHELEMENT 3"
 * — with each open arg an inline field. A step the vocabulary cannot represent
 * (a `{ $var }` or several devices as the target, or a command the device no
 * longer offers) is shown through the generic Device → Action row instead and
 * kept exactly as stored; the "Advanced" switch offers that row for any step.
 */

import { isDoPickerDeviceType, vocabularyActionsForDevice } from '@camstack/types'
import type { ResolvedVocabAction } from '@camstack/types'
import {
  Badge,
  Button,
  type DeviceListState,
  OptionSelect,
  type OptionSelectOption,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type CapDeviceTarget,
  DeviceDoActionFields,
} from '../../../components/device-do-action/DeviceDoActionFields'
import { useDeviceBoundCaps } from '../../../components/device-do-action/use-device-bound-caps'
import type { AutomationDevice } from '../automation/automation-data'
import { ArgField, type ScopeVariable } from './ArgField'
import {
  buildCapStep,
  type CapStep,
  commandId,
  defaultArgValues,
  matchVocabCommand,
  splitPhrase,
  type StepArgValue,
  vocabLocale,
} from './command-vocab'
import { FixedSelect } from './FixedSelect'

export interface CommandStepProps {
  readonly step: CapStep
  readonly devices: readonly AutomationDevice[]
  readonly devicesState?: DeviceListState
  readonly variables: readonly ScopeVariable[]
  readonly onChange: (next: CapStep) => void
}

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
  onChange,
}: CommandStepProps) {
  const { t, i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const [advanced, setAdvanced] = useState(false)
  const plainTarget = typeof step.deviceId === 'number'
  const deviceId = typeof step.deviceId === 'number' ? step.deviceId : 0
  const device = devices.find((d) => d.id === deviceId)
  const caps = useDeviceBoundCaps(plainTarget ? deviceId : 0)
  const actions = useMemo(
    () => (caps.data === undefined ? [] : vocabularyActionsForDevice(caps.data, device?.type)),
    [caps.data, device?.type],
  )
  const match = useMemo(() => matchVocabCommand(actions, step), [actions, step])
  const fresh = step.cap === ''
  const loading = plainTarget && deviceId > 0 && caps.data === undefined && !caps.isError
  const vocabMode = plainTarget && !advanced && (fresh || match !== null || loading)

  if (!vocabMode) {
    return (
      <GenericRow
        step={step}
        devices={devices}
        devicesState={devicesState}
        onChange={onChange}
        onBack={plainTarget && !fresh && match !== null ? () => setAdvanced(false) : null}
      />
    )
  }

  const deviceOptions = devices
    .filter((d) => isDoPickerDeviceType(d.type ?? ''))
    .map((d) => ({ value: String(d.id), label: d.name }))

  return (
    <div className="space-y-2" data-testid="command-step">
      <div className="flex flex-wrap items-center gap-2">
        {device?.type !== undefined && <Badge variant="neutral">{device.type}</Badge>}
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
        <FixedSelect
          widthClass="w-full"
          aria-label={t('flow.command.device', 'Device')}
          value={deviceId > 0 ? String(deviceId) : ''}
          onChange={(e) =>
            onChange({ kind: 'cap', deviceId: Number(e.target.value), cap: '', method: '' })
          }
          options={[
            { value: '', label: t('flow.command.pickDevice', 'Pick a device') },
            ...deviceOptions,
          ]}
        />
        <OptionSelect
          mode="single"
          singleDisplay="field"
          options={commandOptions(actions, locale, device?.name ?? '')}
          value={match === null ? '' : commandId(match.action)}
          placeholder={
            deviceId === 0
              ? t('flow.command.pickDeviceFirst', 'Pick a device first')
              : t('flow.command.pickCommand', 'Pick a command')
          }
          disabled={deviceId === 0 || loading}
          searchable={actions.length >= 8}
          emptyMessage={t('flow.command.noCommands', 'This device has no commands to offer.')}
          onChange={(id) => {
            const next = actions.find((a) => commandId(a) === id)
            if (next !== undefined) {
              onChange(buildCapStep(next, deviceId, defaultArgValues(next)))
            }
          }}
        />
      </div>
      {match !== null && (
        <Sentence
          action={match.action}
          values={match.values}
          deviceName={device?.name ?? ''}
          locale={locale}
          variables={variables}
          onChange={(values) => onChange(buildCapStep(match.action, deviceId, values))}
        />
      )}
    </div>
  )
}

interface SentenceProps {
  readonly action: ResolvedVocabAction
  readonly values: Readonly<Record<string, StepArgValue>>
  readonly deviceName: string
  readonly locale: 'en' | 'it'
  readonly variables: readonly ScopeVariable[]
  readonly onChange: (values: Readonly<Record<string, StepArgValue>>) => void
}

/** The command phrase, each open arg an inline field. */
function Sentence({ action, values, deviceName, locale, variables, onChange }: SentenceProps) {
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
      <ArgField
        key={token.key}
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
        value={step}
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
