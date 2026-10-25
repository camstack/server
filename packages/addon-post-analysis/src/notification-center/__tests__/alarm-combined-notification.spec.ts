/**
 * The COMBINED notification — a rule that tripped the alarm.
 *
 * One row carries the alarm's severity and the rule's own words. The title is
 * the severity marker (`Alarm: <camera>`, from a template an operator can
 * re-word per rule or in the Texts tab); the BODY is the sentence the rule's
 * ordinary detection notification would have had — same class, same label,
 * same zones, same camera.
 *
 * That composition is the point. The alarm used to invent its own prose ("The
 * alarm was triggered by Person at gate on Front door"), so the one notification
 * an operator receives at 3am was the ONLY one in the system that did not look
 * like every other notification from that rule: a different subject, no zone,
 * no identity. Now the familiar line arrives with `Allarme:` in front of it.
 *
 * Both halves are pinned here: the KEYS chosen at intake, and the VARS the
 * dispatcher composes for them — a key without the detection vocabulary
 * renders `{{subject}}` as the dedup slot (`alarm:42`), which is exactly the
 * regression this file exists to catch.
 */

import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import { incomingFromAlarmTransition } from '../event-intake.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcRuleFireRef } from '../rule-engine.js'
import { type NcLanguage, NcTextCatalog } from '../text-catalog.js'
import type { NcAlarmTransition } from '../alarm/alarm-transitions.js'

const CAMERA = 102
const PANEL = 42

const IDENTITY: NcDeviceIdentity = {
  deviceId: CAMERA,
  type: 'camera',
  name: 'Front door',
  isCamera: true,
}

const LOOKUP = (deviceId: number): NcDeviceIdentity | undefined =>
  deviceId === CAMERA ? IDENTITY : undefined

function fireRef(patch: Partial<NcRuleFireRef> = {}): NcRuleFireRef {
  return {
    ruleId: 'rule-1',
    ruleName: 'Person at gate',
    deviceId: CAMERA,
    recordId: 'ev-1',
    trackId: 'trk-1',
    eventId: 'ev-1',
    timestamp: 1_753_000_000_000,
    className: 'person',
    label: 'John',
    zones: ['z1'],
    ...patch,
  }
}

function triggered(source?: NcRuleFireRef): NcAlarmTransition {
  return {
    kind: 'alarm-triggered',
    state: 'triggered',
    previous: 'armed_away',
    at: 1_753_000_000_000,
    ...(source !== undefined ? { source } : {}),
  }
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
]

function makeEntry(payload: Partial<NcOutboxPayload>): NcOutboxEntry {
  return {
    id: 'rule-2:ev-1:tgt-1',
    ruleId: 'rule-2',
    targetId: 'tgt-1',
    deviceId: CAMERA,
    recordKind: 'system-event',
    recordId: 'alarm:alarm-triggered:1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Tell me when the alarm goes off',
      delivery: 'system-event',
      priority: 4,
      media: 'none',
      subject: { deviceId: CAMERA, className: 'event', zones: [], timestamp: 1 },
      ...payload,
    },
  }
}

/** The row the intake actually produces, projected onto an outbox entry the
 *  way `buildEntries` does — no hand-written system-event subject, so a change
 *  to the intake's key selection reaches these assertions. */
function rowFor(
  source: NcRuleFireRef | undefined,
  template?: NcOutboxPayload['template'],
): NcOutboxEntry {
  const incoming = incomingFromAlarmTransition({
    transition: triggered(source),
    panelDeviceId: PANEL,
    lookup: LOOKUP,
  })
  const systemEvent = incoming.subject.systemEvent
  if (systemEvent === undefined) throw new Error('the intake produced no system event')
  return makeEntry({
    ...(template !== undefined ? { template } : {}),
    subject: {
      deviceId: incoming.subject.deviceId,
      className: 'event',
      zones: [],
      timestamp: incoming.subject.timestamp,
      systemEvent,
    },
  })
}

async function deliver(
  entry: NcOutboxEntry,
  language: NcLanguage = 'en',
  overrides: Readonly<Record<string, string>> = {},
): Promise<NcSendInput> {
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    texts: new NcTextCatalog({ language, overrides: { [language]: overrides } }),
    listTargets: async () => TARGETS,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Front door',
    getZoneNames: async () => [{ id: 'z1', name: 'gate' }],
  })
  await dispatcher.deliver(entry)
  const sent = sends[0]
  if (sent === undefined) throw new Error('nothing was sent')
  return sent
}

describe('the intake', () => {
  it('picks the combined keys when a rule set the alarm off', () => {
    const incoming = incomingFromAlarmTransition({
      transition: triggered(fireRef()),
      panelDeviceId: PANEL,
      lookup: LOOKUP,
    })
    expect(incoming.subject.systemEvent?.titleKey).toBe('alarm.combined.title')
    // D706: the body names WHERE the intrusion went, not one camera's detection line.
    expect(incoming.subject.systemEvent?.bodyKey).toBe('alarm.intrusion.body')
    expect(incoming.subject.systemEvent?.textParams?.['locations']).toBe('Front door')
  })

  it('leaves a MANUAL trigger on the alarm sentence — there is no detection to say', () => {
    const incoming = incomingFromAlarmTransition({
      transition: triggered(),
      panelDeviceId: PANEL,
      lookup: LOOKUP,
    })
    expect(incoming.subject.systemEvent?.titleKey).toBe('system.alarm-triggered.title')
    expect(incoming.subject.systemEvent?.bodyKey).toBe('system.alarm-triggered.body')
  })

  it('freezes the source on an ENTRY-DELAY pending so the announce can attach pictures', () => {
    const incoming = incomingFromAlarmTransition({
      transition: {
        kind: 'alarm-pending',
        state: 'pending',
        previous: 'armed_night',
        at: 1,
        seconds: 20,
        source: fireRef(),
      },
      panelDeviceId: PANEL,
      lookup: LOOKUP,
    })
    expect(incoming.subject.systemEvent?.alarmSource?.trackId).toBe('trk-1')
    expect(incoming.subject.systemEvent?.alarmSource?.ruleId).toBe('rule-1')
    // Pending keeps the countdown sentence — combined keys are siren-only.
    expect(incoming.subject.systemEvent?.titleKey).toBe('system.alarm-pending.title')
  })

  it('keeps the alarm title for a source with no detection vocabulary, and names the location (D706)', () => {
    // A sensor's fire ref carries no class: the title stays the alarm's own, the body is
    // the intrusion line like every other rule-caused trigger.
    const incoming = incomingFromAlarmTransition({
      transition: triggered(fireRef({ className: undefined })),
      panelDeviceId: PANEL,
      lookup: LOOKUP,
    })
    expect(incoming.subject.systemEvent?.titleKey).toBe('system.alarm-triggered.title')
    expect(incoming.subject.systemEvent?.bodyKey).toBe('alarm.intrusion.body')
  })

  it('lists the LOCATION of the source and of every follower, distinct, in arrival order (D706)', () => {
    const places: Readonly<Record<number, NcDeviceIdentity>> = {
      [CAMERA]: { ...IDENTITY, location: 'Front door' },
      101: {
        deviceId: 101,
        type: 'camera',
        name: 'Cam 101',
        isCamera: true,
        location: 'Hallway',
      },
      616: {
        deviceId: 616,
        type: 'camera',
        name: 'Cam 616',
        isCamera: true,
        location: 'Hallway',
      },
      501: { deviceId: 501, type: 'sensor', name: 'Porta hall', isCamera: false, location: null },
    }
    const incoming = incomingFromAlarmTransition({
      transition: {
        ...triggered(fireRef()),
        followers: [
          fireRef({ deviceId: 101, trackId: 't2' }),
          fireRef({ deviceId: 616, trackId: 't3' }),
          // A sensor match is placed by the SENSOR; no location ⇒ its name.
          fireRef({ deviceId: CAMERA, sourceDeviceId: 501, trackId: undefined, recordId: 's1' }),
        ],
      },
      panelDeviceId: PANEL,
      lookup: (id) => places[id],
    })
    expect(incoming.subject.systemEvent?.textParams?.['locations']).toBe(
      'Front door, Hallway, Porta hall',
    )
  })
})

describe('the combined delivery', () => {
  it('titles with the camera and bodies with the intrusion locations (D706)', async () => {
    const sent = await deliver(rowFor(fireRef()))
    expect(sent.notification.title).toBe('Alarm: Front door')
    expect(sent.notification.body).toBe('Intrusion: Front door')
  })

  it('says the same thing in Italian', async () => {
    const sent = await deliver(rowFor(fireRef()), 'it')
    expect(sent.notification.title).toBe('Allarme: Front door')
    expect(sent.notification.body).toBe('Intrusione: Front door')
  })

  it('never mentions a siren', async () => {
    for (const language of ['en', 'it'] as const) {
      const sent = await deliver(rowFor(fireRef()), language)
      expect(`${sent.notification.title} ${sent.notification.body}`).not.toMatch(/siren|sirena/i)
    }
  })

  it('lets the rule’s own template win over the shipped title', async () => {
    const sent = await deliver(rowFor(fireRef(), { title: 'INTRUSIONE {{camera}}' }))
    expect(sent.notification.title).toBe('INTRUSIONE front door')
    expect(sent.notification.body).toBe('Intrusion: Front door')
  })

  it('lets a Texts-tab override win over the shipped title', async () => {
    const sent = await deliver(rowFor(fireRef()), 'en', {
      'alarm.combined.title': '🚨 {{deviceName}}',
    })
    expect(sent.notification.title).toBe('🚨 Front door')
  })

  it('still speaks the alarm sentence for a manual trigger', async () => {
    const sent = await deliver(rowFor(undefined))
    expect(sent.notification.title).toBe('ALARM')
    expect(sent.notification.body).toBe('Alarm triggered')
  })

  it('does not leak the dedup slot into the body', async () => {
    const sent = await deliver(rowFor(fireRef()))
    expect(sent.notification.body).not.toContain('alarm:')
  })
})

describe('a row enqueued before this deploy', () => {
  it('renders from the keys frozen on it', async () => {
    // The durable-row rule: a combined row already in SQLite carries the OLD
    // keys and no detection vocabulary. It must drain as the sentence it was
    // written for, never as a `detection.body` with an empty subject.
    const legacy = makeEntry({
      subject: {
        deviceId: CAMERA,
        className: 'event',
        zones: [],
        timestamp: 1,
        systemEvent: {
          kind: 'alarm-triggered',
          subject: `alarm:${PANEL}`,
          titleKey: 'system.alarm-triggered.title',
          bodyKey: 'system.alarm-triggered.body.rule',
          textParams: { deviceName: 'Front door', rule: 'Person at gate' },
          alarmSource: {
            ruleId: 'rule-1',
            ruleName: 'Person at gate',
            deviceId: CAMERA,
            recordId: 'ev-1',
            timestamp: 1,
          },
          deviceId: CAMERA,
          data: {},
        },
      },
    })
    const sent = await deliver(legacy)
    expect(sent.notification.title).toBe('ALARM')
    expect(sent.notification.body).toBe('Triggered by Person at gate on Front door')
  })
})
