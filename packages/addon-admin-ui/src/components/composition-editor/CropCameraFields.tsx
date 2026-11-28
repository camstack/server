/**
 * The creation fields of a crop camera (#611): the source camera, then the crop
 * drawn on its snapshot. The name is the wizard's own field above these.
 * A source is a `(addonId, stableId)` ref in the draft; the picker works in
 * device ids, so the fleet row translates between the two.
 */
import { DeviceType } from '@dominevo/types'
import { DeviceValuePicker } from '@dominevo/ui-library'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useCandidateDevices } from '../device/customize/assignments/use-source-candidates'
import { CropCameraEditor } from './CropCameraEditor'
import { fleetRowOf } from './command-sources'
import type { CropFormDraft } from './helper-form-model'

const CAMERA_TYPES: readonly string[] = [DeviceType.Camera]

export interface CropCameraFieldsProps {
  readonly draft: CropFormDraft
  readonly onChange: (draft: CropFormDraft) => void
}

export function CropCameraFields({ draft, onChange }: CropCameraFieldsProps): ReactNode {
  const { t } = useTranslation()
  const fleet = useCandidateDevices(true)
  const known = fleet.kind === 'known' ? fleet.value : null
  const row = draft.source === null || known === null ? null : fleetRowOf(known, draft.source)

  return (
    <div className="flex flex-col gap-2" data-testid="crop-camera-fields">
      <div className="flex max-w-md flex-col gap-1 text-[11px]">
        <span>{t('helper.crop.source')}</span>
        <DeviceValuePicker
          pick="device"
          noun="camera"
          fixedTypes={CAMERA_TYPES}
          recentKey="crop-camera-source"
          testId="crop-source"
          value={row === null ? null : { deviceId: row.id }}
          onChange={(picked) => {
            const next = picked === null ? undefined : known?.find((d) => d.id === picked.deviceId)
            onChange({
              ...draft,
              source:
                next === undefined ? null : { addonId: next.addonId, stableId: next.stableId },
            })
          }}
        />
      </div>
      <CropCameraEditor
        sourceDeviceId={row === null ? null : row.id}
        value={{ rect: draft.rect, aspect: draft.aspect }}
        reseedOnLoad
        onChange={(next) => onChange({ ...draft, ...next })}
      />
    </div>
  )
}
