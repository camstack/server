/**
 * The "Actions" field of a template: the shared device picker in its action
 * mode. The library draws the field and its two pages; this file supplies what
 * only the admin UI knows — the actions the chosen devices all offer, their
 * args, and the name of an entry.
 *
 * What the devices offer is unknown until their bindings answer: the select
 * then offers nothing rather than claiming the devices can do nothing (D315).
 */
import type { ActionTarget, AutomationCommandStep } from '@camstack/types'
import {
  type DeviceActionEditorProps,
  type DeviceActionEntryLabel,
  DeviceActionPicker,
  Select,
  useActionTargetLabel,
  useDeviceNameIndex,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { useDevicesBoundCaps } from '../../../components/device-do-action/use-device-bound-caps'
import {
  type ActionFleetDevice,
  fleetActions,
  hasDynamicArg,
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

/** The ids of the fleet devices a domain target covers: its type and its room, each optional. */
function domainDeviceIds(
  index: ReturnType<typeof useDeviceNameIndex>,
  target: Extract<ActionTarget, { kind: 'domain' }>,
): readonly number[] | null {
  if (index === null) return null
  const room = target.roomId?.trim().toLowerCase()
  return [...index.byId.values()]
    .filter(
      (device) =>
        (target.deviceType === undefined || device.type === target.deviceType) &&
        (room === undefined || device.location?.trim().toLowerCase() === room),
    )
    .map((device) => device.id)
}

const NO_IDS: readonly number[] = []

function useOfferedActions(target: ActionTarget, devices: readonly AutomationDevice[]) {
  const index = useDeviceNameIndex()
  const ids =
    target.kind === 'devices'
      ? target.ids
      : target.kind === 'domain'
        ? (domainDeviceIds(index, target) ?? NO_IDS)
        : NO_IDS
  const caps = useDevicesBoundCaps(ids)
  // A domain that covers no device is an answer (it offers nothing); an unread fleet is not.
  const answered =
    target.kind === 'domain' ? index !== null && (ids.length === 0 || caps.data !== undefined) : caps.data !== undefined
  const fleet: readonly ActionFleetDevice[] = ids.map((id) => {
    const type = devices.find((d) => d.id === id)?.type
    return { id, caps: caps.data?.get(id) ?? [], ...(type === undefined ? {} : { type }) }
  })
  const actions = !answered
    ? []
    : target.kind === 'domain'
      ? fleetActions(fleet).filter((a) => !hasDynamicArg(a))
      : targetActions(fleet, target, {})
  return { known: answered, actions }
}

export interface ActionEditorProps extends DeviceActionEditorProps {
  readonly devices: readonly AutomationDevice[]
  readonly disabled?: boolean
  readonly testId?: string
}

/** One select over what the target offers, and the open args of the pick. */
export function ActionEditor({
  target,
  value,
  onChange,
  devices,
  disabled = false,
  testId = 'template-action-select',
}: ActionEditorProps) {
  const { t, i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const { known, actions } = useOfferedActions(target, devices)
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
    onChange(buildCommandStep(action, target, argValues ?? defaultArgValues(action)))
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
          deviceId={target.kind === 'devices' && target.ids.length === 1 ? (target.ids[0] ?? null) : null}
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
  readonly value: readonly AutomationCommandStep[]
  readonly onChange: (next: readonly AutomationCommandStep[]) => void
  readonly devices: readonly AutomationDevice[]
  readonly maxItems?: number
  readonly disabled?: boolean
  readonly recentKey?: string
  readonly testId?: string
}

export function TemplateActionPicker({ devices, ...props }: TemplateActionPickerProps) {
  const { i18n } = useTranslation()
  const locale = vocabLocale(i18n.language)
  const useEntryLabel = (step: AutomationCommandStep): DeviceActionEntryLabel => {
    const where = useActionTargetLabel(step.target)
    const { known, actions } = useOfferedActions(step.target, devices)
    const offered = actions.find((a) => a.id === step.actionId)
    return {
      label: `${offered?.label[locale] ?? step.actionId} · ${where}`,
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
