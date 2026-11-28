import { Checkbox } from '../../primitives/checkbox'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import type { JSX } from 'react'
import {
  FIRST_LEVEL_MACRO_CLASSES,
  MAX_SENSOR_TRIGGER_DEVICES,
  SOURCE_CAP_ACTIVE_FIELD,
  type RecordingObjectTriggerClass,
} from '@dominevo/types'
import { DurationInput } from '../duration-input/DurationInput'
import { bandOfTimeWindow, timeWindowOfBand } from '../time-window-input/stored-clock-range'
import { TimeWindowInput } from '../time-window-input/TimeWindowInput'
import { DeviceValuePicker } from '../device-value-picker/DeviceValuePicker'
import { deviceIdsOf, pickedFromDeviceIds } from '../device-value-picker/device-id-values'
import { FieldShell } from '../device-value-picker/device-value-form-fields'
import { Plus, Trash2, Volume2, VolumeX } from 'lucide-react'
import {
  DEFAULT_EVENTS_BAND_BUFFER_SEC,
  RECORDING_AUDIO_TRIGGER_OFFERED_DBFS,
} from '@dominevo/types'
import type { RecordingBand, RecordingBandMode, TimeWindow } from '@dominevo/types'
import {
  batteryFloorWithNoRecording,
  emptyBand,
  withBandAt,
  removeBandAt,
} from './recording-config-form'

interface RecordingBandsEditorProps {
  readonly bands: readonly RecordingBand[]
  readonly onChange: (bands: RecordingBand[]) => void
  /** Present when the host knows the camera — enables the sensor picker on events bands. */
  readonly sensorContext?: RecordingSensorContext
}

const BAND_MODE_VALUES: readonly RecordingBandMode[] = ['continuous', 'events']

function bandModeLabel(t: UiTextFn, mode: RecordingBandMode): string {
  return mode === 'continuous'
    ? t('uiLibrary.recordingBands.continuous', 'Continuous')
    : t('uiLibrary.recordingBands.events', 'Events')
}

/**
 * The band table — the ONLY authoring surface for recording intent since the
 * legacy mode/schedules/triggers/rules model was retired (2026-07-30).
 *
 * Each row is one `RecordingBand`: when it applies (weekdays + `HH:MM` span,
 * `end <= start` wraps past midnight) and how it records (continuous, or events
 * with its own triggers and pre/post buffers). No band covering *now* = nothing
 * is recorded then; "off" is the absence of a band, never a band value.
 */
export function RecordingBandsEditor({
  bands,
  onChange,
  sensorContext,
}: RecordingBandsEditorProps): JSX.Element {
  const t = useUiText()
  const batteryOperated = sensorContext?.batteryOperated === true
  const noRecordingBelow = batteryFloorWithNoRecording(bands)
  return (
    <div className="space-y-2">
      {bands.length === 0 ? (
        <p className="text-[11px] text-foreground-subtle">
          {t('uiLibrary.recordingBands.empty', 'No bands — nothing is recorded. Add one to start.')}
        </p>
      ) : (
        bands.map((band, i) => (
          <BandRow
            key={i}
            band={band}
            onChange={(patch) => onChange(withBandAt(bands, i, patch))}
            onRemove={() => onChange(removeBandAt(bands, i))}
            sensorContext={sensorContext}
            showBattery={batteryOperated || band.battery !== undefined}
          />
        ))
      )}
      {noRecordingBelow !== null ? (
        <p role="alert" className="text-[11px] text-warning">
          {t(
            'uiLibrary.recordingBands.batteryGap',
            'Below {{level}}% nothing is recorded, events included.',
            { level: noRecordingBelow },
          )}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => onChange([...bands, emptyBand()])}
        className="flex items-center gap-1 rounded-md bg-surface-hover px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> {t('uiLibrary.recordingBands.add', 'Add band')}
      </button>
    </div>
  )
}

/**
 * The camera a band belongs to, for the sensor picker: its own id is never a
 * sensor of itself, and its room is what the picker suggests first.
 */
export interface RecordingSensorContext {
  readonly cameraId: number
  /**
   * Does this camera publish its own `recording-signal` — the LEVEL the
   * `on-device-decision` MODE follows (D380)? Asked of the camera's bindings by
   * the host, and read by `RecordingSettings` to decide whether that mode can
   * be picked. It is no longer a band trigger: a band is an HOUR, and this
   * feature has none to program. Absent = the host did not ask.
   */
  readonly deviceSignal?: DeviceSignalPresence
  /**
   * Does the camera publish a `battery` charge? When true a band offers a
   * charge range. A band that already carries one always shows it, so it can
   * be removed.
   */
  readonly batteryOperated?: boolean
}

/**
 * What the host knows about the camera's `recording-signal` binding. Four
 * states, not a boolean (D315): `pending` and `unknown` must render as
 * "not yet known", never as "this camera has no signal".
 */
export type DeviceSignalPresence = 'pending' | 'present' | 'absent' | 'unknown'

/** Devices that can trigger a band: those carrying a sensor SOURCE cap — the
 *  recorder listens on exactly these (`SOURCE_CAP_ACTIVE_FIELD`). A light or a
 *  siren is never offered, nor a `sensor`-typed device without one. */
const SENSOR_SOURCE_CAPS: readonly string[] = Object.keys(SOURCE_CAP_ACTIVE_FIELD)

interface SensorPickerProps {
  readonly context: RecordingSensorContext
  readonly value: readonly number[]
  readonly onChange: (ids: readonly number[]) => void
}

/** The band's trigger sensors: the camera's own room is suggested first. */
function SensorPicker({ context, value, onChange }: SensorPickerProps): JSX.Element {
  const t = useUiText()
  return (
    <FieldShell
      label={t('uiLibrary.recordingBands.sensors', 'Sensors')}
      description={t(
        'uiLibrary.recordingBands.sensorsHint',
        'Sensors whose ACTIVE edge starts a recording — a contact opening, a PIR firing. Same-location devices are suggested first.',
      )}
    >
      <DeviceValuePicker
        multiple
        pick="device"
        requires={{ caps: SENSOR_SOURCE_CAPS, mode: 'any' }}
        contextDeviceId={context.cameraId}
        excludeIds={[context.cameraId]}
        maxItems={MAX_SENSOR_TRIGGER_DEVICES}
        recentKey="recording-band-sensors"
        placeholder={t('uiLibrary.recordingBands.addSensor', 'Add a sensor…')}
        testId="recording-band-sensors"
        value={pickedFromDeviceIds(value)}
        onChange={(picked) => onChange(deviceIdsOf(picked))}
      />
    </FieldShell>
  )
}

interface BandRowProps {
  readonly band: RecordingBand
  readonly onChange: (patch: Partial<RecordingBand>) => void
  readonly onRemove: () => void
  readonly sensorContext?: RecordingSensorContext
  readonly showBattery: boolean
}

function numOrUndef(value: string): number | undefined {
  return value === '' ? undefined : Number(value)
}

function BandRow({ band, onChange, onRemove, sensorContext, showBattery }: BandRowProps) {
  const t = useUiText()
  const setWindow = (next: TimeWindow): void => {
    // A draft the stored band cannot hold (the last day released) keeps the previous band.
    const range = bandOfTimeWindow(next)
    if (range !== null) onChange(range)
  }
  const setBattery = (patch: { min?: number | undefined; max?: number | undefined }): void => {
    const next = { ...band.battery, ...patch }
    onChange({
      battery: next.min === undefined && next.max === undefined ? undefined : next,
    })
  }
  const setTriggers = (patch: Partial<NonNullable<RecordingBand['triggers']>>): void =>
    onChange({ triggers: { ...band.triggers, ...patch } })

  return (
    <div className="space-y-1.5 rounded-md border border-border p-2">
      <TimeWindowInput
        clockOnly
        value={timeWindowOfBand(band)}
        onChange={setWindow}
        testIdPrefix="recording-band-window"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {showBattery ? (
          <span className="flex items-center gap-1">
            <span className="text-foreground-subtle">
              {t('uiLibrary.recordingBands.battery', 'Battery')}
            </span>
            <input
              type="number"
              min={0}
              max={100}
              aria-label={t('uiLibrary.recordingBands.batteryMin', 'Battery from (%)')}
              placeholder="0"
              value={band.battery?.min ?? ''}
              onChange={(e) => setBattery({ min: numOrUndef(e.target.value) })}
              className="w-14 rounded-md border border-border bg-background px-1 py-0.5"
            />
            <span className="text-foreground-subtle">–</span>
            <input
              type="number"
              min={0}
              max={100}
              aria-label={t('uiLibrary.recordingBands.batteryMax', 'Battery below (%)')}
              placeholder="100"
              value={band.battery?.max ?? ''}
              onChange={(e) => setBattery({ max: numOrUndef(e.target.value) })}
              className="w-14 rounded-md border border-border bg-background px-1 py-0.5"
            />
            <span className="text-foreground-subtle">%</span>
          </span>
        ) : null}
        <span className="flex gap-1">
          {BAND_MODE_VALUES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChange({ mode })}
              className={`rounded px-2 py-0.5 ${band.mode === mode ? 'bg-primary text-primary-foreground' : 'bg-surface-hover text-foreground-subtle'}`}
            >
              {bandModeLabel(t, mode)}
            </button>
          ))}
        </span>
        {/* Sound, or silence. Offered for BOTH modes: an events band firing on
            motion has the same question to answer as a continuous one. Absent
            means `on`, which is what every band did before this existed, so
            the OFF state here is always an explicit choice. */}
        <button
          type="button"
          aria-label={t('uiLibrary.recordingBands.audio', 'Band audio')}
          aria-pressed={band.audio !== 'muted'}
          title={
            band.audio === 'muted'
              ? t(
                  'uiLibrary.recordingBands.silentTitle',
                  'Silent — this band records the video-only stream.',
                )
              : t(
                  'uiLibrary.recordingBands.soundTitle',
                  'With sound — this band records the camera\u2019s audio.',
                )
          }
          onClick={() => onChange({ audio: band.audio === 'muted' ? 'on' : 'muted' })}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${
            band.audio === 'muted'
              ? 'bg-surface-hover text-foreground-subtle'
              : 'bg-primary/10 text-primary'
          }`}
        >
          {band.audio === 'muted' ? (
            <VolumeX className="h-3.5 w-3.5" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
          {band.audio === 'muted'
            ? t('uiLibrary.recordingBands.silent', 'Silent')
            : t('uiLibrary.recordingBands.sound', 'Sound')}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('uiLibrary.recordingBands.remove', 'Remove band')}
          className="text-foreground-subtle hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {band.mode === 'events' ? (
        <div className="space-y-1.5 border-t border-border pt-1.5">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={band.triggers?.motion ?? false}
              onChange={(e) => setTriggers({ motion: e.target.checked ? true : undefined })}
            />
            {t('uiLibrary.recordingBands.motion', 'Motion')}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={band.triggers?.audioThresholdDbfs != null}
              onChange={(e) =>
                setTriggers({
                  audioThresholdDbfs: e.target.checked
                    ? RECORDING_AUDIO_TRIGGER_OFFERED_DBFS
                    : undefined,
                })
              }
            />
            {t('uiLibrary.recordingBands.audioAbove', 'Audio above threshold')}
            {band.triggers?.audioThresholdDbfs != null ? (
              <input
                type="number"
                aria-label={t('uiLibrary.recordingBands.threshold', 'Audio threshold dBFS')}
                value={band.triggers.audioThresholdDbfs}
                onChange={(e) => setTriggers({ audioThresholdDbfs: numOrUndef(e.target.value) })}
                className="w-16 rounded-md border border-border bg-background px-1 py-0.5 text-xs"
              />
            ) : null}
            <span className="text-foreground-subtle">dBFS</span>
          </label>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-foreground-subtle">
              {t('uiLibrary.recordingBands.objects', 'Objects')}
            </span>
            {FIRST_LEVEL_MACRO_CLASSES.map((cls) => {
              const chosen = band.triggers?.objectClasses ?? []
              const on = chosen.includes(cls)
              return (
                <button
                  key={cls}
                  type="button"
                  aria-label={t('uiLibrary.recordingBands.triggerOn', 'Trigger on {{class}}', {
                    class: cls,
                  })}
                  aria-pressed={on}
                  onClick={() => {
                    const next: RecordingObjectTriggerClass[] = on
                      ? chosen.filter((c) => c !== cls)
                      : [...chosen, cls]
                    setTriggers({ objectClasses: next.length > 0 ? next : undefined })
                  }}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${on ? 'bg-primary text-primary-foreground' : 'bg-surface-hover text-foreground-subtle'}`}
                >
                  {cls}
                </button>
              )
            })}
          </div>
          {sensorContext !== undefined ? (
            <SensorPicker
              context={sensorContext}
              value={band.triggers?.sensorDeviceIds ?? []}
              onChange={(ids) =>
                setTriggers({ sensorDeviceIds: ids.length > 0 ? [...ids] : undefined })
              }
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              {t('uiLibrary.recordingBands.postBuffer', 'Post-buffer')}
              <DurationInput
                optional
                value={band.postBufferSec}
                placeholder={DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec}
                aria-label={t('uiLibrary.recordingBands.postBuffer', 'Post-buffer')}
                onChange={(postBufferSec) => onChange({ postBufferSec })}
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}
