/**
 * The action of a command whose devices are ALREADY chosen elsewhere: one
 * select over what those devices all offer, and the open args of the picked
 * action beside it. The devices are picked with the shared device picker; this
 * control never picks a device.
 *
 * What the devices offer is unknown until their bindings answer: the select
 * then offers nothing rather than claiming the devices can do nothing (D315).
 */
import type { TemplateActionValue } from '@camstack/types'
import { Select } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { useDevicesBoundCaps } from '../../../components/device-do-action/use-device-bound-caps'
import {
  type ActionFleetDevice,
  targetActions,
} from '../../../components/device/customize/source-selector/source-selector-action-model'
import type { AutomationDevice } from '../automation/automation-data'
import { PickerLabel } from '../automation/FieldPicker'
import { CommandArgs } from './CommandStep'
import {
  buildCommandStep,
  defaultArgValues,
  matchCommand,
  type StepArgValues,
  vocabLocale,
} from './command-vocab'

export interface CommandActionFieldProps {
  /** The devices the command goes to — chosen by the caller's device picker. */
  readonly deviceIds: readonly number[]
  readonly devices: readonly AutomationDevice[]
  readonly value: TemplateActionValue | undefined
  readonly disabled?: boolean
  readonly testId?: string
  readonly ariaLabel?: string
  /** Drawn above the select, as the other controls of a one-line row are labelled. */
  readonly label?: string
  readonly onChange: (next: TemplateActionValue | undefined) => void
}

const NONE = ''

export function CommandActionField({
  deviceIds,
  devices,
  value,
  disabled = false,
  testId,
  ariaLabel,
  label,
  onChange,
}: CommandActionFieldProps) {
  const { t, i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const caps = useDevicesBoundCaps(deviceIds)
  const known = caps.data !== undefined
  const fleet: readonly ActionFleetDevice[] = deviceIds.map((id) => {
    const type = devices.find((d) => d.id === id)?.type
    return { id, caps: caps.data?.get(id) ?? [], ...(type === undefined ? {} : { type }) }
  })
  const target = { kind: 'devices' as const, ids: [...deviceIds] }
  const actions = known ? targetActions(fleet, target, {}) : []
  const picked = value === undefined ? undefined : actions.find((a) => a.id === value.actionId)
  const values: StepArgValues =
    picked === undefined || value === undefined
      ? {}
      : (matchCommand([picked], value)?.values ?? defaultArgValues(picked))

  const store = (actionId: string, argValues: StepArgValues | null): void => {
    const action = actions.find((a) => a.id === actionId)
    if (action === undefined) {
      onChange(undefined)
      return
    }
    const step = buildCommandStep(action, target, argValues ?? defaultArgValues(action))
    onChange({ actionId: step.actionId, ...(step.args === undefined ? {} : { args: step.args }) })
  }

  const placeholder = known
    ? t('build.templates.choose', 'Choose…')
    : t('build.templates.readingActions', 'Reading what these devices can do…')
  const unpicked =
    value === undefined
      ? { value: NONE, label: placeholder }
      : {
          value: value.actionId,
          label: known
            ? t('build.templates.actionNotOffered', '{{id}} (not offered)', { id: value.actionId })
            : placeholder,
        }
  const select = (
    <Select
      data-testid={testId}
      aria-label={ariaLabel}
      disabled={disabled || !known}
      value={value?.actionId ?? NONE}
      onChange={(e) => store(e.target.value, null)}
      options={[
        ...(picked === undefined ? [unpicked] : []),
        ...actions.map((a) => ({ value: a.id, label: a.label[locale] })),
      ]}
    />
  )
  return (
    <>
      {label === undefined ? (
        select
      ) : (
        <label className="min-w-[11rem] flex-1">
          <PickerLabel>{label}</PickerLabel>
          {select}
        </label>
      )}
      {picked !== undefined && picked.openArgs.length > 0 && (
        <CommandArgs
          action={picked}
          deviceId={deviceIds.length === 1 ? (deviceIds[0] ?? null) : null}
          values={values}
          locale={locale}
          variables={[]}
          onChange={(next) => store(picked.id, next)}
        />
      )}
    </>
  )
}
