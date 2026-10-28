/**
 * The pickers the scene blocks share: class chips, cameras, and the zones of
 * the chosen cameras. Used by the detection and stationary triggers and by the
 * parked-object condition, so all three read and behave the same.
 */

import { DeviceType, MACRO_LABELS } from '@camstack/types'
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

function useClassLabel(): (id: string) => string {
  const { t } = useTranslation()
  return (id) => {
    switch (id) {
      case 'person':
        return t('flow.class.person', 'Person')
      case 'vehicle':
        return t('flow.class.vehicle', 'Vehicle')
      case 'animal':
        return t('flow.class.animal', 'Animal')
      case 'package':
        return t('flow.class.package', 'Package')
      default:
        return id
    }
  }
}

export interface ClassChipsProps {
  readonly selected: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  /** Shown under the chips; e.g. what an empty choice means. */
  readonly hint?: string
}

/** The classes the detector can emit, plus any a recipe already names. */
export function ClassChips({ selected, onChange, hint }: ClassChipsProps) {
  const { t } = useTranslation()
  const label = useClassLabel()
  const known = MACRO_LABELS.map((l) => l.id)
  const extra = selected.filter((c) => !known.includes(c))
  return (
    <div className="space-y-1">
      <FieldLabel>{t('flow.scene.class', 'Class')}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {[...known, ...extra].map((c) => (
          <Button
            key={c}
            size="sm"
            variant={selected.includes(c) ? 'primary' : 'outline'}
            aria-pressed={selected.includes(c)}
            onClick={() => onChange(toggled(selected, c))}
          >
            {label(c)}
          </Button>
        ))}
      </div>
      {hint !== undefined && <p className={FIELD_LABEL}>{hint}</p>}
    </div>
  )
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
