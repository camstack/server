/**
 * Entity drafting: the pure core of "describe it, get a draft" (#375 phase 1).
 * No model call lives here — a caller supplies the model and the site.
 */
export * from './draft-types.js'
export { compareDraft } from './compare-draft.js'
export { COMPOSITION_TARGET_CAP_NAMES, compositionTargetCaps } from './composition-caps.js'
export { expandDraft } from './draft-json.js'
export {
  buildDraftPrompt,
  buildRepairPrompt,
  type DraftPrompt,
  FEW_SHOT_COUNT,
  GRAMMAR_MAX_LINES,
  grammarFor,
  selectFewShots,
} from './draft-prompt.js'
export { buildDraftJsonSchema, WHEN_UNROLL_DEPTH } from './draft-schemas.js'
export { validateDraft } from './validate-draft.js'
export { buildVocabularySlice, type SliceOptions, sliceCapOf } from './vocabulary-slice.js'
