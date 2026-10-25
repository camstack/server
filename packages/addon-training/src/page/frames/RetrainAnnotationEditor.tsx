/**
 * The subject list — every box of the open frame, one line each, in the same
 * colours as the canvas (`RetrainSubjectRow`), plus the proposals the operator
 * deleted when "show removed" is on.
 *
 * **A model_error is a first-class kind.** A false positive is taught by
 * OMISSION: the frame enters the dataset fully annotated and deliberately
 * WITHOUT the box the model drew, and a model-error row is what records that
 * the omission was deliberate — with the model and score that produced the
 * phantom.
 *
 * **A draft says so.** A machine proposal carries its source, its model and
 * score, and why it is there; it has an Accept button and is not saved until
 * it is accepted or corrected.
 */

import { RetrainReviewBadge } from '@camstack/ui-library'
import type { JSX } from 'react'
import { Trans } from '../../i18n/index.js'
import { boxLook } from './lib/retrain-box-look.js'
import type { EditorBox, EditorBoxPatch } from './lib/retrain-editor.js'
import type { Hover } from './lib/retrain-hover.js'
import type { LiveReview } from './lib/retrain-live-review.js'
import type { VocabularyEntry } from './lib/retrain-vocabulary.js'
import { RetrainSourceIcon } from './RetrainSourceIcon.js'
import { RetrainSubjectRow } from './RetrainSubjectRow.js'

export { annotationsAreValid, MACRO_CLASSES } from './RetrainSubjectRow.js'

export interface RetrainAnnotationEditorProps {
  readonly boxes: readonly EditorBox[]
  readonly selectedKey: string | null
  readonly review?: LiveReview | null
  readonly showRemoved?: boolean
  readonly hover?: Hover | null
  readonly vocabulary?: readonly VocabularyEntry[]
  readonly onHover?: (hover: Hover | null) => void
  readonly onSelect: (key: string) => void
  readonly onChange: (key: string, patch: EditorBoxPatch) => void
  readonly onEditStart?: () => void
  readonly onEditLive?: (key: string, patch: EditorBoxPatch) => void
  readonly onEditEnd?: () => void
  readonly onAccept: (key: string) => void
  readonly onToggleModelError: (key: string) => void
  readonly onDelete: (key: string) => void
}

const NO_VOCABULARY: readonly VocabularyEntry[] = []

export function RetrainAnnotationEditor({
  boxes,
  selectedKey,
  review = null,
  showRemoved = true,
  hover = null,
  vocabulary = NO_VOCABULARY,
  onHover = () => undefined,
  onSelect,
  onChange,
  onEditStart = () => undefined,
  onEditLive,
  onEditEnd = () => undefined,
  onAccept,
  onToggleModelError,
  onDelete,
}: RetrainAnnotationEditorProps): JSX.Element {
  const removed = showRemoved ? (review?.removed ?? []) : []
  if (boxes.length === 0 && removed.length === 0) {
    return (
      <p className="p-3 text-[11px] text-foreground-subtle">
        <Trans i18nKey="annotationEditor.empty" components={{ b: <strong /> }} />
      </p>
    )
  }
  const live = onEditLive ?? ((key, patch) => onChange(key, patch))
  const removedLook = boxLook('removed')
  return (
    <ul data-testid="retrain-subject-list">
      {boxes.map((box) => (
        <RetrainSubjectRow
          key={box.key}
          box={box}
          diff={review?.byKey.get(box.key)}
          selected={box.key === selectedKey}
          hover={hover}
          vocabulary={vocabulary}
          onHover={onHover}
          onSelect={onSelect}
          onChange={onChange}
          onEditStart={onEditStart}
          onEditLive={live}
          onEditEnd={onEditEnd}
          onAccept={onAccept}
          onToggleModelError={onToggleModelError}
          onDelete={onDelete}
        />
      ))}
      {removed.map((ghost) => (
        <li
          key={`removed-${ghost.ref}`}
          data-testid={`retrain-removed-${ghost.ref}`}
          className="flex h-9 items-center gap-2 border-b border-border px-2 last:border-b-0"
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: removedLook.stroke }} // ui-check-ok: the removed stroke token, as a chip
          />
          <RetrainReviewBadge kind="removed" size="sm" approximate={ghost.approximate} />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground-muted line-through">
            {ghost.label}
          </span>
          <RetrainSourceIcon
            source={ghost.source}
            size={14}
            className="shrink-0 text-foreground-subtle"
          />
        </li>
      ))}
    </ul>
  )
}
