/**
 * Shared device-state pick block (Device → child → field → unit → value map).
 * Owned by Named Templates; camera slot bindings reuse the same control.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  DevicePicker,
  Input,
  Label,
  Select,
  UnitPicker,
  type PickerDevice,
} from '@camstack/ui-library'
import type { OsdSourceOption } from '@camstack/types'
import { preferredField, resolveAdaptiveFields } from '../adaptive-field.js'
import {
  deviceById,
  isContainerDeviceType,
  osdSupportedChildrenOf,
  type OsdPickerDevice,
} from '../osd-picker-devices.js'
import {
  shouldReseedValueMap,
  sourceOptionForPick,
  suggestedValueMap,
} from '../ui/osd-page-model.js'
import { dimensionFromSourceUnit, inferSourceUnit } from '../unit-display.js'
import { useT } from '../i18n/index.js'
import { ValueMapEditor } from './ValueMapEditor.js'

/** One device-state pick — leaf device, optional container path, field, unit, map. */
export interface DeviceStatePickValue {
  /** Leaf device id; `0` means unpicked. */
  readonly deviceId: number
  readonly containerId?: number
  readonly capName: string
  readonly valuePath: string
  readonly displayUnit?: string
  readonly valueMap?: Record<string, string>
}

export interface DeviceStatePickBlockProps {
  readonly value: DeviceStatePickValue
  readonly sources: readonly OsdSourceOption[]
  readonly pickerDevices: readonly OsdPickerDevice[] | readonly PickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  /** Cap-keyed state blobs keyed by device id — drives UnitPicker source unit. */
  readonly stateByDevice?: ReadonlyMap<number, Readonly<Record<string, unknown>>>
  /** Prefix for data-testid attributes (`osd-tpl` vs `osd`). */
  readonly testIdPrefix: string
  readonly onChange: (next: DeviceStatePickValue) => void
  /**
   * Slot-level decimal places. When set with {@link onMaxDecimalsChange}, shown
   * on one row with the unit source picker (Templates keep Decimals elsewhere).
   */
  readonly maxDecimals?: number
  readonly onMaxDecimalsChange?: (maxDecimals: number) => void
}

function asOsdDevices(
  devices: readonly OsdPickerDevice[] | readonly PickerDevice[],
): OsdPickerDevice[] {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    ...(typeof d.type === 'string' ? { type: d.type } : {}),
    location: d.location ?? null,
    parentDeviceId:
      'parentDeviceId' in d && typeof d.parentDeviceId === 'number' ? d.parentDeviceId : null,
  }))
}

function withOptionalMaps(
  base: Omit<DeviceStatePickValue, 'displayUnit' | 'valueMap' | 'containerId'> & {
    readonly containerId?: number
  },
  displayUnit: string | undefined,
  valueMap: Record<string, string> | undefined,
): DeviceStatePickValue {
  return {
    ...base,
    ...(base.containerId !== undefined ? { containerId: base.containerId } : {}),
    ...(displayUnit !== undefined ? { displayUnit } : {}),
    ...(valueMap !== undefined ? { valueMap } : {}),
  }
}

/** Seed valueMap for a newly chosen field when the current map is empty/identity/prior seed. */
export function nextValueMapForFieldChange(
  current: Record<string, string> | undefined,
  previousOption: OsdSourceOption | undefined,
  nextOption: OsdSourceOption | undefined,
): Record<string, string> | undefined {
  const previousSuggested = suggestedValueMap(previousOption)
  if (!shouldReseedValueMap(current, previousSuggested)) return current
  return suggestedValueMap(nextOption)
}

export function DeviceStatePickBlock({
  value,
  sources,
  pickerDevices,
  listState,
  stateByDevice,
  testIdPrefix,
  onChange,
  maxDecimals,
  onMaxDecimalsChange,
}: DeviceStatePickBlockProps) {
  const { t } = useT()
  const osdDevices = useMemo(() => asOsdDevices(pickerDevices), [pickerDevices])
  const osdDeviceIds = useMemo(() => new Set(sources.map((s) => s.deviceId)), [sources])

  const [pickingContainerId, setPickingContainerId] = useState<number | undefined>(
    value.containerId,
  )
  useEffect(() => {
    setPickingContainerId(value.containerId)
  }, [value.containerId, value.deviceId])

  const leafId = value.deviceId > 0 ? value.deviceId : undefined
  const entryId = pickingContainerId ?? leafId

  const containerOnBinding =
    pickingContainerId !== undefined &&
    isContainerDeviceType(deviceById(osdDevices, pickingContainerId)?.type)
      ? pickingContainerId
      : undefined
  const children =
    containerOnBinding === undefined
      ? []
      : osdSupportedChildrenOf(containerOnBinding, osdDevices, osdDeviceIds)

  const decision = leafId === undefined ? undefined : resolveAdaptiveFields(sources, leafId)

  const leaf = leafId === undefined ? undefined : deviceById(osdDevices, leafId)
  const container =
    value.containerId === undefined ? undefined : deviceById(osdDevices, value.containerId)
  const breadcrumb =
    containerOnBinding !== undefined && leafId === undefined
      ? `${deviceById(osdDevices, containerOnBinding)?.name ?? `#${containerOnBinding}`} › …`
      : container !== undefined
        ? `${container.name} › ${leaf?.name ?? `#${value.deviceId}`}`
        : (leaf?.name ?? (leafId === undefined ? t('pick.noDevice') : `#${value.deviceId}`))

  const slice =
    leafId === undefined || stateByDevice === undefined
      ? undefined
      : stateByDevice.get(leafId)?.[value.capName]
  const sourceUnit = inferSourceUnit(slice, value.valuePath)
  const unitDimension = dimensionFromSourceUnit(sourceUnit)

  const selectedOption = sourceOptionForPick(sources, value)
  const showValueMap =
    selectedOption?.valueType === 'boolean' || selectedOption?.valueType === 'enum'

  const emit = (next: DeviceStatePickValue) => onChange(next)

  const emitLeafPick = (
    deviceId: number,
    containerId: number | undefined,
    auto: OsdSourceOption | undefined,
  ) => {
    const previousOption = sourceOptionForPick(sources, value)
    const valueMap = nextValueMapForFieldChange(value.valueMap, previousOption, auto)
    emit(
      withOptionalMaps(
        {
          deviceId,
          ...(containerId !== undefined ? { containerId } : {}),
          capName: auto?.capName ?? '',
          valuePath: auto?.valuePath ?? '',
        },
        value.displayUnit,
        valueMap,
      ),
    )
  }

  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-device-state-editor`}>
      <p className="text-[11px] text-foreground-muted truncate">{breadcrumb}</p>

      <div className="space-y-2">
        <Label>{t('pick.device')}</Label>
        <DevicePicker
          devices={osdDevices}
          listState={listState}
          value={entryId === undefined ? [] : [entryId]}
          onChange={(next) => {
            const id =
              next.length === 0
                ? undefined
                : next.length === 1
                  ? next[0]
                  : (next.find((x) => x !== entryId) ?? next[next.length - 1])
            if (id === undefined) {
              setPickingContainerId(undefined)
              emit(
                withOptionalMaps(
                  { deviceId: 0, capName: '', valuePath: '' },
                  value.displayUnit,
                  undefined,
                ),
              )
              return
            }
            const device = deviceById(osdDevices, id)
            if (device !== undefined && isContainerDeviceType(device.type)) {
              setPickingContainerId(id)
              emit(
                withOptionalMaps(
                  { deviceId: 0, containerId: id, capName: '', valuePath: '' },
                  value.displayUnit,
                  undefined,
                ),
              )
              return
            }
            setPickingContainerId(undefined)
            const decisionForLeaf = resolveAdaptiveFields(sources, id)
            const auto = decisionForLeaf.auto ?? preferredField(decisionForLeaf.fields)
            emitLeafPick(id, undefined, auto)
          }}
          noun="device"
          emptyLabel={t('pick.emptyLabel')}
          testId={`${testIdPrefix}-device-picker`}
        />
        <p className="text-[10px] text-foreground-muted">{t('pick.singleHint')}</p>
      </div>

      {containerOnBinding !== undefined && (
        <div data-testid={`${testIdPrefix}-child-pick`}>
          <Label>{t('pick.child')}</Label>
          {children.length === 0 ? (
            <p className="text-xs text-foreground-muted">{t('pick.noChildren')}</p>
          ) : (
            <Select
              data-testid={`${testIdPrefix}-child`}
              value={leafId !== undefined ? String(leafId) : ''}
              options={[
                { value: '', label: t('pick.selectChild') },
                ...children.map((c) => ({ value: String(c.id), label: c.name })),
              ]}
              onChange={(e) => {
                const childId = Number(e.target.value)
                if (!Number.isFinite(childId) || childId <= 0) return
                const decisionForLeaf = resolveAdaptiveFields(sources, childId)
                const auto = decisionForLeaf.auto ?? preferredField(decisionForLeaf.fields)
                emitLeafPick(childId, containerOnBinding, auto)
              }}
            />
          )}
        </div>
      )}

      {decision !== undefined && decision.mode === 'empty' && (
        <p className="text-xs text-foreground-muted">{t('pick.noFields')}</p>
      )}

      {decision !== undefined && (decision.mode === 'pick' || decision.mode === 'auto') && (
        <div>
          <Label>{t('pick.field')}</Label>
          {decision.mode === 'auto' && decision.auto !== undefined ? (
            <p
              className="text-xs text-foreground-muted mt-1.5"
              data-testid={`${testIdPrefix}-field-auto`}
            >
              {decision.auto.label}
            </p>
          ) : (
            <Select
              data-testid={`${testIdPrefix}-field`}
              value={`${value.capName}:${value.valuePath}`}
              options={decision.fields.map((o) => ({
                value: `${o.capName}:${o.valuePath}`,
                label: o.label,
              }))}
              onChange={(e) => {
                const chosen = decision.fields.find(
                  (o) => `${o.capName}:${o.valuePath}` === e.target.value,
                )
                if (!chosen) return
                const previousOption = sourceOptionForPick(sources, value)
                const valueMap = nextValueMapForFieldChange(value.valueMap, previousOption, chosen)
                emit(
                  withOptionalMaps(
                    {
                      deviceId: leafId ?? value.deviceId,
                      ...(value.containerId !== undefined
                        ? { containerId: value.containerId }
                        : {}),
                      capName: chosen.capName,
                      valuePath: chosen.valuePath,
                    },
                    value.displayUnit,
                    valueMap,
                  ),
                )
              }}
            />
          )}
        </div>
      )}

      <div
        className={
          onMaxDecimalsChange !== undefined ? 'grid grid-cols-2 gap-3 items-end' : undefined
        }
      >
        <div>
          <Label>{t('pick.unitSource')}</Label>
          <UnitPicker
            dimension={unitDimension}
            value={value.displayUnit ?? ''}
            onChange={(unit) =>
              emit(
                withOptionalMaps(
                  {
                    deviceId: value.deviceId,
                    ...(value.containerId !== undefined ? { containerId: value.containerId } : {}),
                    capName: value.capName,
                    valuePath: value.valuePath,
                  },
                  unit === '' ? undefined : unit,
                  value.valueMap,
                ),
              )
            }
            inheritLabel={t('pick.inheritUnit')}
            emptyReason={
              sourceUnit === undefined ? t('pick.unitUnknown') : t('pick.unitNoConversions')
            }
            aria-label={t('pick.displayUnit')}
          />
        </div>
        {onMaxDecimalsChange !== undefined ? (
          <div>
            <Label htmlFor={`${testIdPrefix}-max-decimals`}>{t('pick.precision')}</Label>
            <Input
              id={`${testIdPrefix}-max-decimals`}
              data-testid={`${testIdPrefix}-max-decimals`}
              type="number"
              min={0}
              max={4}
              value={maxDecimals ?? 1}
              onChange={(e) => onMaxDecimalsChange(Number(e.target.value))}
            />
          </div>
        ) : null}
      </div>

      {showValueMap ? (
        <div data-testid={`${testIdPrefix}-value-map`}>
          <ValueMapEditor
            valueMap={value.valueMap}
            onChange={(valueMap) =>
              emit(
                withOptionalMaps(
                  {
                    deviceId: value.deviceId,
                    ...(value.containerId !== undefined ? { containerId: value.containerId } : {}),
                    capName: value.capName,
                    valuePath: value.valuePath,
                  },
                  value.displayUnit,
                  valueMap,
                ),
              )
            }
          />
        </div>
      ) : null}
    </div>
  )
}
