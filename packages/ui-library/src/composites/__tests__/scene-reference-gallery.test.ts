/**
 * The gallery's addressing, which is the part that can delete the WRONG
 * photograph.
 *
 * `deleteReference` takes `(stateId, index)` where `index` is the position in
 * that state's own `references` array. The gallery presents the same
 * references regrouped by lighting variant, so an index computed over the
 * grouped view would diverge from the cap's the moment a scene holds two
 * conditions — and the operator would press delete on the daylight tile and
 * lose the infrared one, with nothing on screen to say so.
 */

import type { SceneMonitor, SceneReference } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { groupReferences, totalReferences } from '../cap-settings/SceneReferenceGallery'

function ref(condition: string, capturedAt: number, thumbMediaId?: number): SceneReference {
  return {
    embedding: [1, 0, 0],
    modelId: 'clip-vit-b32',
    condition,
    capturedAt,
    // A media ROW id now, not a composite key (D482). Absent means the
    // reference has no stored picture — never `0`, which would name a row
    // that cannot exist.
    ...(thumbMediaId !== undefined ? { thumbnailMediaId: thumbMediaId } : {}),
  }
}

function monitor(references: readonly SceneReference[]): SceneMonitor {
  return {
    id: 'm1',
    label: 'Pannelli',
    roi: { kind: 'rect', x: 0, y: 0, width: 0.3, height: 0.3 },
    enabled: true,
    triggerMode: 'both',
    check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 3 },
    states: [
      {
        id: 'baseline',
        label: 'baseline',
        references: [...references],
        referenceCount: references.length,
        currentlyMatched: true,
      },
    ],
    currentStateId: 'baseline',
    lastCheckedAt: null,
    lastConfidence: null,
    currentCondition: 'day',
    availability: 'ok',
    unavailableReason: null,
    baselineStateId: 'baseline',
    emit: 'latched',
    verdict: 'matched',
    latched: false,
    armedAt: 0,
    divergedAt: null,
    restoredAt: null,
    quietSeconds: 60,
    minObservationSpacingSec: 120,
    anchorThreshold: 0.85,
    autoRestore: false,
    onUncoveredCondition: 'skip',
    suspendedCondition: null,
    unavailable: null,
    coveredConditions: ['day'],
  }
}

describe('groupReferences', () => {
  it('groups by lighting variant', () => {
    const groups = groupReferences(monitor([ref('day', 1), ref('ir', 2), ref('day', 3)]))
    expect(groups.map((g) => g.condition)).toEqual(['day', 'ir'])
    expect(groups[0]!.tiles).toHaveLength(2)
    expect(groups[1]!.tiles).toHaveLength(1)
  })

  // THE bug this file exists to prevent. The `ir` reference sits at index 1 in
  // the state's array; regrouping puts it at position 0 of its own group, and
  // an index taken from there would delete the daylight capture instead.
  it('keeps each tile addressed by its index in the STATE array, not the group', () => {
    const groups = groupReferences(monitor([ref('day', 1), ref('ir', 2), ref('day', 3)]))
    const ir = groups.find((g) => g.condition === 'ir')!
    expect(ir.tiles[0]).toMatchObject({ stateId: 'baseline', index: 1 })

    const day = groups.find((g) => g.condition === 'day')!
    // Newest first within a group — and the indices travel with the tiles
    // rather than being renumbered by the sort.
    expect(day.tiles.map((t) => t.index)).toEqual([2, 0])
  })

  it('is empty for a scene that has never been captured', () => {
    expect(groupReferences(monitor([]))).toEqual([])
  })

  it('a reference with no stored picture still gets a tile', () => {
    const groups = groupReferences(monitor([ref('day', 1)]))
    expect(groups[0]!.tiles[0]!.reference.thumbnailMediaId).toBeUndefined()
  })
})

describe('totalReferences', () => {
  // Drives the extra confirmation: deleting the last photograph of ONE variant
  // is ordinary (that light becomes uncovered, and uncovered is skipped);
  // deleting the last one the scene has ANYWHERE leaves it unable to judge.
  it('counts across every variant, so an ir-only delete is not the last one', () => {
    expect(totalReferences(monitor([ref('day', 1), ref('ir', 2)]))).toBe(2)
    expect(totalReferences(monitor([ref('day', 1)]))).toBe(1)
  })
})
