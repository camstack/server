import { NcRuleInputSchema, type SensorEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  evaluateRule,
  ruleBelongsToAlarm,
  subjectFromSensorEvent,
  subjectFromUnownedSensorEvent,
} from '../rule-engine.js'

const PANEL = 900
const WINDOW = 3243
const CAMERA = 101
const lookup = (id: number): readonly string[] | undefined =>
  id === PANEL ? ['armed_away'] : undefined

function event(
  kind: string,
  value: Record<string, unknown>,
  deviceId: number = WINDOW,
): SensorEvent {
  return { id: 'e1', deviceId, sourceDeviceId: WINDOW, kind, value, timestamp: 1000 }
}

function rule(overrides: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'r',
    delivery: 'device-event',
    targets: [{ targetId: 't' }],
    ...overrides,
  })
}

const gatedOnAway = rule({
  conditions: { devices: [WINDOW], deviceState: { deviceId: PANEL, states: ['armed_away'] } },
})
function triggering(onMatch: boolean) {
  return rule({
    conditions: { devices: [WINDOW] },
    actions: onMatch
      ? {
          onTrigger: [
            {
              kind: 'do',
              action: { kind: 'cap', cap: 'alarm-panel', method: 'trigger', deviceId: PANEL },
            },
          ],
        }
      : {
          // Button-only — no onTrigger binding ⇒ not an alarm rule.
          buttons: [
            {
              id: 'siren',
              label: 'Siren',
              sequenceId: 's-siren',
            },
          ],
        },
  })
}
const triggersPanel = triggering(true)
const chime = rule({ conditions: { devices: [WINDOW] } })

const judge = (r: ReturnType<typeof rule>, kind: string, value: Record<string, unknown>) =>
  evaluateRule(r, subjectFromSensorEvent(event(kind, value)), lookup)

describe('an alarm rule fires on the opening edge only', () => {
  it('a window opening while armed matches', () => {
    expect(judge(gatedOnAway, 'contact', { entryOpen: true }).matched).toBe(true)
  })

  it('a window closing while armed does NOT match, and says why', () => {
    const r = judge(gatedOnAway, 'contact', { entryOpen: false })
    expect(r.matched).toBe(false)
    expect(r.failedCondition).toBe('sensorEdge')
  })

  it('a rule that triggers the panel is an alarm rule even without the gate', () => {
    expect(judge(triggersPanel, 'contact', { entryOpen: false }).failedCondition).toBe('sensorEdge')
    expect(judge(triggersPanel, 'contact', { entryOpen: true }).matched).toBe(true)
  })

  it('a DISABLED trigger sequence pulls no trigger — the rule is not the alarm', () => {
    expect(ruleBelongsToAlarm(triggering(false))).toBe(false)
    expect(judge(triggering(false), 'contact', { entryOpen: false }).matched).toBe(true)
  })

  it('locks and covers: unlock and opening fire; lock and close do not', () => {
    expect(judge(gatedOnAway, 'lock', { state: 'unlocked' }).matched).toBe(true)
    expect(judge(gatedOnAway, 'lock', { state: 'locked' }).matched).toBe(false)
    expect(judge(gatedOnAway, 'cover', { state: 'opening' }).matched).toBe(true)
    expect(judge(gatedOnAway, 'cover', { state: 'closing' }).matched).toBe(false)
  })

  it('a jammed lock is a fault, not an entry', () => {
    expect(judge(gatedOnAway, 'lock', { state: 'jammed' }).failedCondition).toBe('sensorEdge')
  })

  it('a stopped cover is neither edge', () => {
    expect(judge(gatedOnAway, 'cover', { state: 'stopped' }).failedCondition).toBe('sensorEdge')
  })

  it('a rule outside the alarm keeps firing on BOTH edges — no silent change', () => {
    expect(judge(chime, 'contact', { entryOpen: false }).matched).toBe(true)
    expect(judge(chime, 'contact', { entryOpen: true }).matched).toBe(true)
  })

  it('a kind with no opening meaning is not filtered, even for an alarm rule', () => {
    expect(judge(gatedOnAway, 'motion-sensor', { detected: true }).matched).toBe(true)
  })

  it('still an alarm rule while the panel answers through its pending/triggered alias', () => {
    const incident = (id: number): readonly string[] | undefined =>
      id === PANEL ? ['triggered', 'armed_away'] : undefined
    const closing = subjectFromSensorEvent(event('contact', { entryOpen: false }))
    const opening = subjectFromSensorEvent(event('contact', { entryOpen: true }))
    expect(evaluateRule(gatedOnAway, closing, incident).failedCondition).toBe('sensorEdge')
    expect(evaluateRule(gatedOnAway, opening, incident).matched).toBe(true)
  })

  it('every camera row of one change gets the same answer, and so does an unlinked sensor', () => {
    const onCamera = subjectFromSensorEvent(event('contact', { entryOpen: false }, CAMERA))
    const unlinked = subjectFromUnownedSensorEvent(event('contact', { entryOpen: false }), [])
    expect(onCamera.sensorEdge).toBe('closing')
    expect(unlinked.sensorEdge).toBe('closing')
    expect(evaluateRule(gatedOnAway, onCamera, lookup).failedCondition).toBe('sensorEdge')
    expect(evaluateRule(gatedOnAway, unlinked, lookup).failedCondition).toBe('sensorEdge')
    const opening = subjectFromUnownedSensorEvent(event('contact', { entryOpen: true }), [])
    expect(evaluateRule(gatedOnAway, opening, lookup).matched).toBe(true)
  })

  // Task 7b review: the edge gate ran BEFORE `deviceState`, so a closing on a
  // DISARMED panel was reported as `sensorEdge` — a reason that sends the
  // operator after the wrong gate.
  it('a closing on a DISARMED panel fails on deviceState, the gate that really stopped it', () => {
    const disarmed = (id: number): readonly string[] | undefined =>
      id === PANEL ? ['disarmed'] : undefined
    const closing = subjectFromSensorEvent(event('contact', { entryOpen: false }))
    expect(evaluateRule(gatedOnAway, closing, disarmed).failedCondition).toBe('deviceState')
  })

  it('a subject whose kind has no opening meaning carries no edge', () => {
    expect(subjectFromSensorEvent(event('doorbell', { lastPressAt: 1 })).sensorEdge).toBeUndefined()
  })
})
