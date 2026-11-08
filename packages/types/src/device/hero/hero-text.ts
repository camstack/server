/** A string in both languages, as the cap vocabulary writes it (D920): no `t()` in the model. */
import { z } from 'zod'
export { t as heroText } from '../cap-vocabulary/l10n.js'

export const HeroTextSchema = z.object({ en: z.string(), it: z.string() })
export type HeroText = z.infer<typeof HeroTextSchema>
