/**
 * The scene rows of the `when` tree: a detection, a parked object appearing or
 * leaving, an interval, and "an object is parked".
 *
 * Each editor builds its recipe part with the optional keys OMITTED when unset
 * (the recipe is serialised into the generated file, and the schema takes a
 * key's absence, not `undefined`, as "any").
 */

import type {
  AutomationLeaf,
  DetectionLeaf,
  DetectionSubject,
  StationaryLeaf,
  StationaryPresentLeaf,
} from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { SegmentedChoice } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { BuildDevicePicker } from '../flow/BuildDevicePicker'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { CameraPicker, FieldLabel, ZonePicker } from '../flow/scene-pickers'
import type { AutomationDevice } from './automation-data'
import { SubjectPicker } from './SubjectPicker'

type IntervalLeaf = Extract<AutomationLeaf, { kind: 'interval' }>
type Phase = StationaryLeaf['phase']

const PERCENT = 100

export interface DetectionFieldsProps {
  readonly leaf: DetectionLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: DetectionLeaf) => void
}

/** "<class> detected [label] on <cameras>". */
export function DetectionFields({ leaf: trigger, devices, onChange }: DetectionFieldsProps) {
  const { t } = useTranslation()
  const percent = Math.round((trigger.minScore ?? 0) * PERCENT)
  const setZones = (zones: readonly string[] | undefined): void => {
    const { zones: _dropped, ...rest } = trigger
    onChange(zones === undefined ? rest : { ...rest, zones: [...zones] })
  }
  const setScore = (value: number): void => {
    const { minScore: _dropped, ...rest } = trigger
    onChange(value <= 0 ? rest : { ...rest, minScore: value / PERCENT })
  }
  return (
    <div className="w-full space-y-3" data-testid="detection-fields">
      <SubjectPicker
        subjects={trigger.subjects}
        optional={false}
        classLabelsOnly={false}
        verb={t('automation.whenTree.detected', 'detected')}
        onChange={(subjects) => onChange({ ...trigger, subjects: [...subjects] })}
      />
      <CameraPicker
        devices={devices}
        selected={trigger.deviceIds}
        onChange={(deviceIds) => onChange({ ...trigger, deviceIds: [...deviceIds] })}
      />
      <ZonePicker
        devices={devices}
        deviceIds={trigger.deviceIds}
        selected={trigger.zones ?? []}
        onChange={setZones}
      />
      <div className="space-y-1">
        <FieldLabel>
          {percent === 0
            ? t('flow.scene.minScoreAny', 'Minimum score: any')
            : t('flow.scene.minScore', 'Minimum score: {{value}}', {
                value: (percent / PERCENT).toFixed(2),
              })}
        </FieldLabel>
        <input
          type="range"
          min={0}
          max={PERCENT}
          value={percent}
          aria-label={t('flow.scene.minScoreAria', 'Minimum score')}
          className="block w-full max-w-sm accent-primary"
          onChange={(e) => setScore(Number(e.target.value))}
        />
      </div>
    </div>
  )
}

export interface StationaryFieldsProps {
  readonly leaf: StationaryLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: StationaryLeaf) => void
}

/** "<class> becomes parked / leaves, on <cameras>". */
export function StationaryFields({ leaf: trigger, devices, onChange }: StationaryFieldsProps) {
  const { t } = useTranslation()
  const setSubjects = (subjects: readonly DetectionSubject[]): void => {
    const { subjects: _dropped, ...rest } = trigger
    onChange(subjects.length === 0 ? rest : { ...rest, subjects: [...subjects] })
  }
  const setZones = (zones: readonly string[] | undefined): void => {
    const { zones: _dropped, ...rest } = trigger
    onChange(zones === undefined ? rest : { ...rest, zones: [...zones] })
  }
  return (
    <div className="w-full space-y-3" data-testid="stationary-fields">
      <SubjectPicker
        subjects={trigger.subjects ?? []}
        optional
        classLabelsOnly
        verb={t('automation.whenTree.parked', 'object')}
        onChange={setSubjects}
      />
      <CameraPicker
        devices={devices}
        selected={trigger.deviceIds}
        onChange={(deviceIds) => onChange({ ...trigger, deviceIds: [...deviceIds] })}
      />
      <ZonePicker
        devices={devices}
        deviceIds={trigger.deviceIds}
        selected={trigger.zones ?? []}
        onChange={setZones}
      />
      <SegmentedChoice<Phase>
        label={t('flow.scene.firesWhen', 'Fires when it')}
        value={trigger.phase}
        onChange={(phase) => onChange({ ...trigger, phase })}
        options={[
          {
            value: 'appeared',
            label: t('flow.scene.phaseAppeared', 'Stopped (parked)'),
          },
          { value: 'departed', label: t('flow.scene.phaseDeparted', 'Left') },
        ]}
      />
    </div>
  )
}

export interface IntervalFieldsProps {
  readonly leaf: IntervalLeaf
  readonly onChange: (next: IntervalLeaf) => void
}

export function IntervalFields({ leaf: trigger, onChange }: IntervalFieldsProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2" data-testid="interval-fields">
      <FieldLabel>{t('flow.scene.every', 'Every')}</FieldLabel>
      <DraftNumberInput
        aria-label={t('flow.scene.intervalMinutes', 'Minutes')}
        className="w-20"
        value={trigger.minutes}
        onValue={(minutes) => {
          if (minutes !== null) onChange({ kind: 'interval', minutes: Math.round(minutes) })
        }}
      />
      <FieldLabel>{t('flow.scene.minutes', 'minutes')}</FieldLabel>
    </div>
  )
}

export interface StationaryPresentFieldsProps {
  readonly leaf: StationaryPresentLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: StationaryPresentLeaf) => void
}

/** "On <camera>, a <class> is parked in <zones>". */
export function StationaryPresentFields({ leaf, devices, onChange }: StationaryPresentFieldsProps) {
  const { t } = useTranslation()
  const cameras = devices.filter((d) => d.type === DeviceType.Camera)
  const setSubjects = (subjects: readonly DetectionSubject[]): void => {
    const { subjects: _dropped, ...rest } = leaf
    onChange(subjects.length === 0 ? rest : { ...rest, subjects: [...subjects] })
  }
  const setZones = (zones: readonly string[] | undefined): void => {
    const { zones: _dropped, ...rest } = leaf
    onChange(zones === undefined ? rest : { ...rest, zones: [...zones] })
  }
  const setCamera = (deviceId: number): void => {
    const { zones: _dropped, ...rest } = leaf
    onChange({ ...rest, deviceId })
  }
  return (
    <div className="space-y-3" data-testid="stationary-present-fields">
      <div className="space-y-1">
        <FieldLabel>{t('flow.scene.parkedOn', 'An object is parked on')}</FieldLabel>
        <BuildDevicePicker
          devices={cameras}
          selection="single"
          noun="camera"
          value={leaf.deviceId > 0 ? [leaf.deviceId] : []}
          testId="stationary-present-camera"
          onChange={(ids) => {
            const id = ids[0]
            if (id !== undefined && id !== leaf.deviceId) setCamera(id)
          }}
        />
      </div>
      <SubjectPicker
        subjects={leaf.subjects ?? []}
        optional
        classLabelsOnly
        verb={t('automation.whenTree.isParked', 'is parked')}
        onChange={setSubjects}
      />
      <ZonePicker
        devices={devices}
        deviceIds={leaf.deviceId > 0 ? [leaf.deviceId] : []}
        selected={leaf.zones ?? []}
        onChange={setZones}
      />
    </div>
  )
}
