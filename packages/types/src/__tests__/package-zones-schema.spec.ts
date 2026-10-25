import { describe, it, expect } from 'vitest'
import { ZoneRuleStageEnum, zoneRulesCapability } from '../capabilities/zone-rules.cap.js'
import {
  EventKindCategorySchema,
  EventKindIconSchema,
} from '../capabilities/pipeline-analytics.cap.js'
import { EventCategory } from '../enums/event-category.js'

/**
 * Phase-1 schema guard for the package-zones / package-drop feature
 * (docs/superpowers/specs/2026-07-17-package-zones-design.md). Locks the
 * train-bound additions: the `package` zone-rule stage + runtimeState
 * slice, the `package` event-kind category/icon, and the two package
 * EventCategory bus topics.
 */
describe('package-zones schema (Phase 1)', () => {
  it('ZoneRuleStageEnum carries the package stage alongside motion/detection', () => {
    expect(ZoneRuleStageEnum.options).toContain('package')
    expect(ZoneRuleStageEnum.options).toEqual(['motion', 'detection', 'package'])
  })

  it('zone-rules runtimeState mirrors a package array (defaults to empty list)', () => {
    const parsed = zoneRulesCapability.runtimeState.parse({
      motion: [],
      detection: [],
      package: [],
    })
    expect(parsed.package).toEqual([])
  })

  it('zone-rules runtimeState accepts a package rule referencing drawn zones', () => {
    const parsed = zoneRulesCapability.runtimeState.parse({
      motion: [],
      detection: [],
      package: [{ id: 'r1', zoneIds: ['porch'], mode: 'include' }],
    })
    expect(parsed.package).toHaveLength(1)
    expect(parsed.package[0]?.zoneIds).toEqual(['porch'])
    // `enabled` defaults true so a freshly-created rule is active.
    expect(parsed.package[0]?.enabled).toBe(true)
  })

  it('EventKindCategorySchema includes package', () => {
    expect(EventKindCategorySchema.options).toContain('package')
    expect(() => EventKindCategorySchema.parse('package')).not.toThrow()
  })

  it('EventKindIconSchema includes a package glyph', () => {
    expect(EventKindIconSchema.options).toContain('package')
    expect(() => EventKindIconSchema.parse('package')).not.toThrow()
  })

  it('EventCategory exposes the two package bus topics', () => {
    expect(EventCategory.PipelineAnalyticsPackageDelivered).toBe(
      'pipeline-analytics.package-delivered',
    )
    expect(EventCategory.PipelineAnalyticsPackagePickedUp).toBe(
      'pipeline-analytics.package-picked-up',
    )
  })
})
