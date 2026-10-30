/**
 * The pickers the scene rows share: cameras, and the zones of the chosen
 * cameras. Used by the detection and parked-object rows, so all read and behave
 * the same.
 */

import { DeviceType } from '@camstack/types'
import { Button, useZonesListZones } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from '../automation/automation-data'
import { BuildDevicePicker } from './BuildDevicePicker'

const FIELD_LABEL = 'text-xs text-foreground-subtle'

export function FieldLabel({ children }: { readonly children: string }) {
  return <span className={FIELD_LABEL}>{children}</span>
}

function toggled(selected: readonly string[], value: string): readonly string[] {
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
}

export interface CameraPickerProps {
  readonly devices: readonly AutomationDevice[]
  readonly selected: readonly number[]
  readonly onChange: (next: readonly number[]) => void
}

/** The chosen cameras, picked with the common device picker. */
export function CameraPicker({ devices, selected, onChange }: CameraPickerProps) {
  const { t } = useTranslation()
  const cameras = devices.filter((d) => d.type === DeviceType.Camera)
  return (
    <div className="space-y-1">
      <FieldLabel>{t('flow.scene.cameras', 'Cameras')}</FieldLabel>
      <BuildDevicePicker
        devices={cameras}
        selection="multiple"
        noun="camera"
        value={selected}
        testId="scene-cameras"
        onChange={onChange}
      />
    </div>
  )
}

interface CameraZonesProps {
  readonly device: AutomationDevice | undefined
  readonly deviceId: number
  readonly selected: readonly string[]
  readonly onToggle: (zoneId: string) => void
}

function CameraZones({ device, deviceId, selected, onToggle }: CameraZonesProps) {
  const zones = useZonesListZones({ deviceId })
  if (zones.data === undefined || zones.data.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={FIELD_LABEL}>{device?.name ?? `#${String(deviceId)}`}</span>
      {zones.data.map((z) => (
        <Button
          key={z.id}
          size="sm"
          variant={selected.includes(z.id) ? 'primary' : 'outline'}
          aria-pressed={selected.includes(z.id)}
          onClick={() => onToggle(z.id)}
        >
          {z.name}
        </Button>
      ))}
    </div>
  )
}

export interface ZonePickerProps {
  readonly devices: readonly AutomationDevice[]
  readonly deviceIds: readonly number[]
  readonly selected: readonly string[]
  /** Undefined means the whole scene. */
  readonly onChange: (next: readonly string[] | undefined) => void
}

/** The zones of every chosen camera. Choosing none means the whole scene. */
export function ZonePicker({ devices, deviceIds, selected, onChange }: ZonePickerProps) {
  const { t } = useTranslation()
  if (deviceIds.length === 0) return null
  const toggle = (zoneId: string): void => {
    const next = toggled(selected, zoneId)
    onChange(next.length === 0 ? undefined : next)
  }
  return (
    <div className="space-y-1">
      <FieldLabel>{t('flow.scene.zones', 'Zones')}</FieldLabel>
      <div className="space-y-2">
        {deviceIds.map((id) => (
          <CameraZones
            key={id}
            device={devices.find((d) => d.id === id)}
            deviceId={id}
            selected={selected}
            onToggle={toggle}
          />
        ))}
      </div>
      <p className={FIELD_LABEL}>
        {selected.length === 0
          ? t('flow.scene.wholeScene', 'None picked: the whole scene counts.')
          : t('flow.scene.zonesPicked', 'Only these zones count.')}
      </p>
    </div>
  )
}
