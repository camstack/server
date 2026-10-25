/**
 * The OPTIONAL digest-rule fields an editor may REMOVE on save.
 *
 * `nc.upsertSummaryRule` MERGES a patch over the stored rule
 * (`NcSummaryStore.update`), so an omitted key keeps its stored value. Three of
 * the rule's optional fields already have a way out — `template`, `filters` and
 * `ai` take an explicit `null` on the patch — and one did not: `captionText`.
 * An editor that emptied the mosaic caption, saved and reopened found it back.
 * `clear` beside the patch names the keys to drop before the merge — the design
 * `nc.updateRule` (Plan A) and `nc.upsertTimelapseRule` already have.
 *
 * ADDON-LOCAL on purpose: the digest rule's schema lives in this addon
 * (`summary-rule.ts`), so this list travels on a bridge action this addon owns
 * and needs no types release.
 *
 * Only a key the patch cannot already remove is listed. `null` stays the clear
 * for `template` / `filters` / `ai`, and it is the one an OLDER addon also
 * understands — a `clear` it does not know is stripped by Zod, silently.
 */
import { z } from 'zod'

export const SUMMARY_RULE_CLEARABLE_KEYS = ['captionText'] as const

export const SummaryRuleClearableKeySchema = z.enum(SUMMARY_RULE_CLEARABLE_KEYS)
export type SummaryRuleClearableKey = z.infer<typeof SummaryRuleClearableKeySchema>
