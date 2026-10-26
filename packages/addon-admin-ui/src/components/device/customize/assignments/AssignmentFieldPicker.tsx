/**
 * The device → field picker (spec §6): the battery and consumables cards pick
 * a NUMERIC field of another device. Step 1 is the shared {@link DevicePicker};
 * step 2 is `DeviceFields` (`sourceFor`); step 3 is the caller's `extra`.
 * Confirm waits for a field and for `extraComplete`.
 */
import type { CompositionFieldKind } from '@camstack/types'
import {
  Button,
  type DeviceListState,
  DeviceName,
  DevicePicker,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  type PickerItem,
  TEXT_SECTION_LABEL,
  useDeviceManagerListAll,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DeviceFields } from '../source-picker-device-fields'
import type { SourcePick } from '../source-picker-pick'
import type { PickerDevice } from '../source-picker-model'
import { toPickerDevices } from '../source-picker-model'

export interface AssignmentFieldPickerProps {
  readonly open: boolean
  readonly title: string
  /** Only fields of this kind are offered (`sourceFor` decides; a string becomes `number(x)`). */
  /** null = any wireable field (running assignment: boolean or number). */
  readonly targetKind: CompositionFieldKind | null
  readonly excludeDeviceIds: readonly number[]
  readonly confirmLabel: string
  /** Step 3, rendered under the field list (consumables: name + unit). */
  readonly extra?: ReactNode
  /** False while `extra` is incomplete; default true. */
  readonly extraComplete?: boolean
  readonly onConfirm: (pick: SourcePick) => void
  readonly onClose: () => void
  readonly onPickChange?: (pick: SourcePick | null) => void
}

function listStateOf(status: 'pending' | 'error' | 'success'): DeviceListState {
  if (status === 'pending') return 'pending'
  if (status === 'error') return 'failed'
  return 'answered'
}

function FieldDeviceStep({
  excludeDeviceIds,
  onSelect,
}: {
  readonly excludeDeviceIds: readonly number[]
  readonly onSelect: (device: PickerDevice) => void
}): ReactNode {
  const { t } = useTranslation()
  const devices = useDeviceManagerListAll({ projection: 'slim' })
  const data = devices.status === 'success' ? devices.data : null
  const fleet = useMemo((): readonly PickerDevice[] => {
    if (data === null) return []
    const excluded = new Set(excludeDeviceIds)
    return toPickerDevices(data).filter((d) => !excluded.has(d.id))
  }, [data, excludeDeviceIds])
  const byId = useMemo(() => new Map(fleet.map((d) => [d.id, d])), [fleet])
  const items = useMemo(
    (): readonly PickerItem<number>[] =>
      fleet.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        ...(d.location !== null ? { location: d.location } : {}),
      })),
    [fleet],
  )
  if (devices.status === 'error') {
    return (
      <ErrorBox
        title={t('customize.picker.devicesFailed')}
        message={devices.error?.message ?? ''}
      />
    )
  }
  const select = (id: number): void => {
    const device = byId.get(id)
    if (device !== undefined) onSelect(device)
  }
  return (
    <DevicePicker
      devices={items}
      listState={listStateOf(devices.status)}
      value={[]}
      onChange={(next) => {
        const id = next.at(-1)
        if (id !== undefined) select(id)
      }}
      noun="device"
      emptyLabel={t('customize.assign.none')}
      showAll
      testId="customize-field-device-picker"
    />
  )
}

export function AssignmentFieldPicker({
  open,
  title,
  targetKind,
  excludeDeviceIds,
  confirmLabel,
  extra,
  extraComplete = true,
  onConfirm,
  onClose,
  onPickChange,
}: AssignmentFieldPickerProps): ReactNode {
  const { t } = useTranslation()
  const [device, setDevice] = useState<PickerDevice | null>(null)
  const [pick, setPick] = useState<SourcePick | null>(null)
  const close = (): void => {
    setDevice(null)
    setPick(null)
    onPickChange?.(null)
    onClose()
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          {/* Only while open: a closed dialog element still renders its children, and the device list reads the fleet. */}
          {open && (
            <>
              <section
                aria-label={t('customize.assign.stepDevice')}
                className="flex flex-col gap-1"
              >
                <h3 className={TEXT_SECTION_LABEL}>{t('customize.assign.stepDevice')}</h3>
                {device === null ? (
                  <FieldDeviceStep excludeDeviceIds={excludeDeviceIds} onSelect={setDevice} />
                ) : (
                  <p className="flex items-center gap-2 text-xs text-foreground">
                    <DeviceName device={device} form="compact" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDevice(null)
                        setPick(null)
                        onPickChange?.(null)
                      }}
                    >
                      {t('customize.assign.change')}
                    </Button>
                  </p>
                )}
              </section>
              {device !== null && (
                <section
                  aria-label={t('customize.assign.stepField')}
                  className="flex flex-col gap-1"
                >
                  <h3 className={TEXT_SECTION_LABEL}>{t('customize.assign.stepField')}</h3>
                  <DeviceFields
                    device={device}
                    targetKind={targetKind}
                    selected={pick === null ? null : { cap: pick.cap, path: pick.path }}
                    onPick={(next) => {
                      setPick(next)
                      onPickChange?.(next)
                    }}
                    onBack={() => {
                      setDevice(null)
                      setPick(null)
                      onPickChange?.(null)
                    }}
                  />
                </section>
              )}
              {device !== null && extra !== undefined && (
                <section
                  aria-label={t('customize.assign.stepDetails')}
                  className="flex flex-col gap-1"
                >
                  <h3 className={TEXT_SECTION_LABEL}>{t('customize.assign.stepDetails')}</h3>
                  {extra}
                </section>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t('customize.assign.cancel')}
          </Button>
          <Button
            disabled={pick === null || !extraComplete}
            onClick={() => {
              if (pick === null) return
              onConfirm(pick)
              setDevice(null)
              setPick(null)
              onPickChange?.(null)
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
