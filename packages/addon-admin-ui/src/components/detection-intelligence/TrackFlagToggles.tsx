/**
 * TrackFlagToggles — the two per-track operator flags on a track's detail
 * surface: `markForTrain` (this track is training material) and `debug` (this
 * track wants diagnostic attention).
 *
 * `markForTrain` PINS the track against the retention window
 * (`docs/decisions/adr-0081.md`): the track and its media stop ageing out until
 * the mark is removed. The hint says so, because a control that quietly holds
 * disk forever is worse than one that quietly does nothing. `debug` does not
 * pin — it is attention, not durability.
 *
 * The server enforces a per-device pin budget and REFUSES a new mark past it.
 * That refusal arrives as a thrown mutation, which rule 2 below already handles:
 * the toggle does not move, and the message says why.
 *
 * Three rules the tests pin, each a failure this file exists to avoid:
 *
 *  1. **One key per patch.** The same two flags are written from the viewer's
 *     track detail and cluster detail too; sending both keys would make every
 *     toggle overwrite whatever the other surface last set.
 *  2. **The server's answer is the state.** A click is a request. The toggle
 *     adopts what came back, so a refused or coerced write is visible instead of
 *     leaving the operator with a switch that lies.
 *  3. **Absent renders OFF.** A track that has never been touched omits the
 *     field; there is no third visual state to resolve.
 */
import { useState, type JSX } from 'react'
import { GraduationCap, Bug, Star } from 'lucide-react'
import { useAlert } from '@camstack/ui-library'
import {
  TRACK_FLAGS_AVAILABLE,
  TRACK_FLAGS_UNAVAILABLE_TITLE,
  toTrackFlagsResult,
  useSetTrackFlagsMutation,
  type TrackFlagsPatchInput,
  type TrackFlagsResult,
} from './use-track-flags.js'
import { useTranslation } from 'react-i18next'

export interface TrackFlagTogglesProps {
  readonly deviceId: number
  readonly trackId: string
  /** Current value from the feed row. Absent = never set = renders OFF. */
  readonly markForTrain?: boolean
  readonly debug?: boolean
  readonly favourited?: boolean
  /** Fires with the SERVER-resolved pair so the feed row can be reconciled. */
  readonly onChange?: (flags: TrackFlagsResult) => void
}

interface FlagSwitchProps {
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly title?: string
  readonly icon: JSX.Element
  readonly onToggle: () => void
}

function FlagSwitch({
  label,
  hint,
  checked,
  disabled,
  title,
  icon,
  onToggle,
}: FlagSwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors disabled:opacity-50 ${
        checked ? 'border-primary bg-primary/10' : 'border-border bg-surface hover:bg-surface-hover'
      }`}
    >
      <span className={checked ? 'text-primary' : 'text-foreground-subtle'}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-medium text-foreground">{label}</span>
        <span className="block text-[10px] text-foreground-subtle">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={`h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors ${checked ? 'bg-primary' : 'bg-border'}`}
      >
        <span
          className={`block h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-3' : ''}`}
        />
      </span>
    </button>
  )
}

export function TrackFlagToggles({
  deviceId,
  trackId,
  markForTrain,
  debug,
  favourited,
  onChange,
}: TrackFlagTogglesProps): JSX.Element {
  const { t } = useTranslation()
  const mutation = useSetTrackFlagsMutation()
  const showAlert = useAlert()
  // Server-confirmed state, once a write has landed. Until then the feed row's
  // value is authoritative — this is deliberately NOT seeded from the props in
  // an effect, because that would let a stale feed refetch undo a fresh write.
  const [confirmed, setConfirmed] = useState<TrackFlagsResult | null>(null)

  const trainOn = confirmed?.markForTrain ?? markForTrain === true
  const debugOn = confirmed?.debug ?? debug === true
  const favOn = confirmed?.favourited ?? favourited === true
  const disabled = !TRACK_FLAGS_AVAILABLE || mutation.isPending
  const unavailableTitle = TRACK_FLAGS_AVAILABLE ? undefined : TRACK_FLAGS_UNAVAILABLE_TITLE

  const apply = (flags: TrackFlagsPatchInput): void => {
    if (disabled) return
    void (async () => {
      try {
        const raw = await mutation.mutateAsync({ deviceId, trackId, flags })
        const next = toTrackFlagsResult(raw)
        if (!next) return
        setConfirmed(next)
        onChange?.(next)
      } catch (err) {
        // Leave the toggle where the server last put it. Nothing local changed,
        // so there is nothing to roll back — the switch simply did not move.
        //
        // The server's own message is shown, not a generic one: the pin budget
        // refusal names the device and the limit, and "check the server logs"
        // would hide the one failure the operator can actually act on.
        const detail = err instanceof Error ? err.message : ''
        await showAlert({
          title: t(
            'detectionIntelligence.trackFlagToggles.couldNotUpdateThisTrack',
            'Could not update this track',
          ),
          message:
            detail === ''
              ? t(
                  'detectionIntelligence.trackFlagToggles.couldNotUpdateThisTrack2',
                  'Could not update this track. Check the server logs.',
                )
              : detail,
          variant: 'danger',
        })
      }
    })()
  }

  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      <FlagSwitch
        label={t('detectionIntelligence.trackFlagToggles.markForTraining', 'Mark for training')}
        hint={t(
          'detectionIntelligence.trackFlagToggles.keepsThisTrackAndIts',
          'Keeps this track and its media past retention',
        )}
        checked={trainOn}
        disabled={disabled}
        {...(unavailableTitle !== undefined ? { title: unavailableTitle } : {})}
        icon={<GraduationCap className="h-4 w-4" />}
        onToggle={() => apply({ markForTrain: !trainOn })}
      />
      <FlagSwitch
        label={t('detectionIntelligence.trackFlagToggles.debug', 'Debug')}
        hint={t(
          'detectionIntelligence.trackFlagToggles.flagThisTrackForDiagnostic',
          'Flag this track for diagnostic attention',
        )}
        checked={debugOn}
        disabled={disabled}
        {...(unavailableTitle !== undefined ? { title: unavailableTitle } : {})}
        icon={<Bug className="h-4 w-4" />}
        onToggle={() => apply({ debug: !debugOn })}
      />
      <FlagSwitch
        label={t('detectionIntelligence.trackFlagToggles.favourited', 'Favourited')}
        hint={t(
          'detectionIntelligence.trackFlagToggles.keepsThisTrackAndIts',
          'Keeps this track and its media past retention',
        )}
        checked={favOn}
        disabled={disabled}
        {...(unavailableTitle !== undefined ? { title: unavailableTitle } : {})}
        icon={<Star className="h-4 w-4" />}
        onToggle={() => apply({ favourited: !favOn })}
      />
    </div>
  )
}
