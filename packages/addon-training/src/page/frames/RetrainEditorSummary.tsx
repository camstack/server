/**
 * The strip above the canvas: how many boxes of the open frame are in each
 * review state, as the same filled badges the list and the canvas use, the
 * "show removed" switch, and whether the frame has unsaved edits.
 *
 * A clean frame shows the SERVER's saved review (it is what the exports and the
 * viewer read); an edited one shows the live classification of the editor, so
 * the counts move as the operator works. Zero counts are dimmed (and hidden on a
 * phone, where the strip would otherwise take three lines).
 */
import { Checkbox, RetrainReviewBadge } from '@camstack/ui-library'
import type { JSX } from 'react'
import { useT } from '../../i18n/index.js'
import { BOX_DIFF_KINDS, type BoxDiffKind, type LiveReview } from './lib/retrain-live-review.js'

export interface RetrainEditorSummaryProps {
  readonly review: LiveReview
  /** The saved review's counts, shown while the editor is clean. */
  readonly savedCounts: Readonly<Partial<Record<BoxDiffKind, number>>> | null
  readonly savedApproximate: boolean
  readonly dirty: boolean
  readonly showRemoved: boolean
  readonly onShowRemovedChange: (show: boolean) => void
}

/** The counts to show: the server's while clean, the live ones once edited. Drafts are always live. */
export function summaryCounts(
  review: LiveReview,
  savedCounts: RetrainEditorSummaryProps['savedCounts'],
  dirty: boolean,
): Readonly<Record<BoxDiffKind, number>> {
  if (dirty || savedCounts === null) return review.counts
  return { ...review.counts, ...savedCounts, draft: review.counts.draft }
}

export function RetrainEditorSummary({
  review,
  savedCounts,
  savedApproximate,
  dirty,
  showRemoved,
  onShowRemovedChange,
}: RetrainEditorSummaryProps): JSX.Element {
  const { t } = useT()
  const counts = summaryCounts(review, savedCounts, dirty)
  const approximate = dirty ? review.approximate : savedApproximate
  return (
    <div
      data-testid="retrain-review-summary"
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      {BOX_DIFF_KINDS.map((kind) => {
        const n = counts[kind]
        if (kind === 'draft' && n === 0) return null
        return (
          <span
            key={kind}
            data-testid={`retrain-summary-${kind}`}
            className={`items-center gap-1 ${n === 0 ? 'hidden opacity-50 sm:inline-flex' : 'inline-flex'}`}
          >
            <RetrainReviewBadge
              kind={kind}
              size="sm"
              approximate={approximate && kind !== 'draft'}
            />
            <span className="text-[11px] tabular-nums text-foreground">{n}</span>
          </span>
        )
      })}
      <span className="flex-1" />
      {dirty && (
        <span className="text-[11px] text-warning" role="status">
          {t('editor.unsaved')}
        </span>
      )}
      <label className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
        <Checkbox
          aria-label={t('editor.showRemoved')}
          checked={showRemoved}
          onChange={(event) => {
            onShowRemovedChange(event.target.checked)
          }}
        />
        {t('editor.showRemoved')}
      </label>
    </div>
  )
}
