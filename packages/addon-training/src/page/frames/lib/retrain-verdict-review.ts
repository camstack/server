/**
 * What the operator's answer on a notification does to the box it was about,
 * when the frame opens — pure.
 *
 * - correct            the proposal is pre-confirmed;
 * - wrong + a class    a pending reclassification (the box carries the class
 *                      the operator named, its origin keeps the old one, so the
 *                      review reads "cat → dog");
 * - wrong, no class    the proposal stays a draft, flagged to review;
 * - wrong label        the class is kept, the label is flagged.
 *
 * Nothing here saves or exports anything: a pre-confirmed box is unsaved work
 * (the editor opens dirty), and the operator confirms by saving.
 */
import type { RetrainMacroClass, RetrainVerdict } from '@camstack/types'
import { translate } from '../../../i18n/index.js'
import type { EditorBoxInput, EditorFlag } from './retrain-editor.js'

function flagOf(
  verdict: EditorFlag['verdict'],
  reason: string,
  suggestedClass?: RetrainMacroClass,
): EditorFlag {
  return {
    verdict,
    reason,
    by: translate('verdictReview.by'),
    ...(suggestedClass !== undefined ? { suggestedClass } : {}),
  }
}

/** The proposal after the operator's answer; any other proposal is untouched. */
export function applyVerdictToDraft(
  draft: EditorBoxInput,
  verdict: RetrainVerdict | undefined,
): EditorBoxInput {
  if (verdict === undefined || draft.origin?.ref !== `pipeline:${verdict.trackId}`) return draft
  switch (verdict.verdict) {
    case 'correct':
      return {
        ...draft,
        draft: false,
        flag: flagOf('confirmed', translate('verdictReview.correct')),
      }
    case 'wrong-label':
      return { ...draft, flag: flagOf('uncertain', translate('verdictReview.wrongLabel')) }
    case 'wrong': {
      if (verdict.suggestedMacroClass === undefined) {
        return { ...draft, flag: flagOf('wrong-class', translate('verdictReview.wrong')) }
      }
      const { label: _label, subLabel: _subLabel, ...rest } = draft
      return {
        ...rest,
        macroClass: verdict.suggestedMacroClass,
        ...(verdict.suggestedLabel !== undefined ? { label: verdict.suggestedLabel } : {}),
        draft: false,
        flag: flagOf(
          'wrong-class',
          translate('verdictReview.wrongClass', {
            class: verdict.suggestedClass ?? verdict.suggestedMacroClass,
          }),
          verdict.suggestedMacroClass,
        ),
      }
    }
  }
}
