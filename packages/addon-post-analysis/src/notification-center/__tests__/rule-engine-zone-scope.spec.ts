/**
 * PER-CAMERA scoping of the `zones` condition (task #40).
 *
 * The bug this pins: `conditions.zones` is one flat list on a rule that is
 * routinely multi-camera, so picking a zone for camera A made camera B stop
 * matching entirely — B's detections can never visit a polygon drawn on A, so
 * every B subject failed `zones` and nothing said so.
 *
 * Operator semantics asserted here: a zone picked for a camera filters THAT
 * camera; a camera the rule lists no zone for keeps matching whole-frame. The
 * ownership answer comes from a mirror, so the UNKNOWN case is pinned too — it
 * must keep today's behaviour rather than invent a pass.
 */

import type { NcRule } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, type NcRuleSubject } from '../rule-engine.js'
import {
  type NcZoneOwnerLookup,
  scopeZoneIdsForRule,
  scopeZoneIdsToDevice,
} from '../zone-ownership.js'

// ── fixtures ────────────────────────────────────────────────────────

const CAM_A = 101
const CAM_B = 102
/** Zone ids are unique per camera — that is what makes ownership recoverable. */
const ZONE_A = 'zone-a-driveway'
const ZONE_B = 'zone-b-parking'

function rule(conditions: Record<string, unknown>): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'two cameras, one zone',
    delivery: 'immediate',
    targets: [{ targetId: 't1' }],
    conditions: { devices: [CAM_A, CAM_B], ...conditions },
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-zs',
    createdBy: 'admin-user',
    createdAt: 1_000,
    updatedAt: 1_000,
  })
}

function subject(deviceId: number, zones: readonly string[]): NcRuleSubject {
  return {
    kind: 'object-event',
    recordId: `e-${String(deviceId)}`,
    deviceId,
    timestamp: 0,
    classNames: ['person'],
    zones: [...zones],
  }
}

/** The mirror: A owns ZONE_A, B owns ZONE_B. Any other camera is UNKNOWN. */
const owners: NcZoneOwnerLookup = (deviceId) => {
  if (deviceId === CAM_A) return [ZONE_A]
  if (deviceId === CAM_B) return [ZONE_B]
  return undefined
}

// ── the helper (reused by the summaries collector, #35) ─────────────

describe('scopeZoneIdsToDevice', () => {
  it('narrows a mixed list to the ids this camera owns', () => {
    expect(scopeZoneIdsToDevice([ZONE_A, ZONE_B], CAM_A, owners)).toEqual({
      kind: 'scoped',
      ids: [ZONE_A],
    })
  })

  it('reports `inert` when the camera positively owns NONE of them', () => {
    expect(scopeZoneIdsToDevice([ZONE_A], CAM_B, owners)).toEqual({ kind: 'inert' })
  })

  it('reports `inert` for a camera the mirror says has no zones at all', () => {
    expect(scopeZoneIdsToDevice([ZONE_A], 900, () => [])).toEqual({ kind: 'inert' })
  })

  it("reports `unchanged` when every listed id is this camera's (nothing to narrow)", () => {
    expect(scopeZoneIdsToDevice([ZONE_A], CAM_A, owners)).toEqual({ kind: 'unchanged' })
  })

  it('reports `unchanged` when ownership is UNKNOWN — never a pass on a read that failed', () => {
    expect(scopeZoneIdsToDevice([ZONE_A], 999, owners)).toEqual({ kind: 'unchanged' })
    expect(scopeZoneIdsToDevice([ZONE_A], CAM_B, undefined)).toEqual({ kind: 'unchanged' })
  })

  it('reports `unchanged` for an empty id list (no condition to scope)', () => {
    expect(scopeZoneIdsToDevice([], CAM_B, owners)).toEqual({ kind: 'unchanged' })
  })
})

describe('scopeZoneIdsForRule', () => {
  it('scopes a rule that NAMES its cameras', () => {
    expect(
      scopeZoneIdsForRule({ ids: [ZONE_A], deviceScope: [CAM_A, CAM_B], deviceId: CAM_B }, owners),
    ).toEqual({ kind: 'inert' })
  })

  it('scopes an ALL-DEVICES rule too — a zone narrows only its owning camera (operator, 2026-08-13)', () => {
    expect(
      scopeZoneIdsForRule({ ids: [ZONE_A], deviceScope: undefined, deviceId: CAM_B }, owners),
    ).toEqual({ kind: 'inert' })
    expect(
      scopeZoneIdsForRule({ ids: [ZONE_A], deviceScope: [], deviceId: CAM_B }, owners),
    ).toEqual({ kind: 'inert' })
    // The owning camera itself keeps the flat evaluation — which for the
    // owner IS the zone narrowing ('unchanged': it owns every listed zone).
    expect(
      scopeZoneIdsForRule({ ids: [ZONE_A], deviceScope: undefined, deviceId: CAM_A }, owners),
    ).toEqual({ kind: 'unchanged' })
  })
})

// ── the engine, `match: 'any'` ──────────────────────────────────────

describe('zones condition — per-camera scope (any)', () => {
  const zoneOnA = rule({ zones: { ids: [ZONE_A], match: 'any' } })

  it('still filters the camera the zone belongs to', () => {
    expect(evaluateRule(zoneOnA, subject(CAM_A, [ZONE_A]), undefined, owners).matched).toBe(true)
    const miss = evaluateRule(zoneOnA, subject(CAM_A, []), undefined, owners)
    expect(miss.matched).toBe(false)
    expect(miss.failedCondition).toBe('zones')
  })

  it('lets the OTHER camera match whole-frame — the silent mute this fixes', () => {
    const r = evaluateRule(zoneOnA, subject(CAM_B, []), undefined, owners)
    expect(r.matched).toBe(true)
  })

  it('matches the other camera even when it visited a zone of its own', () => {
    expect(evaluateRule(zoneOnA, subject(CAM_B, [ZONE_B]), undefined, owners).matched).toBe(true)
  })

  it('keeps the flat verdict when ownership is UNKNOWN (mirror cold)', () => {
    const cold = evaluateRule(zoneOnA, subject(CAM_B, []), undefined, () => undefined)
    expect(cold.matched).toBe(false)
    expect(cold.failedCondition).toBe('zones')
  })

  it('keeps the flat verdict when no ownership lookup is wired at all', () => {
    const r = evaluateRule(zoneOnA, subject(CAM_B, []))
    expect(r.matched).toBe(false)
    expect(r.failedCondition).toBe('zones')
  })

  it('widens a rule that names no camera — the zone narrows only its owner (operator, 2026-08-13)', () => {
    // Same zone, no `devices` scope: an unscoped rule IS an all-camera rule,
    // so camera B (which owns none of the listed zones) matches whole-frame.
    const unscoped = NcRuleSchema.parse({
      ...NcRuleInputSchema.parse({
        name: 'every camera, one zone',
        delivery: 'immediate',
        targets: [{ targetId: 't1' }],
        conditions: { zones: { ids: [ZONE_A], match: 'any' } },
      }),
      id: 'rule-zs-all',
      createdBy: 'admin-user',
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    const r = evaluateRule(unscoped, subject(CAM_B, [ZONE_B]), undefined, owners)
    expect(r.matched).toBe(true)
    // And the owning camera stays narrowed to its zone even on an unscoped rule.
    expect(evaluateRule(unscoped, subject(CAM_A, []), undefined, owners).matched).toBe(false)
  })

  it('scopes a mixed list per camera — each camera sees only its own zone', () => {
    const both = rule({ zones: { ids: [ZONE_A, ZONE_B], match: 'any' } })
    expect(evaluateRule(both, subject(CAM_A, [ZONE_A]), undefined, owners).matched).toBe(true)
    expect(evaluateRule(both, subject(CAM_B, [ZONE_B]), undefined, owners).matched).toBe(true)
    // A visiting nothing still fails — the scope narrows, it never passes.
    expect(evaluateRule(both, subject(CAM_A, []), undefined, owners).matched).toBe(false)
  })
})

// ── the engine, `match: 'all'` ──────────────────────────────────────

describe('zones condition — per-camera scope (all)', () => {
  const allBoth = rule({ zones: { ids: [ZONE_A, ZONE_B], match: 'all' } })

  it("requires ALL of the camera's OWN zones, not all of the rule's", () => {
    // Flat `all` over two cameras is unsatisfiable: no subject can visit a
    // polygon on the other camera. Scoped, each side is satisfiable.
    expect(evaluateRule(allBoth, subject(CAM_A, [ZONE_A]), undefined, owners).matched).toBe(true)
    expect(evaluateRule(allBoth, subject(CAM_B, [ZONE_B]), undefined, owners).matched).toBe(true)
  })

  it("still requires every one of the camera's own listed zones", () => {
    const twoOnA: NcZoneOwnerLookup = (deviceId) =>
      deviceId === CAM_A ? [ZONE_A, 'zone-a-gate'] : undefined
    const r = rule({ zones: { ids: [ZONE_A, 'zone-a-gate'], match: 'all' } })
    expect(evaluateRule(r, subject(CAM_A, [ZONE_A]), undefined, twoOnA).matched).toBe(false)
    expect(
      evaluateRule(r, subject(CAM_A, [ZONE_A, 'zone-a-gate']), undefined, twoOnA).matched,
    ).toBe(true)
  })

  it('is unsatisfiable flat, which is the bug — same rule, no ownership', () => {
    expect(evaluateRule(allBoth, subject(CAM_A, [ZONE_A])).matched).toBe(false)
  })
})

// ── zonesExclude ────────────────────────────────────────────────────

describe('zonesExclude needs no scoping', () => {
  // Excluding a zone of camera A cannot reach camera B: ids are unique per
  // camera, so B never visits A's zone and the veto is a no-op for it. The
  // condition is therefore already per-camera safe, and stays flat.
  it('vetoes only the camera that can actually visit the excluded zone', () => {
    const excludeA = rule({ zonesExclude: [ZONE_A] })
    const vetoed = evaluateRule(excludeA, subject(CAM_A, [ZONE_A]), undefined, owners)
    expect(vetoed.matched).toBe(false)
    expect(vetoed.failedCondition).toBe('zonesExclude')
    expect(evaluateRule(excludeA, subject(CAM_B, [ZONE_B]), undefined, owners).matched).toBe(true)
    // …and identically with no ownership wired: nothing about the veto depends
    // on it.
    expect(evaluateRule(excludeA, subject(CAM_B, [ZONE_B])).matched).toBe(true)
  })
})

// ── the crossed zone still joins the membership ─────────────────────

describe('scoping composes with the crossed zone', () => {
  it("an EXIT from the camera's own zone still matches under a scoped list", () => {
    const both = rule({ zones: { ids: [ZONE_A, ZONE_B], match: 'any' }, crossing: 'exit' })
    const exiting: NcRuleSubject = {
      ...subject(CAM_A, []),
      crossing: { direction: 'exit', zoneId: ZONE_A },
    }
    expect(evaluateRule(both, exiting, undefined, owners).matched).toBe(true)
  })
})
