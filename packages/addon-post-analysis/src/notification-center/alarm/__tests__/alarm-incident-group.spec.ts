/**
 * D705 — the alarm incident as a D692 group: which subjects become tiles, in
 * which order, and when the combined row is NOT a mosaic at all.
 */
import { describe, expect, it } from 'vitest'
import type { NcRuleFireRef } from '../../rule-engine.js'
import { alarmIncidentGroup, type NcAlarmIncidentSubject } from '../alarm-incident-group.js'

const TRIGGERED_AT = 50_000

const SOURCE: NcRuleFireRef = {
  ruleId: 'r-gate',
  ruleName: 'Intrusione cancello',
  deviceId: 101,
  recordId: '42',
  trackId: 'trk-gate',
  eventId: '42',
  className: 'person',
  label: 'Bob',
  timestamp: 30_000,
}

const FOLLOWER: NcRuleFireRef = {
  ruleId: 'r-drive',
  ruleName: 'Intrusione vialetto',
  deviceId: 102,
  recordId: '43',
  trackId: 'trk-drive',
  eventId: '43',
  className: 'car',
  timestamp: 38_000,
}

/** A contact with no camera: nothing to photograph, so no tile. */
const BARE_SENSOR: NcRuleFireRef = {
  ruleId: 'r-door',
  ruleName: 'Porta',
  deviceId: 3243,
  sourceDeviceId: 3243,
  recordId: 'sensor-1',
  timestamp: 40_000,
}

/** A contact whose linked cameras were photographed (ADR 0632): a shelf owner. */
const LINKED_SENSOR: NcRuleFireRef = {
  ...BARE_SENSOR,
  ruleId: 'r-window',
  recordId: 'sensor-2',
  trackId: 'nc-mosaic:abc',
  timestamp: 41_000,
}

function triggeredAlarm(followers?: readonly NcRuleFireRef[]): NcAlarmIncidentSubject {
  return {
    kind: 'alarm-triggered',
    subject: 'alarm:1023',
    alarmSource: SOURCE,
    ...(followers !== undefined ? { alarmFollowers: followers } : {}),
  }
}

describe('alarmIncidentGroup', () => {
  it('source first, then followers — each a tile with ITS OWN event generation', () => {
    const group = alarmIncidentGroup(triggeredAlarm([FOLLOWER]), TRIGGERED_AT)
    expect(group).toEqual({
      version: 2,
      key: 'alarm:1023@30000',
      openedAt: 30_000,
      closedAt: TRIGGERED_AT,
      closeReason: 'deadline',
      members: [
        {
          trackId: 'trk-gate',
          className: 'person',
          label: 'Bob',
          eventId: '42',
          eventDeviceId: 101,
          eventAt: 30_000,
          triggerAt: 30_000,
        },
        {
          trackId: 'trk-drive',
          className: 'car',
          eventId: '43',
          eventDeviceId: 102,
          eventAt: 38_000,
          triggerAt: 38_000,
        },
      ],
    })
  })

  it('no followers ⇒ no group: the single-trigger row is unchanged', () => {
    expect(alarmIncidentGroup(triggeredAlarm(), TRIGGERED_AT)).toBeUndefined()
    expect(alarmIncidentGroup(triggeredAlarm([]), TRIGGERED_AT)).toBeUndefined()
  })

  it('a follower with nothing to photograph is no tile — one picture is not a mosaic', () => {
    expect(alarmIncidentGroup(triggeredAlarm([BARE_SENSOR]), TRIGGERED_AT)).toBeUndefined()
  })

  it('a sensor whose linked cameras were photographed IS a tile (its shelf owner)', () => {
    const group = alarmIncidentGroup(triggeredAlarm([BARE_SENSOR, LINKED_SENSOR]), TRIGGERED_AT)
    expect(group?.members.map((m) => m.trackId)).toEqual(['trk-gate', 'nc-mosaic:abc'])
    // No class on a sensor match: the row's own filler, never an invented noun.
    expect(group?.members[1]?.className).toBe('event')
    expect(group?.members[1]).not.toHaveProperty('eventId')
  })

  it('one subject is one tile, however many rules pressed for it', () => {
    const again: NcRuleFireRef = { ...FOLLOWER, ruleId: 'r-other', recordId: '44' }
    const group = alarmIncidentGroup(triggeredAlarm([FOLLOWER, again]), TRIGGERED_AT)
    expect(group?.members.map((m) => m.trackId)).toEqual(['trk-gate', 'trk-drive'])
  })

  it('only the TRIGGERED row is a mosaic — never the countdown, never without a source', () => {
    expect(
      alarmIncidentGroup({ ...triggeredAlarm([FOLLOWER]), kind: 'alarm-pending' }, TRIGGERED_AT),
    ).toBeUndefined()
    expect(
      alarmIncidentGroup(
        { kind: 'alarm-triggered', subject: 'alarm:1023', alarmFollowers: [FOLLOWER] },
        TRIGGERED_AT,
      ),
    ).toBeUndefined()
  })
})
