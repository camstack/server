import { useState, type JSX } from 'react'
import { Loader2, Save } from 'lucide-react'
import { CAM_PROFILE_ORDER, deriveRecordingMode, resolveRecordingProfiles } from '@camstack/types'
import type {
  RecordingBand,
  RecordingConfig,
  RecordingStorageMode,
  CamProfile,
  RecordingRetention,
} from '@camstack/types'
import {
  RecordingBandsEditor,
  type DeviceSignalPresence,
  type RecordingSensorContext,
} from './RecordingBandsEditor'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { alwaysBand } from './recording-config-form'

interface ModeSpec {
  readonly value: RecordingStorageMode
  readonly labelKey: string
  readonly labelFallback: string
}

const MODES: readonly ModeSpec[] = [
  { value: 'off', labelKey: 'uiLibrary.recordingSettings.modeOff', labelFallback: 'Off' },
  { value: 'events', labelKey: 'uiLibrary.recordingSettings.modeEvents', labelFallback: 'Events' },
  {
    value: 'continuous',
    labelKey: 'uiLibrary.recordingSettings.modeContinuous',
    labelFallback: 'Continuous',
  },
  {
    value: 'on-device-decision',
    labelKey: 'uiLibrary.recordingSettings.modeDeviceDecides',
    labelFallback: 'Device decides',
  },
]

/**
 * The `on-device-decision` mode is offered only where it can WORK — the camera
 * must publish `recording-signal`. Four states, never a boolean (D315): while
 * the answer is not yet known the button is DISABLED and says so, because a
 * mode that disappears during a query reads as a mode this camera cannot do.
 */
function deviceDecisionNote(
  presence: DeviceSignalPresence | undefined,
  t: UiTextFn,
): string | null {
  if (presence === 'present') return null
  if (presence === 'pending')
    return t('uiLibrary.recordingSettings.noteChecking', 'checking the camera…')
  if (presence === 'absent')
    return t(
      'uiLibrary.recordingSettings.noteAbsent',
      'this camera does not report when it needs recording',
    )
  // `unknown` (the query failed) and ABSENT PROP (the host never asked) are the
  // same fact — nobody looked — and neither may be spelled "this camera cannot".
  return t('uiLibrary.recordingSettings.noteUnknown', 'could not check the camera')
}

interface RecordingSettingsProps {
  readonly initial: RecordingConfig
  /** Broker-assigned profile slots for this camera (already deduped). */
  readonly availableProfiles: readonly CamProfile[]
  readonly saving: boolean
  readonly onSave: (config: RecordingConfig) => void
  /** The camera this config belongs to — enables the sensor picker on events bands. */
  readonly sensorContext?: RecordingSensorContext
}

interface CommonState {
  readonly profiles?: readonly CamProfile[]
  readonly segmentSeconds?: number
  readonly retention?: RecordingRetention
}

export function RecordingSettings({
  initial,
  availableProfiles,
  saving,
  onSave,
  sensorContext,
}: RecordingSettingsProps): JSX.Element | null {
  const t = useUiText()
  const [bands, setBands] = useState<RecordingBand[]>([...initial.bands])
  // The device-decided mode is a whole-config flag, not a band — it is the
  // authored intent that has no hour to program (D380).
  const [deviceDecision, setDeviceDecision] = useState<boolean>(initial.deviceDecision === true)
  const [common, setCommon] = useState<CommonState>({
    profiles: initial.profiles,
    segmentSeconds: initial.segmentSeconds,
    retention: initial.retention,
  })

  const ret = common.retention ?? {}
  const setRet = (patch: Partial<RecordingRetention>): void =>
    setCommon({ ...common, retention: { ...ret, ...patch } })
  const numOrUndef = (v: string): number | undefined => (v === '' ? undefined : Number(v))

  const derivedMode = deriveRecordingMode({
    enabled: deviceDecision || bands.length > 0,
    bands,
    deviceDecision,
  })
  const signalPresence = sensorContext?.deviceSignal
  // Already on? Always offerable, so it can always be switched OFF (D62) —
  // whatever the presence query knows today.
  const deviceDecisionSettled = signalPresence === 'present' || deviceDecision
  const selectedProfiles = resolveRecordingProfiles(availableProfiles, common.profiles)

  const toggleProfile = (profile: CamProfile): void => {
    const next = selectedProfiles.includes(profile)
      ? selectedProfiles.filter((x) => x !== profile)
      : [...selectedProfiles, profile]
    setCommon({ ...common, profiles: next.length ? next : undefined })
  }

  const setMode = (mode: RecordingStorageMode): void => {
    if (mode === 'off') {
      setBands([])
      setDeviceDecision(false)
      return
    }
    if (mode === 'on-device-decision') {
      // Exclusive with bands: the schema refuses the two together, because two
      // authorities over the same camera's recording is the D62 failure.
      setBands([])
      setDeviceDecision(true)
      return
    }
    setDeviceDecision(false)
    if (mode === derivedMode) return
    setBands([alwaysBand(mode)])
  }

  const handleSave = (): void => {
    const profiles =
      availableProfiles.length > 0
        ? resolveRecordingProfiles(availableProfiles, common.profiles)
        : common.profiles
          ? [...common.profiles]
          : undefined
    onSave({
      enabled: deviceDecision || bands.length > 0,
      bands: deviceDecision ? [] : bands,
      ...(deviceDecision ? { deviceDecision: true } : {}),
      ...(profiles !== undefined ? { profiles } : {}),
      segmentSeconds: common.segmentSeconds,
      retention: common.retention,
    })
  }

  const visibleProfiles = CAM_PROFILE_ORDER.filter((p) => availableProfiles.includes(p))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-foreground-subtle">
          {t('uiLibrary.recordingSettings.mode', 'Mode:')}
        </span>
        {MODES.map((m) => {
          const gated = m.value === 'on-device-decision'
          const note = gated ? deviceDecisionNote(signalPresence, t) : null
          return (
            <button
              key={m.value}
              type="button"
              aria-label={t('uiLibrary.recordingSettings.modeAria', 'Mode {{label}}', {
                label: t(m.labelKey, m.labelFallback),
              })}
              title={note ?? undefined}
              disabled={gated && !deviceDecisionSettled}
              onClick={() => setMode(m.value)}
              className={`rounded px-2.5 py-1 ${derivedMode === m.value ? 'bg-primary text-primary-foreground' : 'bg-surface-hover text-foreground-subtle'} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {t(m.labelKey, m.labelFallback)}
            </button>
          )
        })}
      </div>

      {deviceDecision ? (
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'uiLibrary.recordingSettings.deviceDecides',
            'The DEVICE decides: this camera records for as long as it reports it is in function — a robot while it cleans — and one job is one clip. There is nothing to schedule, so this mode has no bands.',
          )}
        </p>
      ) : (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
            {t('uiLibrary.recordingSettings.bands', 'Recording bands')}
          </div>
          <RecordingBandsEditor bands={bands} onChange={setBands} sensorContext={sensorContext} />
          <p className="mt-1.5 text-[11px] text-foreground-subtle">
            {t(
              'uiLibrary.recordingSettings.bandsHint',
              'A band says WHEN to record and HOW. Nothing is recorded outside every band — an empty table means this camera is off.',
            )}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs">
        {visibleProfiles.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-foreground-subtle">
              {t('uiLibrary.recordingSettings.profiles', 'Profiles:')}
            </span>
            {visibleProfiles.map((p) => {
              const on = selectedProfiles.includes(p)
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleProfile(p)}
                  className={`rounded px-2 py-1 ${on ? 'bg-primary text-primary-foreground' : 'bg-surface-hover text-foreground-subtle'}`}
                >
                  {p}
                </button>
              )
            })}
          </div>
        ) : (
          <span className="text-foreground-subtle">
            {t('uiLibrary.recordingSettings.noStreams', 'No assigned streams to record yet.')}
          </span>
        )}
        <label className="flex items-center gap-1">
          {t('uiLibrary.recordingSettings.segment', 'Segment')}
          <input
            type="number"
            min={1}
            value={common.segmentSeconds ?? ''}
            placeholder={t('uiLibrary.recordingSettings.default', 'default')}
            onChange={(e) => setCommon({ ...common, segmentSeconds: numOrUndef(e.target.value) })}
            className="w-16 rounded-md border border-border bg-background px-1 py-1 text-xs"
          />
          s
        </label>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
          {t('uiLibrary.recordingSettings.retention', 'Retention (empty = node default)')}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            {t('uiLibrary.recordingSettings.maxAge', 'Max age')}
            <input
              type="number"
              min={0}
              value={ret.maxAgeDays ?? ''}
              placeholder="14"
              onChange={(e) => setRet({ maxAgeDays: numOrUndef(e.target.value) })}
              className="w-16 rounded-md border border-border bg-background px-1 py-1 text-xs"
            />
            {t('uiLibrary.recordingSettings.days', 'days')}
          </label>
          <label className="flex items-center gap-1">
            {t('uiLibrary.recordingSettings.maxSize', 'Max size')}
            <input
              type="number"
              min={0}
              value={ret.maxSizeGb ?? ''}
              placeholder="∞"
              onChange={(e) => setRet({ maxSizeGb: numOrUndef(e.target.value) })}
              className="w-16 rounded-md border border-border bg-background px-1 py-1 text-xs"
            />
            GB
          </label>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t('uiLibrary.recordingSettings.save', 'Save')}
        </button>
      </div>
    </div>
  )
}
