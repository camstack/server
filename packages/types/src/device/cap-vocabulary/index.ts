/**
 * The cap vocabulary (D920) — what every capability lets an operator DO to a
 * device and WATCH it for, in one cap-keyed map outside the caps.
 */
export type {
  ResolvedBooleanTrigger,
  ResolvedEnumTrigger,
  ResolvedEnumValue,
  ResolvedEventTrigger,
  ResolvedNumericTrigger,
  ResolvedValueTrigger,
  ResolvedVocabAction,
  ResolvedVocabTrigger,
  VocabBindingsInput,
} from './resolve.js'
export {
  actionsForDevice,
  renderVocabPhrase,
  triggersForDevice,
} from './resolve.js'
export type { ActionEffect, IndexedVocabAction } from './action-index.js'
export {
  actionEffect,
  allVocabActions,
  findVocabAction,
  vocabActionIdFor,
} from './action-index.js'
export { VOCAB_TEMPLATES } from './templates.js'
export type {
  ActionArgKey,
  ActionArgs,
  BooleanOffer,
  CapEventName,
  CapMethodName,
  CapStatusField,
  CapVocabularyEntry,
  CapVocabularyMap,
  CapVocabularySlice,
  DeviceCapVocabulary,
  DeviceVocabCapName,
  DynamicOffer,
  EnumOffer,
  EnumStateValue,
  L10n,
  LooseCapVocabularyEntry,
  LooseDynamicOffer,
  LooseVocabAction,
  LooseVocabEffect,
  LooseVocabOffer,
  LooseVocabOpenArg,
  LooseVocabStateTrigger,
  NumberOffer,
  SystemCapVocabulary,
  SystemVocabCapName,
  TextOffer,
  VocabAction,
  VocabCapName,
  VocabChoice,
  VocabEffectFor,
  VocabEffectValue,
  VocabEventTrigger,
  VocabIcon,
  VocabLocale,
  VocabOffer,
  VocabOpenArg,
  VocabStateTrigger,
} from './types.js'
export { CAP_VOCABULARY, CAP_VOCABULARY_BY_NAME } from './vocabulary.js'
