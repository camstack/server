/**
 * A device and one event its caps declare — the automation "device event"
 * trigger. Customize's edge, debounce, timeout, cooldown and source mode are
 * a different host (`shape: 'pulse' | 'span'`).
 */
import { Button, DeviceValueField, Select } from '@camstack/ui-library'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceBoundCaps } from '../../../device-do-action/use-device-bound-caps'
import {
  declaredEventOptions,
  type EventOption,
  eventSelectOptions,
  fleetEventOptions,
} from './event-category-options'

export interface EventCategoryDevice {
  readonly id: number
  readonly name: string
  readonly type?: string
}

export interface SourceSelectorEventCategoryProps {
  readonly kind: 'event'
  readonly shape: 'category'
  readonly devicePickerTestId: string
  readonly deviceId: number | null
  readonly onDeviceChange: (deviceId: number | null) => void
  readonly category: string
  readonly onCategoryChange: (category: string) => void
  readonly knownDevices: readonly EventCategoryDevice[]
  readonly excludeTypes?: readonly string[]
}

type DeclaredEvents =
  | { readonly state: 'ready'; readonly options: readonly EventOption[] }
  | { readonly state: 'pending' }
  | { readonly state: 'failed' }

/** The events the vocabulary declares for the picked device, or for any device when none is. */
function useDeclaredEvents(
  deviceId: number | null,
  deviceType: string | undefined,
  language: string,
): DeclaredEvents {
  const caps = useDeviceBoundCaps(deviceId ?? 0)
  const locale = language.toLowerCase().startsWith('it') ? 'it' : 'en'
  if (deviceId === null) return { state: 'ready', options: fleetEventOptions(locale) }
  if (caps.status === 'error') return { state: 'failed' }
  if (caps.status !== 'success') return { state: 'pending' }
  return { state: 'ready', options: declaredEventOptions(caps.data, deviceType, locale) }
}

interface EventCategoryColumnProps {
  readonly deviceId: number | null
  readonly deviceType: string | undefined
  readonly category: string
  readonly onCategoryChange: (category: string) => void
  readonly onClearDevice: () => void
}

function EventCategoryColumn({
  deviceId,
  deviceType,
  category,
  onCategoryChange,
  onClearDevice,
}: EventCategoryColumnProps): ReactNode {
  const { t, i18n } = useTranslation()
  const declared = useDeclaredEvents(deviceId, deviceType, i18n.language)
  const options =
    declared.state === 'ready'
      ? eventSelectOptions(
          declared.options,
          category,
          t('automation.triggerEditor.eventNotDeclared'),
        )
      : []
  return (
    <div className="flex flex-col gap-2">
      {deviceId !== null && (
        <Button variant="ghost" size="sm" className="self-start" onClick={onClearDevice}>
          {t('automation.triggerEditor.anyDevice', 'Any device')}
        </Button>
      )}
      <span className="text-xs text-foreground-subtle">
        {t('automation.triggerEditor.eventCategory', 'Event category')}
      </span>
      {declared.state === 'pending' && (
        <p
          role="status"
          className="text-xs text-foreground-subtle"
          data-testid="trigger-event-loading"
        >
          {t('automation.triggerEditor.eventsLoading')}
        </p>
      )}
      {declared.state === 'failed' && (
        <p role="alert" className="text-xs text-danger" data-testid="trigger-event-failed">
          {t('automation.triggerEditor.eventsFailed')}
        </p>
      )}
      {declared.state === 'ready' && options.length === 0 && (
        <p className="text-xs text-foreground-subtle" data-testid="trigger-event-none">
          {t('automation.triggerEditor.eventsNone')}
        </p>
      )}
      {declared.state === 'ready' && options.length > 0 && (
        <Select
          value={category}
          onChange={(event) => onCategoryChange(event.target.value)}
          options={[
            { value: '', label: t('automation.triggerEditor.selectAnEvent', 'Select an event…') },
            ...options,
          ]}
        />
      )}
    </div>
  )
}

export function EventCategorySource(props: SourceSelectorEventCategoryProps): ReactNode {
  const { t } = useTranslation()
  const known = props.knownDevices.find((row) => row.id === props.deviceId)
  return (
    <DeviceValueField
      testId="source-selector"
      deviceListTestId={props.devicePickerTestId}
      heading={t('automation.triggerEditor.fromDevice', 'From device')}
      {...(props.excludeTypes === undefined ? {} : { excludeTypes: props.excludeTypes })}
      deviceId={props.deviceId}
      onDeviceChange={props.onDeviceChange}
      deviceLabel={known?.name ?? null}
      valuesState="ready"
      groups={[]}
      value={null}
      onValueChange={() => undefined}
      valueColumn="always"
      valuesOverride={
        <EventCategoryColumn
          deviceId={props.deviceId}
          deviceType={known?.type}
          category={props.category}
          onCategoryChange={props.onCategoryChange}
          onClearDevice={() => props.onDeviceChange(null)}
        />
      }
      noDeviceText={t('automation.triggerEditor.anyDevice', 'Any device')}
      noValuesText={t('automation.triggerEditor.eventsNone')}
    />
  )
}
