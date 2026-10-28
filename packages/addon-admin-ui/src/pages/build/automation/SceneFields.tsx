/**
 * The scene blocks: the detection and stationary (parked object) triggers, the
 * interval trigger, and the "an object is parked" condition.
 *
 * Each editor builds its recipe part with the optional keys OMITTED when unset
 * (the recipe is serialised into the generated file, and the schema takes a
 * key's absence, not `undefined`, as "any").
 */

import type { AutomationConditionStationaryPresent, AutomationTrigger } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { SegmentedChoice } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { FixedSelect } from '../flow/FixedSelect'
import { CameraPicker, ClassChips, FieldLabel, ZonePicker } from '../flow/scene-pickers'
import type { AutomationDevice } from './automation-data'

type DetectionTrigger = Extract<AutomationTrigger, { kind: 'detection' }>
type StationaryTrigger = Extract<AutomationTrigger, { kind: 'stationary' }>
type IntervalTrigger = Extract<AutomationTrigger, { kind: 'interval' }>
type Phase = StationaryTrigger['phase']

const PERCENT = 100

export interface DetectionFieldsProps {
  readonly trigger: DetectionTrigger
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: DetectionTrigger) => void
}

export function DetectionFields({ trigger, devices, onChange }: DetectionFieldsProps) {
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
      <ClassChips
        selected={trigger.classes}
        onChange={(classes) => onChange({ ...trigger, classes: [...classes] })}
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
  readonly trigger: StationaryTrigger
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: StationaryTrigger) => void
}

export function StationaryFields({ trigger, devices, onChange }: StationaryFieldsProps) {
  const { t } = useTranslation()
  const setClasses = (classes: readonly string[]): void => {
    const { classes: _dropped, ...rest } = trigger
    onChange(classes.length === 0 ? rest : { ...rest, classes: [...classes] })
  }
  const setZones = (zones: readonly string[] | undefined): void => {
    const { zones: _dropped, ...rest } = trigger
    onChange(zones === undefined ? rest : { ...rest, zones: [...zones] })
  }
  return (
    <div className="w-full space-y-3" data-testid="stationary-fields">
      <ClassChips
        selected={trigger.classes ?? []}
        onChange={setClasses}
        hint={
          trigger.classes === undefined
            ? t('flow.scene.anyClass', 'None picked: any class counts.')
            : undefined
        }
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
          { value: 'appeared', label: t('flow.scene.phaseAppeared', 'Stopped (parked)') },
          { value: 'departed', label: t('flow.scene.phaseDeparted', 'Left') },
        ]}
      />
    </div>
  )
}

export interface IntervalFieldsProps {
  readonly trigger: IntervalTrigger
  readonly onChange: (next: IntervalTrigger) => void
}

export function IntervalFields({ trigger, onChange }: IntervalFieldsProps) {
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
  readonly leaf: AutomationConditionStationaryPresent
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationConditionStationaryPresent) => void
}

/** "On <camera>, a <class> is parked in <zones>". */
export function StationaryPresentFields({ leaf, devices, onChange }: StationaryPresentFieldsProps) {
  const { t } = useTranslation()
  const cameras = devices.filter((d) => d.type === DeviceType.Camera)
  const setClasses = (classes: readonly string[]): void => {
    const { classes: _dropped, ...rest } = leaf
    onChange(classes.length === 0 ? rest : { ...rest, classes: [...classes] })
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
        <FixedSelect
          widthClass="w-48"
          aria-label={t('flow.scene.camera', 'Camera')}
          value={leaf.deviceId > 0 ? String(leaf.deviceId) : ''}
          options={[
            { value: '', label: t('flow.scene.pickCamera', 'Pick a camera') },
            ...cameras.map((c) => ({ value: String(c.id), label: c.name })),
          ]}
          onChange={(e) => {
            if (e.target.value !== '') setCamera(Number(e.target.value))
          }}
        />
      </div>
      <ClassChips
        selected={leaf.classes ?? []}
        onChange={setClasses}
        hint={
          leaf.classes === undefined
            ? t('flow.scene.anyClass', 'None picked: any class counts.')
            : undefined
        }
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
