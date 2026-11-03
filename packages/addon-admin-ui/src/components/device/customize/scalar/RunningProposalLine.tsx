/**
 * The running-threshold proposal in the scalar dialog (planning#405). Read-only
 * advice: Apply fills the editable fields, Save stays the only write. An
 * unanswered query is "…", never an absent proposal.
 */
import type { RunningThresholdProposal } from '@camstack/types'
import { Button } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScalarTransformDraft } from './scalar-form'

export type RunningProposalState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'error' }
  | { readonly kind: 'answer'; readonly proposal: RunningThresholdProposal }

export interface RunningProposalLineProps {
  readonly state: RunningProposalState
  readonly onApply: (transform: ScalarTransformDraft) => void
}

const DAY_MS = 86_400_000

export function RunningProposalLine({ state, onApply }: RunningProposalLineProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-[11px] text-foreground"
      data-testid="running-proposal"
    >
      <span className="text-foreground-muted">{t('customize.scalar.proposal.label')}</span>
      {state.kind === 'pending' && <span>…</span>}
      {state.kind === 'error' && (
        <span className="text-warning">{t('customize.scalar.proposal.error')}</span>
      )}
      {state.kind === 'answer' && state.proposal.state === 'proposal' && (
        <ProposalBody proposal={state.proposal} onApply={onApply} />
      )}
      {state.kind === 'answer' && state.proposal.state === 'insufficient' && (
        <span>
          {t(`customize.scalar.proposal.reason.${state.proposal.reason}`)}{' '}
          {state.proposal.fallback.kind === 'threshold' &&
            t('customize.scalar.proposal.defaults', {
              threshold: state.proposal.fallback.threshold,
              start: Math.round(state.proposal.fallback.startDwellMs / 1000),
              stop: Math.round(state.proposal.fallback.stopDwellMs / 60_000),
            })}
        </span>
      )}
    </div>
  )
}

function ProposalBody(props: {
  readonly proposal: Extract<RunningThresholdProposal, { state: 'proposal' }>
  readonly onApply: (transform: ScalarTransformDraft) => void
}): ReactNode {
  const { t } = useTranslation()
  const { transform, evidence, confidence } = props.proposal
  return (
    <>
      <span>
        {t('customize.scalar.proposal.summary', {
          runs: evidence.runsFound,
          days: Math.max(1, Math.round(evidence.spanMs / DAY_MS)),
          threshold: transform.threshold,
          start: Math.round(transform.startDwellMs / 1000),
          stop: Math.max(1, Math.round(transform.stopDwellMs / 60_000)),
        })}
      </span>
      <span className="text-foreground-muted">
        {t(`customize.scalar.proposal.confidence.${confidence}`)}
      </span>
      <Button
        size="sm"
        variant="outline"
        data-testid="running-proposal-apply"
        onClick={() => props.onApply(transform)}
      >
        {t('customize.scalar.proposal.apply')}
      </Button>
    </>
  )
}
