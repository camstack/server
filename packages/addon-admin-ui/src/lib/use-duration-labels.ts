/** The names of the three fields of a `DurationPartsInput`, in the operator's language. */
import type { DurationPartLabels } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

export function useDurationLabels(): DurationPartLabels {
  const { t } = useTranslation()
  return {
    hours: t('common.durationHours'),
    minutes: t('common.durationMinutes'),
    seconds: t('common.durationSeconds'),
  }
}
