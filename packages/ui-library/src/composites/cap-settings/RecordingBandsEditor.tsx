import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import type { JSX } from 'react'
import {
  FIRST_LEVEL_MACRO_CLASSES,
  MAX_SENSOR_TRIGGER_DEVICES,
  SOURCE_CAP_ACTIVE_FIELD,
  type ConfigDeviceMultiSelectField,
  type RecordingObjectTriggerClass,
} from '@camstack/types'
import { DeviceMultiSelectField } from '../device-select-field'
import { Plus, Trash2, Volume2, VolumeX } from 'lucide-react'
import {
  DEFAULT_EVENTS_BAND_BUFFER_SEC,
  RECORDING_AUDIO_TRIGGER_OFFERED_DBFS,
} from '@camstack/types'
import type { RecordingBand, RecordingBandMode } from '@camstack/types'
import { emptyBand, withBandAt, removeBandAt } from './recording-config-form'

interface RecordingBandsEditorProps {
  readonly bands: readonly RecordingBand[]
  readonly onChange: (bands: RecordingBand[]) => void
  /** Present when the host knows the camera — enables the sensor picker on events bands. */
  readonly sensorContext?: RecordingSensorContext
}

/** Weekday chips in display order (Mon→Sun); value is `Date.getDay()` (0=Sun). */
const WEEKDAY_VALUES: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

function weekdayLabel(t: UiTextFn, value: number): string {
  switch (value) {
    case 1:
      return t('uiLibrary.recordingBands.mon', 'Mon')
    case 2:
      return t('uiLibrary.recordingBands.tue', 'Tue')
    case 3:
      return t('uiLibrary.recordingBands.wed', 'Wed')
    case 4:
      return t('uiLibrary.recordingBands.thu', 'Thu')
    case 5:
      return t('uiLibrary.recordingBands.fri', 'Fri')
    case 6:
      return t('uiLibrary.recordingBands.sat', 'Sat')
    default:
      return t('uiLibrary.recordingBands.sun', 'Sun')
  }
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
          />
        ))
      )}
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
 * sensor of itself, and its location is what the picker suggests first.
 */
export interface RecordingSensorContext {
  readonly cameraId: number
  readonly location: string | null
  /**
   * Does this camera publish its own `recording-signal` — the LEVEL the
   * `on-device-decision` MODE follows (D380)? Asked of the camera's bindings by
   * the host, and read by `RecordingSettings` to decide whether that mode can
   * be picked. It is no longer a band trigger: a band is an HOUR, and this
   * feature has none to program. Absent = the host did not ask.
   */
  readonly deviceSignal?: DeviceSignalPresence
}

/**
 * What the host knows about the camera's `recording-signal` binding. Four
 * states, not a boolean (D315): `pending` and `unknown` must render as
 * "not yet known", never as "this camera has no signal".
 */
export type DeviceSignalPresence = 'pending' | 'present' | 'absent' | 'unknown'

/** Devices that can trigger a band: those carrying a sensor SOURCE cap (the
 *  recorder listens on exactly these — `SOURCE_CAP_ACTIVE_FIELD`) or typed
 *  `sensor`. A light or a siren is never offered. */
const SENSOR_SOURCE_CAPS: readonly string[] = Object.keys(SOURCE_CAP_ACTIVE_FIELD)

function sensorPickerField(
  t: UiTextFn,
  context: RecordingSensorContext,
): ConfigDeviceMultiSelectField {
  return {
    type: 'device-multiselect',
    key: 'sensorDeviceIds',
    label: t('uiLibrary.recordingBands.sensors', 'Sensors'),
    description: t(
      'uiLibrary.recordingBands.sensorsHint',
      'Sensors whose ACTIVE edge starts a recording — a contact opening, a PIR firing. Same-location devices are suggested first.',
    ),
    placeholder: t('uiLibrary.recordingBands.addSensor', 'Add a sensor…'),
    maxItems: MAX_SENSOR_TRIGGER_DEVICES,
    deviceFilter: {
      caps: SENSOR_SOURCE_CAPS,
      types: ['sensor'],
      excludeDeviceId: context.cameraId,
    },
    ...(context.location !== null ? { suggestLocation: context.location } : {}),
  }
}

interface BandRowProps {
  readonly band: RecordingBand
  readonly onChange: (patch: Partial<RecordingBand>) => void
  readonly onRemove: () => void
  readonly sensorContext?: RecordingSensorContext
}

function numOrUndef(value: string): number | undefined {
  return value === '' ? undefined : Number(value)
}

function BandRow({ band, onChange, onRemove, sensorContext }: BandRowProps) {
  const t = useUiText()
  const toggleDay = (value: number): void => {
    // An empty `days` means "every day" to the band engine, and every chip
    // reads ON. Materialize the full week before toggling so the first click
    // DESELECTS one day instead of isolating it.
    const current = band.days.length === 0 ? WEEKDAY_VALUES : band.days
    const days = current.includes(value) ? current.filter((d) => d !== value) : [...current, value]
    onChange({ days })
  }
  const setTriggers = (patch: Partial<NonNullable<RecordingBand['triggers']>>): void =>
    onChange({ triggers: { ...band.triggers, ...patch } })

  return (
    <div className="space-y-1.5 rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          type="time"
          aria-label={t('uiLibrary.recordingBands.start', 'Band start')}
          value={band.start}
          onChange={(e) => onChange({ start: e.target.value })}
          className="rounded-md border border-border bg-background px-1 py-0.5"
        />
        <span className="text-foreground-subtle">→</span>
        <input
          type="time"
          aria-label={t('uiLibrary.recordingBands.end', 'Band end')}
          value={band.end}
          onChange={(e) => onChange({ end: e.target.value })}
          className="rounded-md border border-border bg-background px-1 py-0.5"
        />
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
          className="text-foreground-subtle hover:text-red-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {WEEKDAY_VALUES.map((day) => {
          const on = band.days.length === 0 || band.days.includes(day)
          return (
            <button
              key={day}
              type="button"
              onClick={() => toggleDay(day)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${on ? 'bg-primary text-primary-foreground' : 'bg-surface-hover text-foreground-subtle'}`}
            >
              {weekdayLabel(t, day)}
            </button>
          )
        })}
        {band.days.length === 0 ? (
          <span className="self-center text-[10px] text-foreground-subtle">
            {t('uiLibrary.recordingBands.everyDay', 'every day')}
          </span>
        ) : null}
      </div>

      {band.mode === 'events' ? (
        <div className="space-y-1.5 border-t border-border pt-1.5">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={band.triggers?.motion ?? false}
              onChange={(e) => setTriggers({ motion: e.target.checked ? true : undefined })}
            />
            {t('uiLibrary.recordingBands.motion', 'Motion')}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
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
            <DeviceMultiSelectField
              field={sensorPickerField(t, sensorContext)}
              value={(band.triggers?.sensorDeviceIds ?? []).map(String)}
              onChange={(v) => {
                const ids = Array.isArray(v)
                  ? v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
                  : []
                setTriggers({ sensorDeviceIds: ids.length > 0 ? ids : undefined })
              }}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              {t('uiLibrary.recordingBands.postBuffer', 'Post-buffer')}
              <input
                type="number"
                min={0}
                value={band.postBufferSec ?? ''}
                placeholder={String(DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec)}
                onChange={(e) => onChange({ postBufferSec: numOrUndef(e.target.value) })}
                className="w-16 rounded-md border border-border bg-background px-1 py-1 text-xs"
              />
              s
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}
