/**
 * "Take from…" (spec §3): search a device, then pick one of ITS fields, each
 * shown with its value now. A field the target cannot use is counted, never
 * offered (D676 ruling 8's rule, "never a control that cannot work").
 */
import type {
  CompositionFieldKind,
  CompositionFieldSource,
  CompositionSourceRef,
} from '@camstack/types'
import {
  Button,
  ErrorBox,
  Input,
  SECTION_BODY,
  SECTION_CARD,
  TEXT_SECTION_LABEL,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  formatLiveValue,
  type PickerDevice,
  pickerFieldRows,
  searchPickerDevices,
  toPickerDevices,
} from './source-picker-model'

export interface SourcePick {
  readonly device: PickerDevice
  readonly ref: CompositionSourceRef
  readonly cap: string
  readonly path: string
  readonly kind: CompositionFieldKind
  readonly source: CompositionFieldSource
  readonly value: unknown
}

export interface SourcePickerProps {
  readonly title: string
  /** The kind of the field being filled; null = any field (a formula binding). */
  readonly targetKind: CompositionFieldKind | null
  readonly excludeDeviceIds?: readonly number[]
  readonly onPick: (pick: SourcePick) => void
  readonly onCancel: () => void
}

const NO_EXCLUDED: readonly number[] = []

export function SourcePicker({
  title,
  targetKind,
  excludeDeviceIds = NO_EXCLUDED,
  onPick,
  onCancel,
}: SourcePickerProps): ReactNode {
  const { t } = useTranslation()
  const [device, setDevice] = useState<PickerDevice | null>(null)
  return (
    <aside aria-label={title} className={`${SECTION_CARD} ${SECTION_BODY} flex flex-col gap-2`}>
      <h3 className={TEXT_SECTION_LABEL}>{title}</h3>
      {device === null ? (
        <DeviceSearch excludeDeviceIds={excludeDeviceIds} onSelect={setDevice} />
      ) : (
        <DeviceFields
          device={device}
          targetKind={targetKind}
          onPick={onPick}
          onBack={() => setDevice(null)}
        />
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('customize.picker.cancel')}
        </Button>
      </div>
    </aside>
  )
}

export interface DeviceSearchProps {
  readonly excludeDeviceIds: readonly number[]
  readonly onSelect: (device: PickerDevice) => void
}

export function DeviceSearch({ excludeDeviceIds, onSelect }: DeviceSearchProps): ReactNode {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  return (
    <>
      <label className="flex flex-col gap-1 text-[11px] text-foreground-subtle">
        {t('customize.picker.search')}
        <Input
          type="search"
          aria-label={t('customize.picker.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {devices.status === 'pending' && (
        <p role="status" className="text-[11px] text-foreground-subtle">
          {t('customize.picker.loadingDevices')}
        </p>
      )}
      {devices.status === 'error' && (
        <ErrorBox
          title={t('customize.picker.devicesFailed')}
          message={devices.error?.message ?? ''}
        />
      )}
      {devices.status === 'success' && (
        <ul className="flex flex-col gap-1">
          {searchPickerDevices(toPickerDevices(devices.data), query, excludeDeviceIds).map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="text-left text-[11px] hover:underline"
                onClick={() => onSelect(d)}
              >
                {d.name} <span className="text-foreground-subtle">· {d.stableId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export interface DeviceFieldsProps {
  readonly device: PickerDevice
  readonly targetKind: CompositionFieldKind | null
  /** The field already picked (the assignment field picker marks it); absent in the editor. */
  readonly selected?: { readonly cap: string; readonly path: string } | null
  readonly onPick: (pick: SourcePick) => void
  readonly onBack: () => void
}

export function DeviceFields({
  device,
  targetKind,
  selected,
  onPick,
  onBack,
}: DeviceFieldsProps): ReactNode {
  const { t } = useTranslation()
  const catalog = useDeviceManagerGetWireableFields({ deviceId: device.id })
  const snapshot = useDeviceStateGetSnapshot({ deviceId: device.id })
  if (catalog.status === 'pending') {
    return (
      <p role="status" className="text-[11px] text-foreground-subtle">
        {t('customize.picker.loadingFields')}
      </p>
    )
  }
  if (catalog.status === 'error') {
    return (
      <ErrorBox title={t('customize.picker.fieldsFailed')} message={catalog.error?.message ?? ''} />
    )
  }
  const rows = pickerFieldRows(
    device,
    catalog.data,
    snapshot.status === 'success' ? snapshot.data : null,
    targetKind,
  )
  const hidden = rows.filter((r) => r.source === null).length
  const ref = { addonId: device.addonId, stableId: device.stableId }
  return (
    <div className="flex flex-col gap-1">
      <button type="button" className="text-left text-[11px] text-primary" onClick={onBack}>
        ← {device.name}
      </button>
      {snapshot.status === 'error' && (
        <p role="alert" className="text-[10px] text-warning">
          {t('customize.picker.valuesFailed', {
            reason: snapshot.error?.message ?? '',
          })}
        </p>
      )}
      <ul role="listbox" aria-label={t('customize.picker.fields')} className="flex flex-col gap-1">
        {rows.map((r) => {
          const source = r.source
          if (source === null) return null
          const pick = (): void =>
            onPick({
              device,
              ref,
              cap: r.cap,
              path: r.path,
              kind: r.kind,
              source,
              value: r.value,
            })
          return (
            <li
              key={`${r.cap}.${r.path}`}
              role="option"
              aria-selected={selected?.cap === r.cap && selected.path === r.path}
              tabIndex={0}
              className="flex justify-between gap-2 text-[11px] cursor-pointer hover:bg-surface-hover rounded px-1"
              onClick={pick}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') pick()
              }}
            >
              <span className="font-mono">
                {r.cap}.{r.path}
              </span>
              <span>{formatLiveValue(r.value, snapshot.status === 'success')}</span>
            </li>
          )
        })}
      </ul>
      {hidden > 0 && targetKind !== null && (
        <p className="text-[10px] text-foreground-subtle">
          {t('customize.picker.hidden', {
            count: hidden,
            kind: t(`customize.kinds.${targetKind}`),
          })}
        </p>
      )}
    </div>
  )
}
