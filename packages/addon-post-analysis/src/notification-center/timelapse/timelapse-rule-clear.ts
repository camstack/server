/**
 * The OPTIONAL timelapse-rule fields an editor may REMOVE on save.
 *
 * `nc.upsertTimelapseRule` MERGES a patch over the stored rule, so an omitted
 * key keeps its stored value: an editor that emptied the preview caption, saved
 * and reopened found it back. `clear` beside the patch names the keys to drop
 * before the merge — the design `nc.updateRule` already has
 * (`NcRuleUpdateInputSchema` / `NcRuleStore.update`, Plan A).
 *
 * ADDON-LOCAL on purpose: the timelapse rule rides no cap method (see
 * `timelapse-rule.ts` in `@camstack/types`), so this list travels on a bridge
 * action this addon owns and needs no types release.
 *
 * Every key here is optional on `TimelapseRuleSchema`; a required one
 * (`name`, `schedule`, …) could never be cleared into a valid rule.
 * `template` stays clearable through the patch's `null` too — both say
 * "remove", and the store accepts them together.
 */
import { z } from 'zod'

export const TIMELAPSE_RULE_CLEARABLE_KEYS = [
  'template',
  'previewText',
  'reportClasses',
  'denseCadenceSec',
  'minDwellSec',
] as const

export const TimelapseRuleClearableKeySchema = z.enum(TIMELAPSE_RULE_CLEARABLE_KEYS)
export type TimelapseRuleClearableKey = z.infer<typeof TimelapseRuleClearableKeySchema>
