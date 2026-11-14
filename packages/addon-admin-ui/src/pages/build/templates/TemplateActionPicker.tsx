/**
 * The "Actions" field of a template: the shared device picker in its action
 * mode. The library draws the field and its two pages; this file supplies what
 * only the admin UI knows — the actions the chosen devices all offer, their
 * args, and the name of an entry.
 *
 * What the devices offer is unknown until their bindings answer: the select
 * then offers nothing rather than claiming the devices can do nothing (D315).
 */
import {
  type DeviceActionEditorProps,
  type DeviceActionEntryLabel,
  DeviceActionPicker,
  type PickedDeviceAction,
  Select,
  useDeviceLabelsByIds,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { useDevicesBoundCaps } from '../../../components/device-do-action/use-device-bound-caps'
import {
  type ActionFleetDevice,
  targetActions,
} from '../../../components/device/customize/source-selector/source-selector-action-model'
import type { AutomationDevice } from '../automation/automation-data'
import { CommandArgs } from '../flow/CommandStep'
import {
  buildCommandStep,
  defaultArgValues,
  matchCommand,
  type StepArgValues,
  vocabLocale,
} from '../flow/command-vocab'

const NONE = ''

function useOfferedActions(deviceIds: readonly number[], devices: readonly AutomationDevice[]) {
  const caps = useDevicesBoundCaps(deviceIds)
  const known = caps.data !== undefined
  const fleet: readonly ActionFleetDevice[] = deviceIds.map((id) => {
    const type = devices.find((d) => d.id === id)?.type
    return { id, caps: caps.data?.get(id) ?? [], ...(type === undefined ? {} : { type }) }
  })
  const target = { kind: 'devices' as const, ids: [...deviceIds] }
  return { known, target, actions: known ? targetActions(fleet, target, {}) : [] }
}

export interface ActionEditorProps extends DeviceActionEditorProps {
  readonly devices: readonly AutomationDevice[]
  readonly disabled?: boolean
  readonly testId?: string
}

/** One select over what the devices all offer, and the open args of the pick. */
export function ActionEditor({
  deviceIds,
  value,
  onChange,
  devices,
  disabled = false,
  testId = 'template-action-select',
}: ActionEditorProps) {
  const { t, i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const { known, target, actions } = useOfferedActions(deviceIds, devices)
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
  return (
    <>
      <Select
        data-testid={testId}
        aria-label={t('build.templates.actionLabel', 'Action')}
        disabled={disabled || !known}
        value={value?.actionId ?? NONE}
        onChange={(e) => store(e.target.value, null)}
        options={[
          ...(picked === undefined ? [unpicked] : []),
          ...actions.map((a) => ({ value: a.id, label: a.label[locale] })),
        ]}
      />
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

export interface TemplateActionPickerProps {
  readonly value: readonly PickedDeviceAction[]
  readonly onChange: (next: readonly PickedDeviceAction[]) => void
  readonly devices: readonly AutomationDevice[]
  readonly maxItems?: number
  readonly disabled?: boolean
  readonly recentKey?: string
  readonly testId?: string
}

export function TemplateActionPicker({ devices, ...props }: TemplateActionPickerProps) {
  const { i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const useEntryLabel = (pick: PickedDeviceAction): DeviceActionEntryLabel => {
    const names = useDeviceLabelsByIds(pick.deviceIds, 'compact')
    const { known, actions } = useOfferedActions(pick.deviceIds, devices)
    const offered = actions.find((a) => a.id === pick.action.actionId)
    return {
      label: `${offered?.label[locale] ?? pick.action.actionId} · ${names.join(', ')}`,
      warning: known && offered === undefined,
    }
  }
  return (
    <DeviceActionPicker
      {...props}
      useEntryLabel={useEntryLabel}
      renderEditor={(editor) => <ActionEditor {...editor} devices={devices} />}
    />
  )
}
