/**
 * The per-rule TEST button's plan — pinned END TO END against the engine.
 *
 * The assertion that matters is not "the plan sets the fields we expect", it is
 * **the planned event actually fires the rule it was planned for**. So every
 * case here runs the real chain:
 *
 *     planRuleTest(rule) → buildSyntheticEvent(...) → evaluateRule(rule, subject)
 *
 * and requires `matched === true`. That is the only shape of test that catches
 * the failure this feature exists to prevent — an operator pressing Test on a
 * working rule and being told it does not match, because the tester built a
 * subject the engine refuses. It also means a NEW condition added to the engine
 * breaks a case here rather than shipping a Test button that silently reports
 * the wrong verdict for rules carrying it.
 */

import type { NcConditions, NcRule } from '@camstack/types'
import { NC_AUTHORABLE_SYSTEM_EVENT_KINDS, NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule } from '../rule-engine.js'
import { planRuleTest, scheduleActiveAt, testTriggerForRule } from '../rule-test-plan.js'
import { buildSyntheticEvent } from '../test-event.js'
import { NC_LANGUAGES, NcTextCatalog } from '../text-catalog.js'
import enBundle from '../texts/en.json' with { type: 'json' }

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)
const CAM = 102

function rule(
  delivery: NcRule['delivery'],
  conditions: NcConditions,
  extra: Record<string, unknown> = {},
): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'rule under test',
    delivery,
    targets: [{ targetId: 't1' }],
    conditions,
    ...extra,
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-under-test',
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
  })
}

/** Plan the rule, build the event the injection would build, evaluate it. */
function planAndEvaluate(r: NcRule): { matched: boolean; failedCondition?: string } {
  const plan = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM })
  const event = buildSyntheticEvent(plan.input, 'synthetic:test', NOW)
  const verdict = evaluateRule(r, event.subject)
  return {
    matched: verdict.matched,
    ...(verdict.failedCondition !== undefined ? { failedCondition: verdict.failedCondition } : {}),
  }
}

describe('planRuleTest — the planned event fires its own rule', () => {
  it('fires a plain detection rule scoped by camera, class, zone and confidence', () => {
    const r = rule('immediate', {
      devices: [CAM],
      classes: ['person'],
      classesExclude: ['animal'],
      minConfidence: 0.7,
      zones: { ids: ['z-gate'], match: 'any' },
      zonesExclude: ['z-street'],
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a track-end rule carrying every close-time-only condition', () => {
    const r = rule('track-end', {
      devices: [CAM],
      classes: ['vehicle'],
      minImportance: 0.6,
      minDwellSeconds: 12,
      minLabelConfidence: 0.8,
      plates: { values: ['AB123CD'], maxDistance: 1 },
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires an EXIT-crossing rule — the one direction that fails closed on a non-crossing', () => {
    const r = rule('immediate', {
      devices: [CAM],
      zones: { ids: ['z-drive'], match: 'any' },
      crossing: 'exit',
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a sensor device-event rule on its kind and its raw token', () => {
    const r = rule('device-event', {
      devices: [CAM],
      sensorKinds: ['doorbell'],
      eventTypeTokens: ['press'],
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it.each([
    [undefined, true],
    ['raised', true],
    ['cleared', false],
  ] as const)('fires a sensor rule with sensorTransition %s on a subject that SAYS which edge (D640)', (sensorTransition, raised) => {
    const r = rule('device-event', {
      devices: [CAM],
      sensorKinds: ['flood'],
      ...(sensorTransition !== undefined ? { sensorTransition } : {}),
    })
    const plan = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM })
    // The edge is ON the subject — a test that passed only because an absent
    // reading is let through would prove nothing about the condition.
    expect(buildSyntheticEvent(plan.input, 'synthetic:test', NOW).subject.sensorRaised).toBe(raised)
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('claims no edge for a kind that has none (a doorbell press)', () => {
    const r = rule('device-event', { devices: [CAM], sensorKinds: ['doorbell'] })
    const plan = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM })
    expect(plan.input.sensorRaised).toBeUndefined()
  })

  it('fires a package rule on the phase it names', () => {
    const r = rule('package-event', { devices: [CAM], packagePhase: 'picked-up' })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it.each([
    ['became-occupied', 2],
    ['became-free', 2],
    ['>=', 3],
    ['<=', 1],
  ] as const)('fires an occupancy rule with op %s / count %i', (op, count) => {
    const r = rule('device-event', {
      devices: [CAM],
      occupancy: { op, count, sustainSeconds: 15, zoneId: 'z-park', className: 'vehicle' },
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a SOUND rule — the window must carry the rule’s own spec', () => {
    const r = rule('immediate', {
      devices: [CAM],
      // Deliberately UNSORTED and mixed-spelling: `matchesAudio` compares the
      // window's spec labels to the rule's ELEMENTWISE, so a plan that copied
      // the operator's order would fail closed on every multi-sound rule.
      audio: {
        labels: ['Scream', 'audio-dog'],
        dbThreshold: -30,
        hitPercent: 60,
        samplingSeconds: 10,
      },
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a level-only SOUND rule (no labels at all)', () => {
    const r = rule('immediate', {
      devices: [CAM],
      audio: { dbThreshold: -20, hitPercent: 80, samplingSeconds: 5 },
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a legacy audio-CLASS rule (immediate + audio-* classes, no audio condition)', () => {
    const r = rule('immediate', { devices: [CAM], classes: ['audio-dog'] })
    expect(testTriggerForRule(r)).toBe('audio-event')
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a system rule narrowed by kind, device and device type', () => {
    const r = rule('system-event', {
      systemEvent: {
        kinds: ['device-offline'],
        deviceIds: [CAM],
        deviceTypes: ['camera'],
      },
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a system rule about a NODE', () => {
    const r = rule('system-event', {
      systemEvent: { kinds: ['node-offline'], nodeIds: ['agent-1'] },
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })

  it('fires a rule whose customZones polygon sits in a corner of the frame', () => {
    // The failure this pins: a centred half-frame box (what the admin
    // simulator seeds) does not overlap a corner polygon, so a working rule
    // reads as broken. The plan uses the POLYGON's own bounding box.
    const r = rule('immediate', {
      devices: [CAM],
      customZones: [
        {
          kind: 'polygon',
          points: [
            { x: 0.02, y: 0.02 },
            { x: 0.12, y: 0.02 },
            { x: 0.12, y: 0.12 },
            { x: 0.02, y: 0.12 },
          ],
        },
      ],
    })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })
})

describe('planRuleTest — the side gates and the notes', () => {
  it('bypasses the cooldown and the mute, and never runs the actions', () => {
    const plan = planRuleTest({ rule: rule('immediate', {}), now: NOW, fallbackDeviceId: CAM })
    expect(plan.input.bypassCooldown).toBe(true)
    expect(plan.input.bypassMute).toBe(true)
    expect(plan.input.runActions).toBe(false)
  })

  it('narrows the injection to the rule under test', () => {
    const r = rule('immediate', {})
    const plan = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM })
    expect(plan.input.onlyRuleId).toBe(r.id)
  })

  it('reports the device-state gate rather than faking it', () => {
    const r = rule('immediate', { devices: [CAM], deviceState: { deviceId: 9, states: ['armed'] } })
    const plan = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM })
    expect(plan.notes.map((n) => n.conditionId)).toContain('deviceState')
    // …and the event genuinely does NOT satisfy it — a note that accompanied a
    // faked pass would be decoration.
    expect(planAndEvaluate(r).failedCondition).toBe('deviceState')
  })

  it('says so when the rule scopes no camera and none was supplied', () => {
    const plan = planRuleTest({ rule: rule('immediate', {}), now: NOW })
    expect(plan.notes.map((n) => n.conditionId)).toContain('devices')
  })
})

describe('scheduleActiveAt', () => {
  /** Fridays 22:00→23:00 UTC. NOW is a Friday at 12:00 — outside it. */
  const schedule = {
    windows: [{ days: [5], startMinute: 22 * 60, endMinute: 23 * 60 }],
    timezone: 'UTC',
  }

  it('returns now when the rule has no schedule', () => {
    expect(scheduleActiveAt(undefined, NOW)).toBe(NOW)
  })

  it('walks BACK to the most recent active minute when the rule is outside its window', () => {
    const at = scheduleActiveAt(schedule, NOW)
    expect(at).not.toBeNull()
    expect(at).toBeLessThan(NOW)
    // Last Friday's window, not a future one: a test must fire now, and a
    // future instant would be a notification about something that has not
    // happened.
    expect(new Date(at ?? 0).getUTCHours()).toBeGreaterThanOrEqual(22)
  })

  it('fires a scheduled rule through the whole chain', () => {
    const r = rule('immediate', { devices: [CAM] }, { schedule })
    expect(planAndEvaluate(r)).toEqual({ matched: true })
  })
})

describe('the synthetic system event is worded by the shipped catalog', () => {
  // A key nothing resolves renders an EMPTY notification, which is the one
  // failure a tester must not be able to produce. Every kind an operator can
  // author is checked against the shipped English bundle.
  // DERIVED from the schema, not hand-kept: a kind added to the enum is
  // checked here the day it is added. The hand-kept list this replaced had
  // stopped at five alarm kinds while four more had shipped, and three of
  // those four resolved a key nothing carried.
  const authorable = NC_AUTHORABLE_SYSTEM_EVENT_KINDS

  it.each(authorable)('%s resolves a title and a body key', (kind) => {
    const r = rule('system-event', { systemEvent: { kinds: [kind] } })
    const plan = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM })
    const system = plan.input.systemEvent
    expect(system).toBeDefined()
    const bundle: Record<string, unknown> = enBundle
    expect(bundle[system?.titleKey ?? '']).toBeDefined()
    expect(bundle[system?.bodyKey ?? '']).toBeDefined()
  })

  it.each(
    authorable.flatMap((kind) => NC_LANGUAGES.map((language) => [kind, language] as const)),
  )('%s renders a non-empty title and body in %s', (kind, language) => {
    const r = rule('system-event', { systemEvent: { kinds: [kind] } })
    const system = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM }).input.systemEvent
    const texts = new NcTextCatalog({ language })
    const vars = system?.textParams ?? {}
    const title = texts.text({ key: system?.titleKey ?? '', vars })
    const body = texts.text({ key: system?.bodyKey ?? '', vars })
    expect(title.trim()).not.toBe('')
    expect(body.trim()).not.toBe('')
  })
})

describe('a rule that excludes devices (D641)', () => {
  it('excluding another camera: the planned event fires the rule', () => {
    expect(planAndEvaluate(rule('immediate', { devicesExclude: [CAM + 1] })).matched).toBe(true)
  })

  it('excluding the camera the test would use: the plan SAYS so before the engine refuses it', () => {
    const r = rule('immediate', { devicesExclude: [CAM] })
    const plan = planRuleTest({ rule: r, now: NOW, fallbackDeviceId: CAM })
    expect(plan.notes).toContainEqual(expect.objectContaining({ conditionId: 'devicesExclude' }))
    expect(planAndEvaluate(r).failedCondition).toBe('devicesExclude')
  })

  it('excluding a camera the test does not use says nothing', () => {
    const plan = planRuleTest({
      rule: rule('immediate', { devicesExclude: [CAM + 1] }),
      now: NOW,
      fallbackDeviceId: CAM,
    })
    expect(plan.notes.map((n) => n.conditionId)).not.toContain('devicesExclude')
  })
})
