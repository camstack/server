/**
 * Every delivery says what it is about: the rule, the event kind and the detected class ride in
 * `metadata`. A notifier group routes a member on them, so a delivery without them reaches no
 * filtered member at all.
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { contentMetadataOf, eventKindOf } from '../content-metadata.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'

function entry(over: Partial<NcOutboxEntry['payload']> = {}): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 101,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Person at gate',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      params: {},
      subject: {
        deviceId: 101,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        zones: [],
        timestamp: 1_753_000_000_000,
      },
      ...over,
    },
  }
}

function withSubject(extra: Partial<NcOutboxEntry['payload']['subject']>): NcOutboxEntry {
  const base = entry()
  return { ...base, payload: { ...base.payload, subject: { ...base.payload.subject, ...extra } } }
}

describe('the content metadata of a delivery', () => {
  it('a detection carries its rule, its kind and its class to the notifier', async () => {
    const sends: NcSendInput[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'x', name: 'echo', kind: 'k', enabled: true },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Gate',
      now: () => 1_800_000_000_000,
    })
    await dispatcher.deliver(entry())
    expect(sends[0]?.notification.metadata).toEqual({
      ruleId: 'rule-1',
      eventKind: 'detection',
      className: 'person',
    })
  })

  it('names the kind from the delivery and from what the subject holds', () => {
    expect(eventKindOf(entry({ delivery: 'track-end' }))).toBe('detection')
    expect(eventKindOf(entry({ delivery: 'device-event' }))).toBe('device-event')
    expect(eventKindOf(entry({ delivery: 'timelapse' }))).toBe('timelapse')
    expect(eventKindOf(entry({ delivery: 'ai-summary' }))).toBe('summary')
    expect(eventKindOf(entry({ delivery: 'calendar-events' }))).toBe('calendar')
    expect(eventKindOf(entry({ delivery: 'package-event' }))).toBe('package')
    expect(eventKindOf(withSubject({ applianceCycle: { deviceId: 5 } }))).toBe('appliance')
  })

  it('a row that is not a detection carries no class', () => {
    expect(contentMetadataOf(entry({ delivery: 'device-event' }))).toEqual({
      ruleId: 'rule-1',
      eventKind: 'device-event',
    })
  })
})
