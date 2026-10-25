import { describe, it, expect } from 'vitest'
import { ZoneRuleStageEnum } from '@camstack/types'
import { zoneRuleStageTitle, ZONE_RULE_STAGES } from '../zone-rule-stage.js'

describe('zoneRuleStageTitle', () => {
  it('labels the package stage (regression: the old inline ternary said "Detection Rules")', () => {
    expect(zoneRuleStageTitle('package')).toBe('Package Rules')
  })

  it('labels the motion and detection stages', () => {
    expect(zoneRuleStageTitle('motion')).toBe('Motion Rules')
    expect(zoneRuleStageTitle('detection')).toBe('Detection Rules')
  })

  it('is exhaustive over every zone-rule stage (a new stage must get a label)', () => {
    for (const stage of ZoneRuleStageEnum.options) {
      const title = zoneRuleStageTitle(stage)
      expect(title.endsWith(' Rules')).toBe(true)
      // No stage should fall through to `undefined Rules`.
      expect(title.startsWith('undefined')).toBe(false)
    }
  })

  it('exposes the full stage list in enum order for the UI to render a card per stage', () => {
    expect(ZONE_RULE_STAGES).toEqual(ZoneRuleStageEnum.options)
    expect(ZONE_RULE_STAGES).toContain('package')
  })
})
