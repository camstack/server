/**
 * The fields of a `device-fired` row (D1045): the device, then what it
 * declares it can fire — the part that fires (a button) and the event.
 *
 * The choices are the device's own vocabulary, read from its `event-emitter`
 * slice. Until that read answers the selects say so and offer nothing: a
 * device whose vocabulary is not known yet must not look like one with no
 * events (D315).
 */
import type { DeviceFiredLeaf } from '@camstack/types'
import { DeviceValuePicker, Select, useDeviceStateGetCapSlice } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { PickerLabel } from './FieldPicker'
import {
  EVENT_EMITTER_CAP,
  firedEvents,
  firedSources,
  firedVocabularyOf,
  staleFiredPicks,
  withFiredDevice,
  withFiredEvent,
  withFiredSource,
} from './fired-model'

export interface FiredFieldsProps {
  readonly leaf: DeviceFiredLeaf
  /** The device is fixed by the caller (a template input names it): only its events are offered. */
  readonly hideDevice?: boolean
  readonly onChange: (next: DeviceFiredLeaf) => void
}

const ANY = ''
const REQUIRES = { caps: [EVENT_EMITTER_CAP] } as const

export function FiredFields({ leaf, hideDevice = false, onChange }: FiredFieldsProps) {
  const { t } = useTranslation()
  const hasDevice = leaf.deviceId > 0
  const query = useDeviceStateGetCapSlice(
    { deviceId: leaf.deviceId, capName: EVENT_EMITTER_CAP },
    { enabled: hasDevice },
  )
  const state = firedVocabularyOf({ status: query.status, data: query.data })
  const vocabulary = state.kind === 'known' ? state.vocabulary : []
  const sources = firedSources(vocabulary)
  const sourceId = leaf.sourceIds?.[0]
  const eventId = leaf.eventIds?.[0]
  const events = firedEvents(vocabulary, sourceId)
  const stale = state.kind === 'known' ? staleFiredPicks(leaf, vocabulary) : null
  const anyEvent = t('automation.fired.anyEvent', 'Any event')
  const waiting =
    state.kind === 'pending'
      ? t('automation.fired.loading', 'Reading what this device can fire…')
      : t('automation.fired.unknown', 'What this device can fire could not be read.')

  return (
    <>
      {!hideDevice && (
        <div className="min-w-[13rem] flex-1">
          <PickerLabel>{t('automation.fired.device', 'Device')}</PickerLabel>
          <DeviceValuePicker
            pick="device"
            requires={REQUIRES}
            recentKey="automation-device-fired"
            value={hasDevice ? { deviceId: leaf.deviceId } : null}
            onChange={(next) => onChange(withFiredDevice(leaf, next?.deviceId ?? 0))}
          />
        </div>
      )}
      {hasDevice && state.kind !== 'known' && (
        <p
          className={`min-w-[13rem] flex-1 text-xs ${state.kind === 'unknown' ? 'text-warning' : 'text-foreground-subtle'}`}
          data-testid={`fired-vocabulary-${state.kind}`}
        >
          {waiting}
        </p>
      )}
      {hasDevice && state.kind === 'known' && sources.length > 0 && (
        <label className="min-w-[11rem] flex-1">
          <PickerLabel>{t('automation.fired.source', 'From')}</PickerLabel>
          <Select
            data-testid="fired-source"
            value={sourceId ?? ANY}
            onChange={(e) =>
              onChange(
                withFiredSource(
                  leaf,
                  e.target.value === ANY ? undefined : e.target.value,
                  vocabulary,
                ),
              )
            }
            options={[
              { value: ANY, label: t('automation.fired.anySource', 'Any button') },
              ...sources.map((source) => ({ value: source.id, label: source.label })),
              ...(stale?.sourceIds ?? []).map((id) => ({
                value: id,
                label: t('automation.fired.gone', '{{id}} (no longer declared)', { id }),
              })),
            ]}
          />
        </label>
      )}
      {hasDevice && state.kind === 'known' && (
        <label className="min-w-[11rem] flex-1">
          <PickerLabel>{t('automation.fired.event', 'Event')}</PickerLabel>
          <Select
            data-testid="fired-event"
            value={eventId ?? ANY}
            onChange={(e) =>
              onChange(withFiredEvent(leaf, e.target.value === ANY ? undefined : e.target.value))
            }
            options={[
              { value: ANY, label: anyEvent },
              ...events.map((entry) => ({ value: entry.id, label: entry.label })),
              ...(stale?.eventIds ?? []).map((id) => ({
                value: id,
                label: t('automation.fired.gone', '{{id}} (no longer declared)', { id }),
              })),
            ]}
          />
        </label>
      )}
      {stale !== null && stale.sourceIds.length + stale.eventIds.length > 0 && (
        <p className="basis-full text-xs text-warning" data-testid="fired-stale">
          {t(
            'automation.fired.staleHint',
            'This row names something the device no longer declares, so it will not start a run. Pick again.',
          )}
        </p>
      )}
      {(leaf.kinds !== undefined || leaf.match !== undefined) && (
        <p className="basis-full text-xs text-foreground-subtle" data-testid="fired-extra">
          {t(
            'automation.fired.extraHint',
            'This row also carries filters set outside the editor ({{what}}); they are kept as they are.',
            {
              what: [
                ...(leaf.kinds ?? []),
                ...(leaf.match ?? []).map((m) => `${m.path} = ${String(m.equals)}`),
              ].join(', '),
            },
          )}
        </p>
      )}
    </>
  )
}
