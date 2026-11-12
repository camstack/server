/** A string in both languages, as the cap vocabulary writes it (D920): no `t()` in the model. */
import { z } from 'zod'
export { t as heroText } from '../cap-vocabulary/l10n.js'

export const HeroTextSchema = z.object({ en: z.string(), it: z.string() })
export type HeroText = z.infer<typeof HeroTextSchema>

/**
 * What a device that has not reported says in place of its value: an empty "—",
 * never a word like "Unknown" and never a 0 (D393). The card stays its normal
 * self; only the value is empty.
 */
export const NOT_REPORTED: HeroText = { en: '—', it: '—' }

/** Whether `text` is {@link NOT_REPORTED}: a client may leave such a slot out instead of painting a dash twice. */
export function isNotReported(text: HeroText): boolean {
  return text.en === NOT_REPORTED.en && text.it === NOT_REPORTED.it
}
