/**
 * Day and night — the one daylight-phase authority, on the hub-wide Settings
 * page beside the site location it falls back on (D1103).
 *
 * Hand-written, not a derived settings form: the capability exposes
 * `getSettings` / `setSettings` methods rather than a settings schema, and the
 * card must show STATE a schema cannot (the phase in force, who decided it,
 * why the sun answered although a sensor is configured). The phase and the
 * reason are read from `getPhase`, never judged here; a query that did not
 * answer is shown as unknown or failed, never as day or night (D315).
 */

import {
  Badge,
  DeviceValuePicker,
  DurationInput,
  FormSaveBar,
  QuantityValueInput,
  SectionCard,
  SettingRow,
  Select,
  typedToStored,
  useDaylightPhaseGetPhase,
  useDaylightPhaseSetSettings,
} from '@dominevo/ui-library'
import { baseUnitForQuantity } from '@dominevo/types'
import { useQueryClient } from '@tanstack/react-query'
import { Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type DaylightDraft,
  draftOfSettings,
  pendingChanges,
  settingsOfDraft,
} from './daylight-draft'

const DAYLIGHT_KEY = [['daylightPhase']]
const LUX_BASE = baseUnitForQuantity('illuminance')
const SENSOR_REQUIRES = { caps: ['ambient-light-sensor'] } as const

export function DaylightPhaseCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useDaylightPhaseGetPhase({})
  const setSettings = useDaylightPhaseSetSettings()
  const [draft, setDraft] = useState<DaylightDraft | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const saved = status.data?.configured ?? null
  // Re-seed the draft only when the saved VALUE changes: a refetch returns a new
  // object with the same content and must not wipe an edit in progress.
  const savedKey = saved === null ? null : JSON.stringify(saved)
  useEffect(() => {
    setDraft(saved === null ? null : draftOfSettings(saved))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the value, not the identity
  }, [savedKey])

  const patch = (change: Partial<DaylightDraft>): void =>
    setDraft((prev) => (prev === null ? prev : { ...prev, ...change }))

  const save = async (): Promise<void> => {
    if (draft === null) return
    const next = settingsOfDraft(draft)
    if (next === null) return
    setFailure(null)
    try {
      await setSettings.mutateAsync(next)
      await queryClient.invalidateQueries({ queryKey: DAYLIGHT_KEY })
    } catch (err: unknown) {
      setFailure(err instanceof Error ? err.message : String(err))
    }
  }

  const phase = status.data?.phase ?? null

  return (
    <SectionCard
      headingId="settings-daylight"
      title={t('settings.daylight.title', 'Day and night')}
      icon={Sun}
      testId="settings-daylight"
    >
      <div className="space-y-3 p-3">
        {status.isError ? (
          <p role="alert" className="text-xs text-danger">
            {t('settings.daylight.readFailed', 'The current phase could not be read.')}
          </p>
        ) : status.data === undefined ? (
          <p className="text-xs text-foreground-subtle">
            {t('settings.daylight.loading', 'Reading the current phase…')}
          </p>
        ) : (
          <SettingRow label={t('settings.daylight.now', 'Now')}>
            <span className="flex flex-wrap items-center gap-2">
              {phase === null ? (
                <Badge variant="warning">{t('settings.daylight.unknown', 'Unknown')}</Badge>
              ) : (
                <Badge variant={phase.phase === 'day' ? 'success' : 'info'}>
                  {phase.phase === 'day'
                    ? t('settings.daylight.day', 'Day')
                    : t('settings.daylight.night', 'Night')}
                </Badge>
              )}
              <span className="text-xs text-foreground-muted">
                {phase === null
                  ? status.data.configured.source === 'sun'
                    ? t(
                        'settings.daylight.noLocation',
                        'The sun is the source and the site has no location.',
                      )
                    : null
                  : phase.source === 'sensor'
                    ? t('settings.daylight.decidedBySensor', 'Decided by the light sensor')
                    : t('settings.daylight.decidedBySun', 'Decided by the sun')}
              </span>
            </span>
          </SettingRow>
        )}

        {status.data?.fallbackReason != null ? (
          <p className="text-xs text-warning" data-testid="daylight-fallback">
            {t('settings.daylight.fallback', 'The sun answers instead of the sensor: {{reason}}', {
              reason: status.data.fallbackReason,
            })}
          </p>
        ) : null}

        {draft !== null ? (
          <>
            <SettingRow label={t('settings.daylight.source', 'Source')}>
              <Select
                wrapperClassName="relative w-56"
                aria-label={t('settings.daylight.source', 'Source')}
                value={draft.source}
                options={[
                  { value: 'sun', label: t('settings.daylight.sourceSun', 'Sun at the site') },
                  {
                    value: 'sensor',
                    label: t('settings.daylight.sourceSensor', 'Light sensor'),
                  },
                ]}
                onChange={(e) => patch({ source: e.target.value === 'sensor' ? 'sensor' : 'sun' })}
              />
            </SettingRow>

            {draft.source === 'sensor' && LUX_BASE === undefined ? (
              <p role="alert" className="text-xs text-danger">
                {t('settings.daylight.noLuxUnit', 'The illuminance unit is not available.')}
              </p>
            ) : null}
            {draft.source === 'sensor' && LUX_BASE !== undefined ? (
              <>
                <SettingRow label={t('settings.daylight.sensor', 'Sensor')}>
                  <DeviceValuePicker
                    requires={SENSOR_REQUIRES}
                    recentKey="daylight-sensor"
                    testId="daylight-sensor"
                    className="w-full max-w-sm"
                    value={draft.sensor}
                    onChange={(picked) =>
                      patch({
                        sensor:
                          picked === null || picked.cap === undefined || picked.path === undefined
                            ? null
                            : {
                                deviceId: picked.deviceId,
                                cap: picked.cap,
                                fieldPath: picked.path,
                              },
                      })
                    }
                  />
                </SettingRow>
                <SettingRow label={t('settings.daylight.darkBelow', 'Night below')}>
                  <QuantityValueInput
                    quantity="illuminance"
                    storedUnit={LUX_BASE}
                    value={draft.darkBelow}
                    min={0}
                    aria-label={t('settings.daylight.darkBelow', 'Night below')}
                    onChange={(typed) =>
                      patch({
                        darkBelow: typedToStored(typed, LUX_BASE).value,
                      })
                    }
                  />
                </SettingRow>
                <SettingRow label={t('settings.daylight.hysteresis', 'Day returns this far above')}>
                  <QuantityValueInput
                    quantity="illuminance"
                    storedUnit={LUX_BASE}
                    value={draft.hysteresis}
                    min={0}
                    aria-label={t('settings.daylight.hysteresis', 'Day returns this far above')}
                    onChange={(typed) =>
                      patch({
                        hysteresis: typedToStored(typed, LUX_BASE).value,
                      })
                    }
                  />
                </SettingRow>
                <SettingRow label={t('settings.daylight.minDwell', 'A phase lasts at least')}>
                  <DurationInput
                    storageUnit="min"
                    units={['hours', 'minutes']}
                    min={0}
                    max={1440}
                    value={draft.minDwellMin}
                    onChange={(minutes) => patch({ minDwellMin: minutes })}
                  />
                </SettingRow>
              </>
            ) : null}

            {failure !== null ? (
              <p role="alert" className="text-xs text-danger break-words">
                {failure}
              </p>
            ) : null}
            <FormSaveBar
              pendingCount={saved === null ? 0 : pendingChanges(saved, draft)}
              saving={setSettings.isPending}
              problem={
                draft.source === 'sensor' && draft.sensor === null
                  ? t('settings.daylight.pickSensor', 'Pick the light sensor to save.')
                  : undefined
              }
              onSave={() => void save()}
              onDiscard={() => {
                setFailure(null)
                setDraft(saved === null ? null : draftOfSettings(saved))
              }}
            />
          </>
        ) : null}
      </div>
    </SectionCard>
  )
}
