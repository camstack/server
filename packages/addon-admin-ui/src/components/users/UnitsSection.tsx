/**
 * "Units" on My access: how this user's readings are shown. Two independent
 * choices, stored as the account preference `admin.units` so every device the
 * user signs in on shows the same units. Stored values never change — only the
 * label and the conversion at display time (D944).
 */
import { useState, type ReactElement } from 'react'
import { Ruler } from 'lucide-react'
import { DISPLAY_PREFERENCES, type DisplayPreference } from '@camstack/types'
import {
  ErrorBox,
  Select,
  SectionCard,
  SettingRow,
  TEMPERATURE_SCALES,
  useAccountUnitPreferences,
  type TemperatureScale,
  type UnitPreferences,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

function isSystem(value: string): value is DisplayPreference {
  return DISPLAY_PREFERENCES.some((candidate) => candidate === value)
}

function isScale(value: string): value is TemperatureScale {
  return TEMPERATURE_SCALES.some((candidate) => candidate === value)
}

export function UnitsSection(): ReactElement {
  const { t } = useTranslation()
  const prefs = useAccountUnitPreferences()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const save = (change: Partial<UnitPreferences>): void => {
    setSaving(true)
    setFailure(null)
    prefs
      .update(change)
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false))
  }

  const locked = prefs.status !== 'ok' || !prefs.writable || saving

  return (
    <SectionCard
      headingId="my-access-units"
      title={t('systemPage.myAccess.units.title', 'Units')}
      icon={Ruler}
      testId="my-access-units"
    >
      <div className="space-y-2 p-3">
        <p className="text-xs text-foreground-subtle">
          {t(
            'systemPage.myAccess.units.description',
            'How readings are shown to you, on every device you sign in on. Stored values do not change.',
          )}
        </p>
        {prefs.status === 'error' && (
          <ErrorBox
            message={t(
              'systemPage.myAccess.units.loadError',
              'Your unit preferences could not be read.',
            )}
          />
        )}
        {prefs.status === 'ok' && !prefs.writable && (
          <ErrorBox
            message={t(
              'systemPage.myAccess.units.unreadable',
              'The saved unit preferences are in a format this version cannot read, so they are left untouched.',
            )}
          />
        )}
        {failure !== null && <ErrorBox message={failure} />}
        <SettingRow label={t('systemPage.myAccess.units.temperature', 'Temperature')}>
          <Select
            aria-label={t('systemPage.myAccess.units.temperature', 'Temperature')}
            value={prefs.value.temperature}
            disabled={locked}
            onChange={(e) => {
              const next = e.target.value
              if (isScale(next)) save({ temperature: next })
            }}
            options={[
              {
                value: 'celsius',
                label: t('systemPage.myAccess.units.celsius', 'Celsius (°C)'),
              },
              {
                value: 'fahrenheit',
                label: t('systemPage.myAccess.units.fahrenheit', 'Fahrenheit (°F)'),
              },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('systemPage.myAccess.units.system', 'Other measurements')}>
          <Select
            aria-label={t('systemPage.myAccess.units.system', 'Other measurements')}
            value={prefs.value.system}
            disabled={locked}
            onChange={(e) => {
              const next = e.target.value
              if (isSystem(next)) save({ system: next })
            }}
            options={[
              {
                value: 'metric',
                label: t('systemPage.myAccess.units.metric', 'Metric (km/h, hPa, mm)'),
              },
              {
                value: 'imperial',
                label: t('systemPage.myAccess.units.imperial', 'Imperial (mph, inHg, in)'),
              },
            ]}
          />
        </SettingRow>
      </div>
    </SectionCard>
  )
}
