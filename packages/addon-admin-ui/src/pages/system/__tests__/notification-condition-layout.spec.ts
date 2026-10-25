/**
 * Where each condition is drawn in the admin rule editor (D690; revised
 * 2026-10-01): everything is always visible (no "show more"), minimum
 * confidence sits with the detections, the paired include/exclude lists are
 * ONE field, and the viewer-drawn custom zones are not offered here at all.
 *
 * The detection source and the zone-crossing direction are not drawn by THIS
 * layout at all any more — they moved to the rule-level Advanced tab
 * (`RuleConditionsAdvancedFields`), so this tab never produces a second
 * "Advanced" group.
 */
import {
  conditionVisibleForKind,
  NC_CONDITION_CATALOG,
  type NcConditionDescriptor,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { layoutConditionGroups } from '../notification-condition-layout'

function visibleFor(delivery: string, kind: 'detection' | 'sound'): NcConditionDescriptor[] {
  return NC_CONDITION_CATALOG.filter((d) => conditionVisibleForKind(d, delivery, kind))
}

function idsByGroup(descriptors: readonly NcConditionDescriptor[]): Record<string, string[]> {
  return Object.fromEntries(
    layoutConditionGroups(descriptors).map((g) => [g.id, g.descriptors.map((d) => d.id)]),
  )
}

describe('layoutConditionGroups — an immediate detection rule', () => {
  const groups = layoutConditionGroups(visibleFor('immediate', 'detection'))
  const byGroup = idsByGroup(visibleFor('immediate', 'detection'))

  it('puts minimum confidence with the object classes, under Detections', () => {
    expect(byGroup['class']).toEqual(['classes', 'minConfidence'])
  })

  it('draws each include/exclude pair ONCE, on its include id', () => {
    const all = groups.flatMap((g) => g.descriptors.map((d) => d.id))
    expect(all).toContain('zones')
    expect(all).toContain('identities')
    expect(all).not.toContain('zonesExclude')
    expect(all).not.toContain('identitiesExclude')
    expect(all).not.toContain('classesExclude')
  })

  it('never offers the custom zones, nor the device scope (it has its own tab)', () => {
    const all = groups.flatMap((g) => g.descriptors.map((d) => d.id))
    expect(all).not.toContain('customZones')
    expect(all).not.toContain('devices')
    expect(all).not.toContain('devicesExclude')
  })

  it('never produces an "advanced" group — source and crossing moved to the rule-level Advanced tab', () => {
    expect(groups.some((g) => g.id === 'advanced')).toBe(false)
    const all = groups.flatMap((g) => g.descriptors.map((d) => d.id))
    expect(all).not.toContain('source')
    expect(all).not.toContain('crossing')
    expect(byGroup['zones']).toEqual(['zones'])
    expect(byGroup['scope']).toEqual(['deviceState', 'scene'])
  })

  it('never offers a sound on a detection rule (R13)', () => {
    expect(groups.some((g) => g.id === 'audio')).toBe(false)
  })
})

describe('layoutConditionGroups — the anchor when only the exclusion is served', () => {
  it('draws the pair on the exclude id rather than losing it', () => {
    const onlyExclude = NC_CONDITION_CATALOG.filter((d) => d.id === 'zonesExclude')
    expect(idsByGroup(onlyExclude)['zones']).toEqual(['zonesExclude'])
  })
})

describe('layoutConditionGroups — a sound rule', () => {
  it('shows the sound, its gates and its schedule — and no Advanced section', () => {
    const byGroup = idsByGroup(visibleFor('immediate', 'sound'))
    expect(Object.keys(byGroup)).toEqual(['scope', 'audio', 'schedule'])
  })
})
