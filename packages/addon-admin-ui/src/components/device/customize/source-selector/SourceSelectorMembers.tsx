/**
 * Multi-select half of `SourceSelector` for a group helper (D944 §5).
 * Devices are the template's type and catalog caps. Values are direct
 * matches only — a group does not offer incompatible fields, and an incompatible device is not listed at all.
 */
import type { HelperMember, SourcePickRequest } from '@camstack/types'
import {
  type DeviceListState,
  DeviceName,
  DevicePicker,
  ErrorBox,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCapIndex } from '../assignments/use-cap-index'
import type { Known } from '../known'
import {
  formatLiveValue,
  readPath,
  toPickerDevices,
  type WireableCatalog,
} from '../source-picker-model'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { SourceSelectorColumns } from './source-selector-columns'
import {
  acceptCaps,
  applyMemberSelection,
  directAcceptFields,
  unhistorisedFields,
  type MemberDevice,
  type MemberField,
  partitionMemberDevices,
  selectedIdsForMembers,
} from './source-selector-members-model'
import type { SourceCandidateDevice } from './source-selector-model'
import { compatiblePickerItems } from './source-selector-parent-detail'
import { type SourceSelectorStep, stepAfterBack, stepAfterDone } from './source-selector-steps'

export interface MemberRefuse {
  readonly code: 'max'
  readonly max: number
}

export interface SourceSelectorMembersProps {
  readonly kind: 'members'
  readonly request: SourcePickRequest
  readonly enabled: boolean
  readonly members: readonly HelperMember[]
  readonly onMembersChange: (members: readonly HelperMember[]) => void
  readonly onRefuse: (reason: MemberRefuse | null) => void
  /** Fill the height the host gives instead of capping the list. */
  readonly fillHeight?: boolean
}

function listStateOf(
  devices: 'pending' | 'error' | 'success',
  capIndex: Known<ReadonlyMap<number, readonly string[]>>,
): DeviceListState {
  if (devices === 'pending' || capIndex.kind === 'pending') return 'pending'
  if (devices === 'error' || capIndex.kind === 'unknown') return 'failed'
  return 'answered'
}

function toMemberDevices(
  fleet: ReturnType<typeof toPickerDevices>,
  caps: ReadonlyMap<number, readonly string[]>,
): readonly MemberDevice[] {
  return fleet.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    location: row.location,
    parentDeviceId: row.parentDeviceId,
    addonId: row.addonId,
    stableId: row.stableId,
    caps: caps.get(row.id) ?? [],
  }))
}

function catalogFields(catalog: WireableCatalog): readonly MemberField[] {
  return catalog.caps.flatMap((entry) =>
    entry.fields.flatMap((field) => {
      if (field.item === true) return []
      return [{ cap: entry.cap, fieldPath: field.path, kind: field.kind }]
    }),
  )
}

function currentLabel(value: unknown, answered: boolean, unknownLabel: string): string {
  if (!answered) return '…'
  if (value === undefined || value === null) return unknownLabel
  return formatLiveValue(value, true)
}

export function SourceSelectorMembers({
  request,
  enabled,
  members,
  onMembersChange,
  onRefuse,
  fillHeight = false,
}: SourceSelectorMembersProps): ReactNode {
  const { t, i18n } = useTranslation()
  const [focusId, setFocusId] = useState<number | null>(null)
  const [step, setStep] = useState<SourceSelectorStep>('devices')
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const fleet = useMemo(
    () => (devices.status === 'success' ? toPickerDevices(devices.data) : []),
    [devices.status, devices.data],
  )
  const caps = useMemo(() => acceptCaps(request), [request])
  const capIndex = useCapIndex(caps, enabled)
  const partitioned = useMemo(() => {
    if (capIndex.kind !== 'known') {
      return {
        compatible: [] as MemberDevice[],
        incompatible: [] as MemberDevice[],
      }
    }
    return partitionMemberDevices(toMemberDevices(fleet, capIndex.value), request)
  }, [capIndex, fleet, request])
  const listState = listStateOf(devices.status, capIndex)
  const selected = selectedIdsForMembers(members, partitioned.compatible)
  const focus = partitioned.compatible.find((row) => row.id === focusId) ?? null
  const wireable = useDeviceManagerGetWireableFields(
    { deviceId: focus?.id ?? 0 },
    { enabled: focus !== null },
  )
  const snapshot = useDeviceStateGetSnapshot(
    { deviceId: focus?.id ?? 0 },
    { enabled: focus !== null },
  )
  const catalog: WireableCatalog = wireable.status === 'success' ? wireable.data : { caps: [] }
  const direct = directAcceptFields(catalogFields(catalog), request)
  const withoutHistory = unhistorisedFields(catalogFields(catalog), request)
  const pickerItems = useMemo(
    () => compatiblePickerItems(partitioned.compatible.map(toCandidate)),
    [partitioned.compatible],
  )
  const apply = (
    ids: readonly number[],
    choiceDeviceId: number | null,
    choice: { readonly cap: string; readonly fieldPath: string } | null,
  ): void => {
    if (capIndex.kind !== 'known') return
    const result = applyMemberSelection({
      request,
      devices: partitioned.compatible,
      selectedIds: ids,
      previous: members,
      choiceDeviceId,
      choice,
    })
    if (result.refused === 'max') {
      onRefuse({ code: 'max', max: request.max })
      return
    }
    onRefuse(null)
    onMembersChange(result.members)
  }
  const deviceColumn = (
    <div
      className={
        fillHeight
          ? 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto'
          : 'flex max-h-72 min-h-0 flex-col gap-2 overflow-y-auto sm:max-h-[min(24rem,60vh)]'
      }
    >
      <h3 className="text-[11px] font-medium text-foreground-muted">{t('helper.pickMembers')}</h3>
      {devices.status === 'error' ? (
        <ErrorBox
          title={t('customize.picker.devicesFailed')}
          message={devices.error?.message ?? ''}
        />
      ) : capIndex.kind === 'unknown' ? (
        <ErrorBox title={t('customize.picker.devicesFailed')} message={capIndex.reason} />
      ) : (
        <DevicePicker
          devices={pickerItems}
          listState={listState}
          value={selected}
          selection="multiple"
          groupBy="location"
          onChange={(ids) => {
            const added = ids.find((id) => !selected.includes(id)) ?? ids.at(-1) ?? null
            setFocusId(added)
            apply(ids, null, null)
          }}
          noun="device"
          showAll
          testId="helper-member-picker"
        />
      )}
    </div>
  )
  const valueColumn = (
    <div className="flex min-h-0 flex-col gap-2">
      {focus === null ? (
        <p className="text-[11px] text-foreground-subtle">{t('helper.pickMembersHint')}</p>
      ) : (
        <>
          <h3 className="text-[11px] font-medium text-foreground">{focus.name}</h3>
          {wireable.status === 'pending' || snapshot.status === 'pending' ? (
            <p role="status" className="text-[11px] text-foreground-subtle">
              {t('customize.picker.loadingFields')}
            </p>
          ) : wireable.status === 'error' ? (
            <ErrorBox
              title={t('customize.picker.fieldsFailed')}
              message={wireable.error?.message ?? ''}
            />
          ) : direct.length === 0 ? (
            <p className="text-[11px] text-foreground-muted">{t('helper.noUsableValue')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {direct.map((field) => {
                const selectedField = members.some(
                  (member) =>
                    member.source.addonId === focus.addonId &&
                    member.source.stableId === focus.stableId &&
                    member.cap === field.cap &&
                    member.fieldPath === field.fieldPath,
                )
                const value =
                  snapshot.status === 'success'
                    ? readPath(snapshot.data[field.cap], field.fieldPath)
                    : undefined
                return (
                  <li key={`${field.cap}.${field.fieldPath}`}>
                    <label className="flex flex-wrap items-center gap-2 text-[11px] text-foreground">
                      <input
                        type="radio"
                        name="helper-member-value"
                        checked={selectedField}
                        data-testid={`helper-value-${field.cap}.${field.fieldPath}`}
                        onChange={() => apply(union(selected, focus.id), focus.id, field)}
                      />
                      <span>{vocabularyFieldLabel(field.cap, field.fieldPath, i18n.language)}</span>
                      <span className="text-foreground-muted">
                        {currentLabel(
                          value,
                          snapshot.status === 'success',
                          t('helper.valueUnknown'),
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {withoutHistory.length > 0 && (
            <p className="text-[11px] text-foreground-muted" data-testid="helper-no-history">
              {t('helper.noHistory')}
            </p>
          )}
        </>
      )}
    </div>
  )
  const openValues = (): void => {
    const next = stepAfterDone(selected.length)
    if (next === null) return
    const focusStillSelected = focusId !== null && selected.includes(focusId)
    if (!focusStillSelected) {
      const first = selected[0]
      if (first !== undefined) setFocusId(first)
    }
    setStep(next)
  }
  const back =
    focus === null
      ? null
      : {
          label: <DeviceName device={focus} form="compact" />,
          ariaLabel: t('customize.sourceSelector.backToDevice', {
            name: focus.name,
          }),
        }
  return (
    <SourceSelectorColumns
      step={step}
      devices={deviceColumn}
      values={valueColumn}
      back={back}
      onBack={() => setStep(stepAfterBack())}
      done={{
        countLabel: t('customize.sourceSelector.pickedCount', {
          count: selected.length,
        }),
        label: t('customize.sourceSelector.done'),
        disabled: selected.length === 0,
      }}
      onDone={openValues}
      fillHeight={fillHeight}
    />
  )
}

function toCandidate(row: MemberDevice): SourceCandidateDevice {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    location: row.location,
    parentDeviceId: row.parentDeviceId,
    addonId: row.addonId,
    stableId: row.stableId,
    caps: row.caps,
  }
}

function union(ids: readonly number[], id: number): readonly number[] {
  return ids.includes(id) ? ids : [...ids, id]
}
