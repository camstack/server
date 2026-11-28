/**
 * The fields of a fault row (`device-fault-raised` / `device-fault-is`): the
 * device, then which of its faults count.
 *
 * The codes offered are the device's own catalog (`error.listFaultTypes`), but
 * a catalog is never an enum: a code the catalog does not list is typed, and a
 * code already saved that it no longer lists stays visible as a removable chip.
 * An unanswered read says it is loading, a failed one says the codes are typed
 * by hand, and an empty answer offers the free entry — none of them reads as
 * "this device has no faults" (D315). No code means any fault.
 */
import type { DeviceFaultIsLeaf, DeviceFaultRaisedLeaf } from '@dominevo/types'
import { DeviceValuePicker } from '@dominevo/ui-library'
import { useTranslation } from 'react-i18next'
import { OptionListField } from '../../system/notification-rule-pickers'
import { useFaultTypeOptions } from '../../system/useFaultTypeOptions'
import { PickerLabel } from './FieldPicker'

type FaultLeaf = DeviceFaultRaisedLeaf | DeviceFaultIsLeaf

export interface FaultFieldsProps {
  readonly leaf: FaultLeaf
  readonly onChange: (next: FaultLeaf) => void
}

const REQUIRES = { caps: ['error'] } as const

export function FaultFields({ leaf, onChange }: FaultFieldsProps) {
  const { t } = useTranslation()
  const hasDevice = leaf.deviceId > 0
  const catalog = useFaultTypeOptions(hasDevice ? [leaf.deviceId] : undefined, hasDevice)
  return (
    <div className="flex w-full flex-wrap items-start gap-2">
      <div className="min-w-[13rem] flex-1">
        <PickerLabel>{t('automation.fault.device', 'Device')}</PickerLabel>
        <DeviceValuePicker
          pick="device"
          requires={REQUIRES}
          recentKey="automation-device-fault"
          value={hasDevice ? { deviceId: leaf.deviceId } : null}
          onChange={(next) => onChange({ ...leaf, deviceId: next?.deviceId ?? 0, codes: [] })}
        />
      </div>
      {hasDevice && (
        <div className="min-w-[13rem] flex-[2]" data-testid="fault-codes">
          <PickerLabel>{t('automation.fault.codes', 'Fault')}</PickerLabel>
          {catalog.failed && (
            <p
              role="alert"
              className="mb-1 text-xs text-warning"
              data-testid="fault-catalog-failed"
            >
              {t(
                'automation.fault.catalogFailed',
                'The faults this device can report could not be read — type the code by hand.',
              )}
            </p>
          )}
          <OptionListField
            options={catalog.failed ? [] : catalog.options}
            value={leaf.codes}
            loading={catalog.loading}
            onChange={(codes) => onChange({ ...leaf, codes })}
            emptyHint={t(
              'automation.fault.codesEmpty',
              'This device declares no fault codes — type one, or leave empty for any fault.',
            )}
            placeholder={t('automation.fault.codePlaceholder', 'Fault code… (empty = any fault)')}
          />
        </div>
      )}
    </div>
  )
}
