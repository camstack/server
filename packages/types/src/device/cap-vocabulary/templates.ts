/**
 * The sentence frames the resolver fills from an entry: how a numeric field
 * rises above / falls below / changes by, how an enum or free value
 * "becomes", and the "for N minutes" hold. One frame per language, so the
 * entries only name the quantity ("the temperature" / "la temperatura") and
 * the grammar stays here.
 */
import { t } from './l10n.js'
import type { L10n } from './types.js'

/** Placeholders: `{quantity}` (with its article), `{device}`, `{threshold}`, `{delta}`. */
export const NUMERIC_ABOVE: L10n = t(
  'When {quantity} of {device} rises above {threshold}',
  'Quando {quantity} di {device} sale sopra {threshold}',
)
export const NUMERIC_BELOW: L10n = t(
  'When {quantity} of {device} falls below {threshold}',
  'Quando {quantity} di {device} scende sotto {threshold}',
)
export const NUMERIC_CHANGES_BY: L10n = t(
  'When {quantity} of {device} changes by {delta}',
  'Quando {quantity} di {device} varia di {delta}',
)

/** Placeholders: `{device}`, `{value}` (the value's label). */
export const BECOMES: L10n = t(
  'When {device} changes to {value}',
  'Quando {device} passa a {value}',
)

/** Placeholders: `{trigger}` (a whole trigger phrase), `{minutes}`. */
export const HELD_FOR: L10n = t(
  '{trigger} and stays that way for {minutes} minutes',
  '{trigger} e resta così per {minutes} minuti',
)

/** Every frame, for the completeness test. */
export const VOCAB_TEMPLATES: Readonly<Record<string, L10n>> = {
  NUMERIC_ABOVE,
  NUMERIC_BELOW,
  NUMERIC_CHANGES_BY,
  BECOMES,
  HELD_FOR,
}
