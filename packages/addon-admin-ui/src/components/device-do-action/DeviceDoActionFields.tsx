/**
 * Shared Device → Action authoring block for NC Sequences / rule Do steps and
 * Automations: the usual DevicePicker plus a friendly action select derived
 * from the device's bound caps × the curated DEVICE_DO_ACTIONS catalogue.
 *
 * Wire shape stays `{ deviceId, cap, method, args? }` — this only changes how
 * the operator picks them. Automations and NC Sequences/Rules may multi-select
 * same-family devices (`deviceId: number[]` in the picker; the schema expands
 * to one scalar step/binding per device).
 */

import {
  actionsForDevice,
  actionsForDevices,
  allDoActions,
  DEVICE_DO_ACTIONS,
  doActionSelectValue,
  type DeviceDoAction,
  isDoPickerDeviceType,
  matchDoAction,
  sameDoFamily,
} from '@camstack/types'
import type { DeviceListState, PickerDevice, PickerFleetView } from '@camstack/ui-library'
import { useMemo } from 'react'
import { DevicePicker } from '../../pages/system/DevicePicker'
import { useDeviceBoundCaps, useDevicesBoundCaps } from './use-device-bound-caps'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const FIELD = 'mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs'
const LABEL = 'block text-[11px] font-medium text-foreground'

const TRIGGER_DEVICE_VAR = 'deviceId'

export type CapDeviceTarget = number | readonly number[] | { readonly $var: string }

export interface CapDoWire {
  readonly deviceId: CapDeviceTarget
  readonly cap: string
  readonly method: string
  readonly args?: Readonly<Record<string, unknown>>
}

export interface DeviceDoActionFieldsProps {
  readonly value: CapDoWire
  readonly onChange: (next: CapDoWire) => void
  readonly devices: readonly PickerDevice[]
  readonly listState: DeviceListState
  readonly fleet?: PickerFleetView
  /** Automations: offer "the device that triggered this run" (`{$var}`). */
  readonly allowTriggerDevice?: boolean
  /**
   * Allow several devices of the same Do family (locks, climate family,
   * cover+valve, sirens, …). The caller expands `number[]` into one scalar
   * step/binding per device before persist.
   */
  readonly allowMultiSameFamily?: boolean
  readonly testId?: string
}

/** Keep at most one selected id when the multi-select picker toggles. */
export function singleDeviceId(prev: readonly number[], next: readonly number[]): number {
  if (next.length === 0) return 0
  if (next.length === 1) return next[0]!
  const added = next.find((id) => !prev.includes(id))
  return added ?? next[next.length - 1]!
}

/**
 * Constrain a multi-select to the Do family of the first pick. Adding a
 * device from another family replaces the selection with that device alone
 * (same affordance as switching family, not a silent drop).
 */
export function sameFamilyDeviceIds(
  prev: readonly number[],
  next: readonly number[],
  typeOf: (id: number) => string | undefined,
): readonly number[] {
  if (next.length === 0) return []
  if (next.length === 1) return next
  const added = next.find((id) => !prev.includes(id))
  if (added === undefined) return next
  const addedType = typeOf(added)
  if (addedType === undefined) return [added]
  const anchorId = prev[0] ?? next.find((id) => id !== added)
  if (anchorId === undefined) return [added]
  const anchorType = typeOf(anchorId)
  if (anchorType === undefined || !sameDoFamily(anchorType, addedType)) return [added]
  return next.filter((id) => {
    const t = typeOf(id)
    return t !== undefined && sameDoFamily(anchorType, t)
  })
}

function wireDeviceId(ids: readonly number[]): CapDeviceTarget {
  if (ids.length === 0) return 0
  if (ids.length === 1) return ids[0]!
  return [...ids]
}

function selectedIdsOf(deviceId: CapDeviceTarget): readonly number[] {
  if (typeof deviceId === 'number') return deviceId > 0 ? [deviceId] : []
  if (Array.isArray(deviceId)) return deviceId.filter((id) => id > 0)
  return []
}

function wireFromAction(deviceId: CapDeviceTarget, action: DeviceDoAction): CapDoWire {
  return {
    deviceId,
    cap: action.cap,
    method: action.method,
    ...(action.args !== undefined ? { args: { ...action.args } } : {}),
  }
}

function customLabel(cap: string, method: string): string {
  return i18n.t('deviceDoAction.customLabel', { name: `${cap}.${method}` })
}

export function DeviceDoActionFields({
  value,
  onChange,
  devices,
  listState,
  fleet,
  allowTriggerDevice = false,
  allowMultiSameFamily = false,
  testId = 'device-do-action',
}: DeviceDoActionFieldsProps) {
  const { t } = useTranslation()
  const targetsVar = typeof value.deviceId !== 'number' && !Array.isArray(value.deviceId)
  const selectedIds = selectedIdsOf(value.deviceId)
  const selectableDevices = useMemo(
    () => devices.filter((d) => isDoPickerDeviceType(String(d.type ?? ''))),
    [devices],
  )
  const typeById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of selectableDevices) {
      if (d.type !== undefined && d.type !== null) map.set(d.id, String(d.type))
    }
    return map
  }, [selectableDevices])

  const familyDevices = useMemo(() => {
    if (!allowMultiSameFamily || selectedIds.length === 0) return selectableDevices
    const anchorType = typeById.get(selectedIds[0]!)
    if (anchorType === undefined) return selectableDevices
    return selectableDevices.filter((d) => {
      if (selectedIds.includes(d.id)) return true
      const t = d.type !== undefined && d.type !== null ? String(d.type) : undefined
      return t !== undefined && sameDoFamily(anchorType, t)
    })
  }, [allowMultiSameFamily, selectedIds, selectableDevices, typeById])

  const singleBound = useDeviceBoundCaps(
    !allowMultiSameFamily && selectedIds.length === 1 ? selectedIds[0]! : 0,
  )
  const multiBound = useDevicesBoundCaps(allowMultiSameFamily ? selectedIds : [])

  const offered = useMemo((): readonly DeviceDoAction[] => {
    if (targetsVar) return allDoActions()
    if (selectedIds.length === 0) return []
    if (allowMultiSameFamily) {
      if (multiBound.isLoading && multiBound.data === undefined) return []
      return actionsForDevices(
        selectedIds.map((id) => ({
          boundCaps: multiBound.data?.get(id),
          deviceType: typeById.get(id),
        })),
      )
    }
    if (singleBound.data === undefined && singleBound.isLoading) return []
    return actionsForDevice({
      boundCaps: singleBound.data,
      deviceType: typeById.get(selectedIds[0]!),
    })
  }, [
    targetsVar,
    selectedIds,
    allowMultiSameFamily,
    multiBound.data,
    multiBound.isLoading,
    singleBound.data,
    singleBound.isLoading,
    typeById,
  ])

  const selectedKey = doActionSelectValue(value.cap, value.method, value.args)
  const matched = matchDoAction(value.cap, value.method, value.args)
  const showCustom =
    value.cap !== '' &&
    value.method !== '' &&
    matched === null &&
    (targetsVar || selectedIds.length > 0)
  const bindingsLoading = allowMultiSameFamily ? multiBound.isLoading : singleBound.isLoading
  const bindingsError = allowMultiSameFamily ? multiBound.isError : singleBound.isError

  const onActionPick = (key: string): void => {
    if (key.startsWith('custom:')) return
    const action = DEVICE_DO_ACTIONS.find((a) => a.id === key)
    if (action === undefined) return
    const deviceId = targetsVar
      ? value.deviceId
      : selectedIds.length > 0
        ? wireDeviceId(selectedIds)
        : (selectableDevices[0]?.id ?? 0)
    onChange(wireFromAction(deviceId, action))
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2" data-testid={testId}>
      {allowTriggerDevice && (
        <div className="w-full max-w-xs">
          <label className={LABEL}>
            {t('deviceDoAction.deviceDoActionFields.target', 'Target')}
          </label>
          <select
            className={FIELD}
            data-testid={`${testId}-target`}
            value={targetsVar ? 'trigger' : 'device'}
            onChange={(e) => {
              if (e.target.value === 'trigger') {
                onChange({
                  deviceId: { $var: TRIGGER_DEVICE_VAR },
                  cap: '',
                  method: '',
                })
                return
              }
              onChange({
                deviceId: selectableDevices[0]?.id ?? 0,
                cap: '',
                method: '',
              })
            }}
          >
            <option value="device">
              {t('deviceDoAction.deviceDoActionFields.specificDevice', 'Specific device')}
            </option>
            <option value="trigger">
              {t(
                'deviceDoAction.deviceDoActionFields.theDeviceThatTriggeredThis',
                'The device that triggered this run',
              )}
            </option>
          </select>
        </div>
      )}

      {!targetsVar && (
        <div data-testid={`${testId}-device`}>
          <label className={LABEL}>
            {t('deviceDoAction.deviceLabel', { count: allowMultiSameFamily ? 2 : 1 })}
          </label>
          <DevicePicker
            devices={familyDevices}
            listState={listState}
            {...(fleet !== undefined ? { fleet } : {})}
            value={[...selectedIds]}
            onChange={(next) => {
              const ids = allowMultiSameFamily
                ? sameFamilyDeviceIds(selectedIds, next, (id) => typeById.get(id))
                : (() => {
                    const id = singleDeviceId(selectedIds, next)
                    return id > 0 ? [id] : []
                  })()
              onChange({
                deviceId: wireDeviceId(ids),
                cap: '',
                method: '',
              })
            }}
            emptyLabel={allowMultiSameFamily ? 'No devices selected' : 'No device selected'}
            noun="device"
            testId={`${testId}-device-picker`}
          />
          {allowMultiSameFamily && selectedIds.length > 1 && (
            <p className="mt-1 text-[11px] text-foreground-subtle">
              {t(
                'deviceDoAction.deviceDoActionFields.sameFamilyOnlyTheAction',
                'Same family only — the action runs on each selected device.',
              )}
            </p>
          )}
        </div>
      )}

      <div className="w-full max-w-sm">
        <label className={LABEL}>{t('deviceDoAction.deviceDoActionFields.action', 'Action')}</label>
        <select
          className={FIELD}
          data-testid={`${testId}-action`}
          value={
            selectedKey === `custom:${value.cap}.${value.method}`
              ? selectedKey
              : (matched?.id ?? '')
          }
          disabled={!targetsVar && (selectedIds.length === 0 || bindingsLoading)}
          onChange={(e) => onActionPick(e.target.value)}
        >
          <option value="">
            {!targetsVar && selectedIds.length === 0
              ? t('deviceDoAction.deviceDoActionFields.pickADeviceFirst', 'Pick a device first')
              : bindingsLoading
                ? t('deviceDoAction.deviceDoActionFields.loadingActions', 'Loading actions…')
                : offered.length === 0
                  ? t(
                      'deviceDoAction.deviceDoActionFields.noActionsForThisDevice',
                      'No actions for this device',
                    )
                  : t('deviceDoAction.deviceDoActionFields.selectAnAction', 'Select an action…')}
          </option>
          {showCustom && (
            <option value={selectedKey}>{customLabel(value.cap, value.method)}</option>
          )}
          {offered.map((action) => (
            <option key={action.id} value={action.id}>
              {action.label}
            </option>
          ))}
        </select>
        {bindingsError && (
          <p className="mt-1 text-[11px] text-warning">
            {t(
              'deviceDoAction.deviceDoActionFields.couldNotReadThisDevice',
              'Could not read this device’s capabilities.',
            )}
          </p>
        )}
      </div>

      {matched?.openArgs !== undefined && matched.openArgs.length > 0 && (
        <div className="flex flex-col gap-2">
          {matched.openArgs.map((arg) => {
            const raw = value.args?.[arg.key]
            const shown = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
            return (
              <div key={arg.key} className="w-full max-w-sm">
                <label className={LABEL} htmlFor={`${testId}-${arg.key}`}>
                  {arg.label}
                </label>
                <input
                  id={`${testId}-${arg.key}`}
                  className={FIELD}
                  data-testid={`${testId}-${arg.key}`}
                  type={arg.kind === 'number' ? 'number' : 'text'}
                  value={shown}
                  onChange={(e) => {
                    const nextRaw = e.target.value
                    const prev: Record<string, unknown> =
                      value.args === undefined ? {} : { ...value.args }
                    if (nextRaw === '') {
                      delete prev[arg.key]
                    } else if (arg.kind === 'number') {
                      const n = Number(nextRaw)
                      if (Number.isNaN(n)) delete prev[arg.key]
                      else prev[arg.key] = n
                    } else {
                      prev[arg.key] = nextRaw
                    }
                    onChange(
                      Object.keys(prev).length > 0
                        ? { ...value, args: prev }
                        : { deviceId: value.deviceId, cap: value.cap, method: value.method },
                    )
                  }}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
