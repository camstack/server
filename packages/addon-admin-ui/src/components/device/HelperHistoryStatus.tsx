/**
 * A statistic or integral on its device page: the reading history wrote,
 * and how many intervals were left out because history had a gap (D944).
 */
import type { IntegralHelperSpec, StatisticHelperSpec } from '@camstack/types'
import { ErrorBox, SECTION_BODY, SectionCard, StatCard } from '@camstack/ui-library'
import { BarChart3 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { groupStatusFromSnapshot, type SnapshotRead } from '../composition-editor/helper-form-model'

export interface HistoryHelperStatusProps {
  readonly helper: StatisticHelperSpec | IntegralHelperSpec
  readonly snapshot: SnapshotRead
}

export function HistoryHelperStatus({ helper, snapshot }: HistoryHelperStatusProps): ReactNode {
  const { t } = useTranslation()
  const status = groupStatusFromSnapshot(snapshot)
  const value = readingOf(snapshot, helper)
  return (
    <SectionCard
      headingId="helper-history-status"
      title={t(
        helper.kind === 'statistic' ? 'helper.template.statistic' : 'helper.template.integral',
      )}
      icon={BarChart3}
      testId="helper-history-status"
    >
      <div className={`${SECTION_BODY} flex flex-col gap-3`}>
        {value.kind === 'pending' && (
          <p role="status" className="text-xs text-foreground-subtle">
            {t('helper.outputPending')}
          </p>
        )}
        {value.kind === 'number' && (
          <StatCard value={String(value.value)} label={t('helper.output')} />
        )}
        {value.kind === 'empty' && (
          <p className="text-xs text-foreground-subtle">{t('helper.noReading')}</p>
        )}
        {status.kind === 'ready' && status.excluded > 0 && (
          <p className="text-xs text-foreground-muted" data-testid="helper-history-gaps">
            {t('helper.gaps', { count: status.excluded })}
          </p>
        )}
        {status.kind === 'unavailable' && (
          <ErrorBox title={t('helper.outputUnavailable')} message={status.message} />
        )}
      </div>
    </SectionCard>
  )
}

function readingOf(
  snapshot: SnapshotRead,
  helper: StatisticHelperSpec | IntegralHelperSpec,
):
  | { readonly kind: 'pending' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly value: number } {
  if (snapshot.kind === 'pending') return { kind: 'pending' }
  if (snapshot.kind !== 'answered') return { kind: 'empty' }
  const output =
    helper.kind === 'statistic'
      ? { cap: 'numeric-sensor', field: 'value' }
      : helper.output === 'energy'
        ? { cap: 'power-meter', field: 'kwhTotal' }
        : { cap: 'meter', field: 'value' }
  const value = snapshot.caps[output.cap]?.[output.field]
  return typeof value === 'number' && Number.isFinite(value)
    ? { kind: 'number', value }
    : { kind: 'empty' }
}
