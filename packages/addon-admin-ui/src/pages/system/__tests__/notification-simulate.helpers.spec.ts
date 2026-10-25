/**
 * Unit tests for the pure notification-SIMULATOR helpers.
 *
 * The two things worth guarding here are the ones that fail SILENTLY:
 *
 *  1. `prefillFromRule` — the rule → form derivation behind the per-rule Test
 *     button. A condition added server-side that this function forgets produces
 *     a prefilled form that looks right and simulates the wrong event, and the
 *     operator reads the "did not match" as a bug in their rule.
 *  2. the ABSENT numeric. An empty confidence field must send NOTHING, because
 *     a `minConfidence` condition fails on a subject with no confidence and
 *     passes on one carrying zero — two different, both plausible, answers.
 */
import type { NcRule } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildSimulateInput,
  clearSimulatePrefill,
  defaultSourceForTrigger,
  deliveryForTrigger,
  emptySimulateForm,
  isSimulateFormValid,
  occupancyFromCondition,
  parkSimulatePrefill,
  parseLocalDateTime,
  parseOptionalNumberInput,
  parseSimulateResult,
  parseSimulateTrigger,
  peekSimulatePrefill,
  prefillForRule,
  prefillFromRule,
  simulateCaveats,
  summariseSimulateResult,
  triggerForRule,
  type NcSimulateFormState,
} from '../notification-simulate.helpers'

function rule(overrides: Partial<NcRule> = {}): NcRule {
  return {
    id: 'r1',
    name: 'Front door',
    enabled: true,
    disabledTargetIds: [],
    delivery: 'immediate',
    conditions: {},
    targets: [{ targetId: 't1' }],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** A runnable form — every test that builds a payload needs a camera. */
function form(overrides: Partial<NcSimulateFormState> = {}): NcSimulateFormState {
  return { ...emptySimulateForm(), deviceId: 101, ...overrides }
}

describe('deliveryForTrigger', () => {
  it('mirrors the intake seam: audio rides immediate, occupancy rides device-event', () => {
    expect(deliveryForTrigger('object-event')).toBe('immediate')
    expect(deliveryForTrigger('audio-event')).toBe('immediate')
    expect(deliveryForTrigger('occupancy-event')).toBe('device-event')
    expect(deliveryForTrigger('device-event')).toBe('device-event')
    expect(deliveryForTrigger('track-end')).toBe('track-end')
    expect(deliveryForTrigger('package-event')).toBe('package-event')
  })
})

describe('defaultSourceForTrigger', () => {
  it('never authors a source — the server stamps it', () => {
    // An `audio-event` is stamped `pipeline` by `subjectFromAudioEvent`, NOT
    // `audio`: audio analysis is a pipeline product, and the `audio` source
    // belongs to the D62 audio MARKER, which is a synthetic track arriving on
    // `track-end`. Pre-filling `audio` here made a rule gated on
    // `source: audio` match a simulated episode a real one could never
    // satisfy — a test passing where production fails.
    expect(defaultSourceForTrigger('audio-event')).toBe('')
    expect(defaultSourceForTrigger('device-event')).toBe('')
    expect(defaultSourceForTrigger('object-event')).toBe('')
    expect(defaultSourceForTrigger('track-end')).toBe('')
  })

  it('prefillFromRule leaves an unconditioned audio rule with no source', () => {
    expect(prefillFromRule(rule({ conditions: { classes: ['audio-dog'] } })).source).toBe('')
    // An authored source still wins — that IS what the rule asks to match.
    expect(
      prefillFromRule(rule({ conditions: { classes: ['audio-dog'], source: 'onboard' } })).source,
    ).toBe('onboard')
  })
})

describe('parseSimulateTrigger', () => {
  it('narrows known values and rejects the rest (no cast)', () => {
    expect(parseSimulateTrigger('track-end')).toBe('track-end')
    expect(parseSimulateTrigger('immediate')).toBeUndefined()
    expect(parseSimulateTrigger('')).toBeUndefined()
  })
})

describe('triggerForRule', () => {
  it('splits the immediate delivery on the audio class namespace', () => {
    expect(triggerForRule(rule({ conditions: { classes: ['person'] } }))).toBe('object-event')
    expect(triggerForRule(rule({ conditions: {} }))).toBe('object-event')
    expect(triggerForRule(rule({ conditions: { classes: ['audio-dog', 'audio-siren'] } }))).toBe(
      'audio-event',
    )
    // A mixed rule is NOT an audio rule — an audio episode carries no `person`.
    expect(triggerForRule(rule({ conditions: { classes: ['audio-dog', 'person'] } }))).toBe(
      'object-event',
    )
  })

  it('splits the device-event delivery on the occupancy condition', () => {
    expect(triggerForRule(rule({ delivery: 'device-event', conditions: {} }))).toBe('device-event')
    expect(
      triggerForRule(
        rule({
          delivery: 'device-event',
          conditions: { occupancy: { op: '>=', count: 3, sustainSeconds: 15 } },
        }),
      ),
    ).toBe('occupancy-event')
  })
})

describe('prefillFromRule', () => {
  it('seeds an immediate rule from its classes, zones and confidence floor', () => {
    const state = prefillFromRule(
      rule({
        delivery: 'immediate',
        conditions: {
          devices: [101, 102],
          classes: ['person', 'car'],
          zones: { ids: ['z-driveway'], match: 'any' },
          minConfidence: 0.7,
          source: 'pipeline',
        },
      }),
    )
    expect(state.trigger).toBe('object-event')
    // The FIRST device only: one event happens at one camera.
    expect(state.deviceId).toBe(101)
    expect(state.classNames).toEqual(['person', 'car'])
    expect(state.zones).toEqual(['z-driveway'])
    // Just above the floor, not AT it — a threshold is a `>=` on a float.
    expect(state.confidence).toBe(0.75)
    expect(state.source).toBe('pipeline')
    expect(state.onlyRuleId).toBe('r1')
    // The run flags stay off: a suppressed cooldown is an ANSWER, not noise.
    expect(state.bypassCooldown).toBe(false)
    expect(state.bypassMute).toBe(false)
    expect(state.runActions).toBe(false)
  })

  it('leaves confidence ABSENT when the rule states no floor', () => {
    const state = prefillFromRule(rule({ conditions: { classes: ['person'] } }))
    expect(state.confidence).toBeUndefined()
    expect(buildSimulateInput({ ...state, deviceId: 101 })).not.toHaveProperty('confidence')
  })

  it('seeds a track-end rule from the conditions only a closed track carries', () => {
    const state = prefillFromRule(
      rule({
        delivery: 'track-end',
        conditions: {
          minImportance: 0.4,
          minDwellSeconds: 12,
          minLabelConfidence: 0.62,
          identities: ['Marco'],
        },
      }),
    )
    expect(state.trigger).toBe('track-end')
    expect(state.importance).toBe(0.45)
    expect(state.labelConfidence).toBe(0.67)
    expect(state.dwellSeconds).toBe(13)
    expect(state.label).toBe('Marco')
    // A crossing belongs to an object event; a track carries none.
    expect(state.crossingEnabled).toBe(false)
  })

  it('prefers identities, then labelEquals, then a plate for the label', () => {
    expect(prefillFromRule(rule({ conditions: { labelEquals: ['dog'] } })).label).toBe('dog')
    expect(
      prefillFromRule(rule({ conditions: { plates: { values: ['AB123CD'], maxDistance: 1 } } }))
        .label,
    ).toBe('AB123CD')
  })

  it('seeds a doorbell rule with its sensor kind and event token', () => {
    const state = prefillFromRule(
      rule({
        delivery: 'device-event',
        conditions: {
          devices: [102],
          sensorKinds: ['doorbell'],
          eventTypeTokens: ['press'],
        },
      }),
    )
    expect(state.trigger).toBe('device-event')
    expect(state.deviceId).toBe(102)
    expect(state.sensorKind).toBe('doorbell')
    expect(state.eventType).toBe('press')
    expect(state.onlyRuleId).toBe('r1')
  })

  it('seeds an occupancy rule with the edge that satisfies its op', () => {
    const state = prefillFromRule(
      rule({
        delivery: 'device-event',
        conditions: {
          devices: [101],
          occupancy: {
            zoneId: 'z-yard',
            className: 'person',
            op: 'became-occupied',
            count: 2,
            sustainSeconds: 15,
          },
        },
      }),
    )
    expect(state.trigger).toBe('occupancy-event')
    expect(state.occupancy).toEqual({
      zoneId: 'z-yard',
      zoneName: '',
      className: 'person',
      count: 2,
      previousCount: 1,
      occupied: true,
      threshold: 2,
    })
  })

  it('seeds a package rule with a phase, defaulting `both` to a delivery', () => {
    expect(
      prefillFromRule(rule({ delivery: 'package-event', conditions: { packagePhase: 'both' } }))
        .packagePhase,
    ).toBe('delivered')
    expect(
      prefillFromRule(
        rule({ delivery: 'package-event', conditions: { packagePhase: 'picked-up' } }),
      ).packagePhase,
    ).toBe('picked-up')
    // No phase authored: the trigger still needs one to be a package event.
    expect(prefillFromRule(rule({ delivery: 'package-event' })).packagePhase).toBe('delivered')
  })

  it('turns a crossing condition into a crossing, and `any` into an entry', () => {
    const exit = prefillFromRule(
      rule({
        conditions: { crossing: 'exit', zones: { ids: ['z-gate'], match: 'any' } },
      }),
    )
    expect(exit.crossingEnabled).toBe(true)
    expect(exit.crossingDirection).toBe('exit')
    expect(exit.crossingZoneId).toBe('z-gate')

    const any = prefillFromRule(rule({ conditions: { crossing: 'any' } }))
    expect(any.crossingEnabled).toBe(true)
    expect(any.crossingDirection).toBe('enter')
  })

  it('does NOT author a source for the unrestricted `any`', () => {
    expect(prefillFromRule(rule({ conditions: { source: 'any' } })).source).toBe('')
    expect(prefillFromRule(rule({ conditions: { source: 'onboard' } })).source).toBe('onboard')
  })

  it('enables the bbox for a rule that can only match a subject carrying one', () => {
    const state = prefillFromRule(
      rule({
        conditions: {
          customZones: [{ kind: 'polygon', points: [{ x: 0, y: 0 }] }],
        },
      }),
    )
    expect(state.bboxEnabled).toBe(true)
  })

  it('leaves the camera unset when the rule is not scoped to one', () => {
    expect(prefillFromRule(rule({ conditions: {} })).deviceId).toBeNull()
    expect(isSimulateFormValid(prefillFromRule(rule({ conditions: {} })))).toBe(false)
  })
})

describe('occupancyFromCondition', () => {
  it('falls to zero for `became-free` and to the threshold for `<=`', () => {
    expect(
      occupancyFromCondition({ op: 'became-free', count: 3, sustainSeconds: 15 }),
    ).toMatchObject({ count: 0, previousCount: 3, occupied: false, threshold: 3 })
    expect(occupancyFromCondition({ op: '<=', count: 1, sustainSeconds: 15 })).toMatchObject({
      count: 1,
      previousCount: 2,
      occupied: true,
      threshold: 1,
    })
  })
})

describe('simulateCaveats', () => {
  it('names the conditions a synthetic subject cannot satisfy on its own', () => {
    expect(simulateCaveats(rule({ conditions: {} }))).toEqual([])
    const gated = simulateCaveats(
      rule({ conditions: { deviceState: { deviceId: 42, states: ['armed'] } } }),
    )
    expect(gated).toHaveLength(1)
    expect(gated[0]?.conditionId).toBe('deviceState')
  })
})

describe('parseOptionalNumberInput', () => {
  it('reads an empty field as ABSENT, never as zero', () => {
    expect(parseOptionalNumberInput('')).toBeUndefined()
    expect(parseOptionalNumberInput('   ')).toBeUndefined()
    expect(parseOptionalNumberInput('abc')).toBeUndefined()
    // 0 is a real authored value and must survive.
    expect(parseOptionalNumberInput('0')).toBe(0)
    expect(parseOptionalNumberInput('0.65')).toBe(0.65)
  })
})

describe('parseLocalDateTime', () => {
  it('reads a datetime-local value and treats an empty one as "now"', () => {
    expect(parseLocalDateTime('')).toBeUndefined()
    expect(parseLocalDateTime('not a date')).toBeUndefined()
    expect(parseLocalDateTime('2026-08-08T10:30')).toBe(new Date(2026, 7, 8, 10, 30).getTime())
  })
})

describe('buildSimulateInput', () => {
  it('refuses to build without a camera', () => {
    expect(buildSimulateInput(emptySimulateForm())).toBeNull()
  })

  it('OMITS every empty optional rather than sending a zero or an empty string', () => {
    const input = buildSimulateInput(form())
    expect(input).not.toBeNull()
    expect(input).not.toHaveProperty('confidence')
    expect(input).not.toHaveProperty('labelConfidence')
    expect(input).not.toHaveProperty('importance')
    expect(input).not.toHaveProperty('dwellSeconds')
    expect(input).not.toHaveProperty('label')
    expect(input).not.toHaveProperty('timestamp')
    expect(input).not.toHaveProperty('onlyRuleId')
    expect(input).not.toHaveProperty('source')
    expect(input).not.toHaveProperty('bbox')
    expect(input).not.toHaveProperty('occupancy')
    // The non-optional half is always present.
    expect(input?.deviceId).toBe(101)
    expect(input?.classNames).toEqual([])
    expect(input?.zones).toEqual([])
    expect(input?.still).toBe('live')
    expect(input?.bypassCooldown).toBe(false)
    expect(input?.runActions).toBe(false)
  })

  it('sends an explicit ZERO — absent and zero are different subjects', () => {
    const input = buildSimulateInput(form({ confidence: 0, dwellSeconds: 0 }))
    expect(input?.confidence).toBe(0)
    expect(input?.dwellSeconds).toBe(0)
  })

  it('drops the fields the chosen trigger cannot carry', () => {
    const objectEvent = buildSimulateInput(
      form({
        trigger: 'object-event',
        packagePhase: 'delivered',
        sensorKind: 'doorbell',
        eventType: 'press',
        sourceDeviceId: 900,
      }),
    )
    expect(objectEvent).not.toHaveProperty('packagePhase')
    expect(objectEvent).not.toHaveProperty('sensorKind')
    expect(objectEvent).not.toHaveProperty('eventType')
    expect(objectEvent).not.toHaveProperty('sourceDeviceId')

    const deviceEvent = buildSimulateInput(
      form({ trigger: 'device-event', sensorKind: 'doorbell', sourceDeviceId: 900 }),
    )
    expect(deviceEvent?.sensorKind).toBe('doorbell')
    expect(deviceEvent?.sourceDeviceId).toBe(900)
  })

  it('omits a source device that IS the camera', () => {
    const input = buildSimulateInput(form({ trigger: 'device-event', sourceDeviceId: 101 }))
    expect(input).not.toHaveProperty('sourceDeviceId')
  })

  it('sends a crossing only for an object event, and only when enabled', () => {
    expect(
      buildSimulateInput(form({ trigger: 'object-event', crossingEnabled: false })),
    ).not.toHaveProperty('crossing')
    expect(
      buildSimulateInput(
        form({ trigger: 'object-event', crossingEnabled: true, crossingZoneId: 'z1' }),
      )?.crossing,
    ).toEqual({ zoneId: 'z1', direction: 'enter' })
    expect(
      buildSimulateInput(form({ trigger: 'track-end', crossingEnabled: true })),
    ).not.toHaveProperty('crossing')
  })

  it('sends the occupancy block only for an occupancy edge, normalised to ints', () => {
    const input = buildSimulateInput(
      form({
        trigger: 'occupancy-event',
        occupancy: {
          zoneId: ' z-yard ',
          zoneName: '',
          className: '',
          count: 2.4,
          previousCount: -1,
          occupied: true,
          threshold: 0,
        },
      }),
    )
    expect(input?.occupancy).toEqual({
      zoneId: 'z-yard',
      count: 2,
      previousCount: 0,
      occupied: true,
      threshold: 1,
    })
  })

  it('round-trips a prefilled rule into a runnable payload', () => {
    const state = prefillFromRule(
      rule({
        delivery: 'device-event',
        conditions: { devices: [102], sensorKinds: ['doorbell'], eventTypeTokens: ['press'] },
      }),
    )
    const input = buildSimulateInput(state)
    expect(input).toMatchObject({
      trigger: 'device-event',
      deviceId: 102,
      sensorKind: 'doorbell',
      eventType: 'press',
      onlyRuleId: 'r1',
    })
  })
})

describe('the rules → simulate handoff', () => {
  beforeEach(() => clearSimulatePrefill())

  it('parks a prefill that can be peeked TWICE (StrictMode re-invokes initializers)', () => {
    expect(peekSimulatePrefill()).toBeNull()
    parkSimulatePrefill(prefillForRule(rule({ name: 'Gate', conditions: { devices: [101] } })))
    expect(peekSimulatePrefill()?.ruleName).toBe('Gate')
    expect(peekSimulatePrefill()?.form.deviceId).toBe(101)
    clearSimulatePrefill()
    expect(peekSimulatePrefill()).toBeNull()
  })
})

describe('parseSimulateResult', () => {
  const valid = {
    recordId: 'synthetic:abc',
    origin: 'synthetic',
    delivery: 'immediate',
    candidates: 2,
    outcomes: [
      {
        ruleId: 'r1',
        ruleName: 'Front door',
        matched: true,
        cooldown: 'clear',
        enqueued: 1,
        targetIds: ['t1'],
      },
    ],
    still: 'live',
    notes: ['A live snapshot was taken.'],
  }

  it('reads a well-formed answer', () => {
    const parsed = parseSimulateResult(valid)
    expect(parsed?.recordId).toBe('synthetic:abc')
    expect(parsed?.outcomes).toHaveLength(1)
    expect(parsed?.notes).toEqual(['A live snapshot was taken.'])
  })

  it('returns null for an answer this build cannot read', () => {
    expect(parseSimulateResult(null)).toBeNull()
    expect(parseSimulateResult('ok')).toBeNull()
    expect(parseSimulateResult({ ...valid, origin: 'live' })).toBeNull()
    expect(parseSimulateResult({ ...valid, still: 'maybe' })).toBeNull()
    expect(parseSimulateResult({ ...valid, recordId: undefined })).toBeNull()
  })

  it('drops an unreadable OUTCOME rather than the whole answer', () => {
    const parsed = parseSimulateResult({
      ...valid,
      outcomes: [
        ...valid.outcomes,
        { ruleId: 'r2', ruleName: 'x', matched: true, cooldown: '???' },
      ],
    })
    expect(parsed?.outcomes).toHaveLength(1)
  })
})

describe('summariseSimulateResult', () => {
  function result(overrides: Record<string, unknown> = {}) {
    const parsed = parseSimulateResult({
      recordId: 'synthetic:abc',
      origin: 'synthetic',
      delivery: 'device-event',
      candidates: 0,
      outcomes: [],
      still: 'unattachable',
      notes: [],
      ...overrides,
    })
    if (parsed === null) throw new Error('fixture is not a valid result')
    return parsed
  }

  it('says WHY nothing happened — never renders as an empty result', () => {
    expect(summariseSimulateResult(result())).toContain('No enabled rule declares')
    expect(summariseSimulateResult(result())).toContain('device-event')
  })

  it('reports a drop before evaluation', () => {
    expect(summariseSimulateResult(result({ droppedBy: 'muted' }))).toContain('muted')
  })

  it('counts matches and enqueued rows', () => {
    const summary = summariseSimulateResult(
      result({
        candidates: 2,
        outcomes: [
          {
            ruleId: 'r1',
            ruleName: 'a',
            matched: true,
            cooldown: 'clear',
            enqueued: 2,
            targetIds: ['t1', 't2'],
          },
          {
            ruleId: 'r2',
            ruleName: 'b',
            matched: false,
            cooldown: 'n/a',
            enqueued: 0,
            targetIds: [],
          },
        ],
      }),
    )
    expect(summary).toBe('1 of 2 candidate rules matched — 2 notifications enqueued.')
  })

  it('says so when candidates existed but none matched', () => {
    expect(
      summariseSimulateResult(
        result({
          candidates: 1,
          outcomes: [
            {
              ruleId: 'r1',
              ruleName: 'a',
              matched: false,
              failedCondition: 'minConfidence',
              cooldown: 'n/a',
              enqueued: 0,
              targetIds: [],
            },
          ],
        }),
      ),
    ).toBe('1 candidate rule evaluated, none matched.')
  })
})
