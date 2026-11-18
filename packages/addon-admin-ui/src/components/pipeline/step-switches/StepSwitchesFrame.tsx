/**
 * The shared frame of the cluster and node step-switch cards: a `SectionCard`
 * that shows a skeleton while the matrix is pending, an error box when it
 * failed, the rows when it answered — and the failed write's message under
 * them. Pending and failed are separate from "no steps".
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ErrorBox, SectionCard, SECTION_BODY, Skeleton, TEXT_HINT } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { StepSwitchesView } from './use-step-switches'
import type { StepSwitchRow } from './step-switches-model'

interface StepSwitchesFrameProps {
  readonly headingId: string
  readonly title: string
  readonly icon: LucideIcon
  readonly hint: string
  readonly view: StepSwitchesView
  readonly writeError: string | null
  readonly children: (rows: readonly StepSwitchRow[]) => ReactNode
}

export function StepSwitchesFrame({
  headingId,
  title,
  icon,
  hint,
  view,
  writeError,
  children,
}: StepSwitchesFrameProps) {
  const { t } = useTranslation()
  return (
    <SectionCard headingId={headingId} title={title} icon={icon} testId={headingId}>
      <div className={`${SECTION_BODY} space-y-3`}>
        <p className={TEXT_HINT}>{hint}</p>
        {writeError !== null && (
          <ErrorBox
            title={t('pipeline.stepSwitches.writeFailed', 'The change was not saved')}
            message={writeError}
          />
        )}
        {view.status === 'pending' && <Skeleton className="h-16 w-full" />}
        {view.status === 'error' && (
          <ErrorBox
            title={t('pipeline.stepSwitches.loadFailed', 'Step switches did not load')}
            message={view.message}
          />
        )}
        {view.status === 'ready' && view.rows.length === 0 && (
          <p className={TEXT_HINT}>
            {t('pipeline.stepSwitches.noSteps', 'The orchestrator reports no pipeline steps.')}
          </p>
        )}
        {view.status === 'ready' && view.rows.length > 0 && children(view.rows)}
      </div>
    </SectionCard>
  )
}
