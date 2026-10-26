/**
 * Wireable field list for assignment pickers (`sourceFor` fit). Extension
 * dialogs use {@link SourceSelector} instead (D944 §5).
 */
import type { CompositionFieldKind, CompositionSourceRef } from '@camstack/types'
import {
  Button,
  DeviceName,
  ErrorBox,
  useDeviceLabel,
  useDeviceManagerGetWireableFields,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SourcePick } from './source-picker-pick'
import { formatLiveValue, type PickerDevice, pickerFieldRows } from './source-picker-model'

export interface DeviceFieldsProps {
  readonly device: PickerDevice
  readonly targetKind: CompositionFieldKind | null
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
  const ref: CompositionSourceRef = { addonId: device.addonId, stableId: device.stableId }
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto px-0 text-[11px] text-primary"
        onClick={onBack}
      >
        ← <DeviceName device={device} form="compact" />
      </Button>
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
