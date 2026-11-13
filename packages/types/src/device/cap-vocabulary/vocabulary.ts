/**
 * THE cap vocabulary (D920): one complete, cap-keyed map of what every
 * capability lets an operator DO to a device and WATCH it for — so a picker,
 * a script editor and a phrase renderer all read one map.
 *
 * Declared on the caps, generated here (D1050): an action sits on the method
 * it calls, an event's wording on the event, the rest in the cap's
 * `vocabulary` block (`declaration.ts`); `npm run codegen` projects them into
 * `generated/cap-vocabulary.ts`, typed {@link CapVocabularyMap} — a cap with
 * no entry, or a name its cap does not have, is a TypeScript error there.
 * Nothing hand-writes an entry (`scripts/check-no-handwritten-cap-vocabulary.ts`).
 */
import { CAP_VOCABULARY } from '../../generated/cap-vocabulary.js'
import type { CapVocabularyMap, LooseCapVocabularyEntry } from './types.js'

export { CAP_VOCABULARY }

/** The same map, read by a string cap name (a binding names caps as strings). */
export const CAP_VOCABULARY_BY_NAME: Readonly<Record<string, LooseCapVocabularyEntry>> =
  CAP_VOCABULARY satisfies CapVocabularyMap
