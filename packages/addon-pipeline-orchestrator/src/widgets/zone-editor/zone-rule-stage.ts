/**
 * Pure, UI-agnostic helpers for the zone-rule stage editors.
 *
 * Extracted from `ZoneRulesEditor.tsx` so the human-facing stage label is
 * exhaustive over `ZoneRuleStageEnum` (the pre-`package` inline ternary
 * silently mislabelled the `package` stage as "Detection Rules"). Keeping
 * this in a plain `.ts` module lets it be unit-tested without a JSX/jsdom
 * harness.
 */
import { ZoneRuleStageEnum } from '@camstack/types'
import type { ZoneRuleStage } from '@camstack/types'
import { translate } from '../../i18n/index.js'

/**
 * Card title for a zone-rule stage editor (e.g. `'Package Rules'`).
 * Exhaustive over the stage enum — adding a new stage without a label here
 * fails the `zone-rule-stage.spec.ts` completeness check.
 */
export function zoneRuleStageTitle(stage: ZoneRuleStage): string {
  switch (stage) {
    case 'motion':
      return translate('rules.title.motion')
    case 'detection':
      return translate('rules.title.detection')
    case 'package':
      return translate('rules.title.package')
  }
}

/** The full ordered list of stages the UI renders an editor card for. */
export const ZONE_RULE_STAGES: readonly ZoneRuleStage[] = ZoneRuleStageEnum.options
