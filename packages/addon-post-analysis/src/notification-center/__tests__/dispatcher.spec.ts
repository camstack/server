/**
 * NcDispatcher unit tests with a fake api — target resolution (unknown →
 * permanent dead-letter; globally-disabled → benign skip; catalog refresh on
 * miss; unreachable catalog → transient), notification composition
 * (templates, defaults, priority
 * clamp, per-target params), media policy resolution (best / keyFrame /
 * none, event→track fallback) and send-result mapping.
 */

import {
  type MediaFile,
  NC_CLIP_POST_ROLL_DEFAULT_SEC,
  NC_CLIP_PRE_ROLL_DEFAULT_SEC,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { defined } from '../../__tests__/support/vitest-mock.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  NcDispatcher,
  type NcDispatcherDeps,
  type NcEventMediaRequest,
  type NcNotificationAttachment,
  type NcSendInput,
  type NcTargetRef,
} from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxOccupancySubject, NcOutboxPayload } from '../outbox.js'

function makeEntry(
  payload: Partial<NcOutboxPayload> = {},
  overrides: Partial<NcOutboxEntry> = {},
): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 104,
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
      subject: {
        deviceId: 104,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        label: 'John',
        confidence: 0.87,
        zones: ['gate'],
        timestamp: 1_753_000_000_000,
      },
      ...payload,
    },
    ...overrides,
  }
}

/**
 * `timestamp` was `1` here for as long as nothing read it. It is LOAD-BEARING
 * now — an `immediate` rule's still must be from the trigger instant
 * (`NC_TRIGGER_STILL_MAX_AGE_MS`) — so the fixture carries the subject's own
 * instant. These tests are about media POLICY; staleness has its own file.
 */
function mediaFile(kind: MediaFile['kind'], content = 'jpegdata'): MediaFile {
  const mediaId = content.length + kind.length + 1_000
  return {
    mediaId,
    kind,
    url: `/addon/test/event-media/m/${mediaId}`,
    base64: Buffer.from(content).toString('base64'),
    sizeBytes: content.length,
    timestamp: 1_753_000_000_000,
  }
}

function attachmentBytesText(att: NcNotificationAttachment): string {
  const bytes = att.bytes
  if (bytes === undefined) throw new Error('attachment missing bytes')
  return Buffer.from(bytes).toString()
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly listCalls: { count: number }
  setTargets(targets: readonly NcTargetRef[]): void
  setSendResult(result: { success: boolean; error?: string } | 'throw'): void
  setMedia(ownerKind: 'object' | 'track', ownerId: string, files: readonly MediaFile[]): void
}

function makeHarness(): Harness {
  let targets: readonly NcTargetRef[] = [
    { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
  ]
  let sendResult: { success: boolean; error?: string } | 'throw' = { success: true }
  const media = new Map<string, readonly MediaFile[]>()
  const sends: NcSendInput[] = []
  const listCalls = { count: 0 }
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    listTargets: async () => {
      listCalls.count += 1
      return targets
    },
    send: async (input) => {
      sends.push(input)
      if (sendResult === 'throw') throw new Error('rpc down')
      return sendResult
    },
    getMediaForOwner: async (ownerKind, ownerId) => media.get(`${ownerKind}:${ownerId}`) ?? [],
    getDeviceName: async (deviceId) => (deviceId === 104 ? 'Driveway' : null),
  })
  return {
    dispatcher,
    sends,
    listCalls,
    setTargets: (t) => {
      targets = t
    },
    setSendResult: (r) => {
      sendResult = r
    },
    setMedia: (ownerKind, ownerId, files) => {
      media.set(`${ownerKind}:${ownerId}`, files)
    },
  }
}

describe('NcDispatcher target resolution', () => {
  it('unknown target in a NON-empty catalog → permanent failure (dead-letter)', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.deliver(makeEntry({}, { targetId: 'nope' }))
    expect(result).toEqual({ ok: false, error: 'target not found: nope', permanent: true })
    expect(h.sends).toHaveLength(0)
  })

  describe('NcDispatcher system events', () => {
    it('delivers normalized title/body/data without a synthetic device id', async () => {
      const h = makeHarness()
      const entry = makeEntry(
        {
          delivery: 'system-event',
          media: 'none',
          subject: {
            deviceId: 0,
            className: 'event',
            zones: [],
            timestamp: 1_753_000_000_000,
            systemEvent: {
              kind: 'server-update-available',
              subject: 'package:@camstack/server',
              title: 'Server update available',
              body: '@camstack/server 1.2.90 is available (current 1.2.89)',
              packageName: '@camstack/server',
              data: {
                category: 'update.available',
                currentVersion: '1.2.89',
                latestVersion: '1.2.90',
              },
            },
          },
        },
        {
          deviceId: 0,
          recordKind: 'system-event',
          recordId: 'update-1',
          trackId: undefined,
        },
      )

      expect(await h.dispatcher.deliver(entry)).toEqual({ ok: true })
      expect(h.sends[0]!.notification).toMatchObject({
        title: 'Server update available',
        body: '@camstack/server 1.2.90 is available (current 1.2.89)',
        metadata: {
          systemEventKind: 'server-update-available',
          subject: 'package:@camstack/server',
          latestVersion: '1.2.90',
        },
      })
      expect(h.sends[0]!.notification.deviceId).toBeUndefined()
    })
  })

  // An EMPTY catalog is indistinguishable from a broken transport and must
  // NEVER read as "the target was deleted". Treating them alike is what turned
  // a collection-cap routing gap into permanent loss: every notification the
  // engine produced dead-lettered as "target not found" while the target sat
  // healthy in the hub's catalog (2026-07-30).
  it('EMPTY catalog → transient (throws), never a dead-letter', async () => {
    const h = makeHarness()
    h.setTargets([])
    await expect(h.dispatcher.deliver(makeEntry({}, { targetId: 'tgt-1' }))).rejects.toThrow(
      /empty/i,
    )
    expect(h.sends).toHaveLength(0)
  })

  it('an empty catalog is NOT cached — the next attempt re-fetches and delivers', async () => {
    const h = makeHarness()
    h.setTargets([])
    await expect(h.dispatcher.deliver(makeEntry({}, { targetId: 'tgt-1' }))).rejects.toThrow()
    // Transport recovers: the very next attempt must see the real catalog
    // rather than a cached emptiness that survives the TTL.
    h.setTargets([
      { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
    ])
    const result = await h.dispatcher.deliver(makeEntry({}, { targetId: 'tgt-1' }))
    expect(result.ok).toBe(true)
    expect(h.sends).toHaveLength(1)
  })

  it('globally-disabled target → benign skip (never a dead-letter)', async () => {
    // A target the operator muted via its own `enabled: false` kill-switch is
    // NOT a misconfig — dead-lettering + a WARN per event forever is the wrong
    // signal. It short-circuits benignly (no send), distinct from a NOT-FOUND
    // target which stays a permanent dead-letter.
    const h = makeHarness()
    h.setTargets([
      { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: false },
    ])
    const result = await h.dispatcher.deliver(makeEntry())
    expect(result).toEqual({ ok: true })
    expect(h.sends).toHaveLength(0)
  })

  it('a cache miss forces a catalog refresh before dead-lettering', async () => {
    const h = makeHarness()
    // A POPULATED catalog that does not (yet) carry our target — the honest
    // "this id is unknown" case. (An EMPTY catalog is a different answer
    // entirely: transient, covered above.)
    h.setTargets([
      { id: 'other', addonId: 'notifiers', name: 'Other', kind: 'pushover', enabled: true },
    ])
    expect((await h.dispatcher.deliver(makeEntry())).ok).toBe(false)
    expect(h.listCalls.count).toBe(1)
    // Target appears (just created) → next deliver refreshes and succeeds.
    h.setTargets([
      { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
    ])
    expect((await h.dispatcher.deliver(makeEntry())).ok).toBe(true)
    expect(h.listCalls.count).toBe(2)
  })

  it('an unreachable catalog is TRANSIENT (deliver throws → outbox retries)', async () => {
    const h = makeHarness()
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => {
        throw new Error('hub unreachable')
      },
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    })
    await expect(dispatcher.deliver(makeEntry())).rejects.toThrow('hub unreachable')
    expect(h.sends).toHaveLength(0)
  })
})

describe('NcDispatcher notification composition', () => {
  it('routes send by the target addonId and maps success', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.deliver(makeEntry({ media: 'none' }))
    expect(result).toEqual({ ok: true })
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]!.addonId).toBe('notifiers')
    expect(h.sends[0]!.targetId).toBe('tgt-1')
  })

  it('default title/body: rule name + class/label/camera/zones', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry({ media: 'none' }))
    const n = h.sends[0]!.notification
    expect(n.title).toBe('Person at gate')
    expect(n.body).toBe('Person (John) on driveway in gate')
    expect(n.priority).toBe(3)
    // One-shot (D686): an ungrouped notification carries NO coalescing tag,
    // so a notifier that honours one (HA Companion) cannot replace the last
    // alert of this rule with this one.
    expect(n.tag).toBeUndefined()
    expect(n.deviceId).toBe(104)
    expect(n.eventId).toBe('ev-1')
  })

  it('no row carries a push tag — a v2 grouped row, a legacy D143 row, a plain row (D686, D692)', async () => {
    const rows: readonly Partial<NcOutboxPayload>[] = [
      {
        group: {
          version: 2,
          key: 'grp:rule-1:104:trk-1@1',
          openedAt: 1_753_000_000_000,
          closedAt: 1_753_000_010_000,
          closeReason: 'all-final',
          members: [
            { trackId: 'trk-1', className: 'person', triggerAt: 1_753_000_000_000 },
            { trackId: 'trk-2', className: 'person', triggerAt: 1_753_000_002_000 },
          ],
        },
      },
      {
        group: {
          key: 'grp:rule-1:104:1',
          revision: 2,
          anchorTrackId: 'trk-1',
          members: [
            { trackId: 'trk-1', className: 'person', at: 1 },
            { trackId: 'trk-2', className: 'person', at: 2 },
          ],
        },
      },
      {},
    ]
    for (const payload of rows) {
      const h = makeHarness()
      await h.dispatcher.deliver(makeEntry({ media: 'none', ...payload }))
      expect(h.sends).toHaveLength(1)
      expect(h.sends[0]?.notification).not.toHaveProperty('tag')
    }
  })

  /**
   * THE TEST MARKER. A test notification is byte-for-byte an ordinary one —
   * that is what makes it worth sending — so the recipient has no way to tell
   * it from the real thing, which is fine when they pressed the button and is
   * an alarm they act on when somebody else did.
   *
   * The title is deliberately NOT marked: it is what a lock screen truncates
   * to, and the rule's own words must survive there.
   */
  it('a SYNTHETIC row is marked as a test in the body, and only in the body', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry({ media: 'none', synthetic: true }))
    const n = h.sends[0]!.notification
    expect(n.body).toBe('[TEST] person (John) on driveway in gate')
    expect(n.title).toBe('Person at gate')
  })

  it('an ordinary row is unchanged byte for byte', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry({ media: 'none' }))
    expect(h.sends[0]!.notification.body).toBe('Person (John) on driveway in gate')
  })

  it('marks a row whose body came from the rule’s OWN template too', async () => {
    // The marker wraps the RESOLVED body, whatever resolved it: a rule with a
    // custom template is exactly the rule an operator tests, and leaving those
    // unmarked would leave the marker useful only for default text.
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeEntry({ media: 'none', synthetic: true, template: { body: 'gate opened' } }),
    )
    expect(h.sends[0]!.notification.body).toBe('[TEST] gate opened')
  })

  it('track-end default body carries the visit-ended suffix', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeEntry({ media: 'none', delivery: 'track-end' }, { recordKind: 'track-end' }),
    )
    expect(h.sends[0]!.notification.body).toContain('visit ended')
  })

  it('renders {{var}} templates; missing vars render empty', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeEntry({
        media: 'none',
        template: {
          title: '{{class}} @ {{camera}}',
          body: '{{label}} in {{zone}} ({{confidence}}) {{unknownVar}}',
        },
      }),
    )
    const n = h.sends[0]!.notification
    expect(n.title).toBe('person @ driveway')
    expect(n.body).toBe('John in gate (87%) ')
  })

  it('{{count}}/{{capacity}} render empty on a NON-occupancy entry', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeEntry({ media: 'none', template: { body: '[{{count}}][{{capacity}}]' } }),
    )
    expect(h.sends[0]!.notification.body).toBe('[][]')
  })

  it('unknown device name falls back to a stable placeholder', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeEntry(
        { media: 'none', subject: { deviceId: 7, className: 'dog', zones: [], timestamp: 1 } },
        { deviceId: 7 },
      ),
    )
    expect(h.sends[0]!.notification.body).toBe('Dog on camera 7')
  })

  it('per-target params map onto canonical fields; priority is clamped', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeEntry({
        media: 'none',
        params: {
          priority: 99,
          level: 'emergency',
          sound: 'siren',
          clickUrl: 'https://x/e/1',
          ttl: 120,
          bogus: { nested: true },
        },
      }),
    )
    const n = h.sends[0]!.notification
    expect(n.priority).toBe(5) // clamped
    expect(n.level).toBe('emergency')
    expect(n.sound).toBe('siren')
    expect(n.clickUrl).toBe('https://x/e/1')
    expect(n.ttl).toBe(120)
    expect('bogus' in n).toBe(false)
  })

  it('send failure maps to a transient error', async () => {
    const h = makeHarness()
    h.setSendResult({ success: false, error: 'pushover 500' })
    const result = await h.dispatcher.deliver(makeEntry({ media: 'none' }))
    expect(result).toEqual({ ok: false, error: 'pushover 500', permanent: false })
  })

  it('a thrown send maps to a transient error', async () => {
    const h = makeHarness()
    h.setSendResult('throw')
    const result = await h.dispatcher.deliver(makeEntry({ media: 'none' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.permanent).toBe(false)
  })
})

describe('NcDispatcher occupancy template vars', () => {
  /**
   * An occupancy row: the subject carries the frozen count-edge (A4/A5) and,
   * deliberately, an EMPTY admin `zones` array — occupancy zone scoping lives
   * on the edge, so `{{zone}}` must come from `occupancy.zone`, never `zones`.
   */
  function makeOccupancyEntry(
    occupancy: NcOutboxOccupancySubject,
    payload: Partial<NcOutboxPayload> = {},
  ): NcOutboxEntry {
    return makeEntry(
      {
        media: 'none',
        delivery: 'device-event',
        ruleName: 'Driveway crowded',
        ...payload,
        subject: {
          deviceId: 104,
          className: 'person',
          zones: [],
          timestamp: 1_753_000_000_000,
          occupancy,
        },
      },
      { recordKind: 'device-event', recordId: 'occ-1', trackId: undefined },
    )
  }

  it('renders {{count}}/{{capacity}}/{{zone}} from the frozen edge', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeOccupancyEntry(
        { zone: 'Parking', count: 5, capacity: 3, occupied: true },
        { template: { title: '{{zone}} full', body: '{{count}} of {{capacity}} in {{zone}}' } },
      ),
    )
    const n = h.sends[0]!.notification
    expect(n.title).toBe('parking full')
    // `count` is the CONFIRMED observed count, `capacity` the rule's threshold —
    // two different numbers (5 people against a capacity of 3).
    expect(n.body).toBe('5 of 3 in parking')
  })

  it('{{zone}} comes from the edge even though the admin zones list is empty', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeOccupancyEntry(
        { zone: 'Parking', count: 3, capacity: 3, occupied: true },
        { template: { body: '[{{zone}}][{{zones}}]' } },
      ),
    )
    expect(h.sends[0]!.notification.body).toBe('[parking][]')
  })

  it('default occupancy body: zone, op word and count/capacity', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeOccupancyEntry({ zone: 'Parking', count: 3, capacity: 3, occupied: true }),
    )
    expect(h.sends[0]!.notification.body).toBe('Parking occupied (3/3)')
    expect(h.sends[0]!.notification.title).toBe('Driveway crowded')
  })

  it('a became-free edge renders the free op word', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeOccupancyEntry({ zone: 'Parking', count: 0, capacity: 2, occupied: false }),
    )
    expect(h.sends[0]!.notification.body).toBe('Parking free (0/2)')
  })

  it('a frame-scoped edge (no zone) falls back to the camera name in the default body', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeOccupancyEntry({ count: 4, capacity: 2, occupied: true }))
    expect(h.sends[0]!.notification.body).toBe('Driveway occupied (4/2)')
  })

  it('a frame-scoped edge renders {{zone}} empty (missing var stays empty)', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeOccupancyEntry(
        { count: 4, capacity: 2, occupied: true },
        {
          template: { body: '[{{zone}}][{{op}}]' },
        },
      ),
    )
    expect(h.sends[0]!.notification.body).toBe('[][occupied]')
  })
})

describe('NcDispatcher media policy', () => {
  it("'none' attaches nothing", async () => {
    const h = makeHarness()
    h.setMedia('object', 'ev-1', [mediaFile('crop')])
    await h.dispatcher.deliver(makeEntry({ media: 'none' }))
    expect(h.sends[0]!.notification.attachments).toBeUndefined()
  })

  // D897: every mode renders from the CLEAN scene. These bytes are not JPEGs, so
  // the render fails and ships the source as it is — the name says which one.
  it('the track’s clean scene is the source — never a stored crop, never the boxed frame', async () => {
    const h = makeHarness()
    h.setMedia('object', 'ev-1', [mediaFile('fullFrameBoxed'), mediaFile('crop', 'cropbytes')])
    h.setMedia('track', 'trk-1', [mediaFile('thumbnail'), mediaFile('keyFrame', 'kf')])
    await h.dispatcher.deliver(makeEntry({ media: 'best', mediaImage: 'crop' }))
    const atts = h.sends[0]!.notification.attachments
    expect(atts).toHaveLength(1)
    expect(atts![0]!.name).toBe('keyFrame.jpg')
    expect(attachmentBytesText(atts![0]!)).toBe('kf')
    expect(atts![0]!.mediaType).toBe('image')
  })

  it('with no track scene, the event’s clean full frame is the source', async () => {
    const h = makeHarness()
    h.setMedia('object', 'ev-1', [mediaFile('crop'), mediaFile('fullFrame', 'ff')])
    await h.dispatcher.deliver(makeEntry({ media: 'best', mediaImage: 'clean' }))
    expect(h.sends[0]!.notification.attachments![0]!.name).toBe('fullFrame.jpg')
  })

  it('a record holding only stored subject crops ships no still: a crop is rendered, not picked', async () => {
    const h = makeHarness()
    h.setMedia('object', 'ev-1', [mediaFile('crop'), mediaFile('faceCrop')])
    h.setMedia('track', 'trk-1', [mediaFile('thumbnail')])
    await h.dispatcher.deliver(makeEntry({ media: 'best', mediaImage: 'crop' }))
    expect(h.sends[0]!.notification.attachments).toBeUndefined()
  })

  it('the native keyFrame leads its small twin: the crop keeps the resolution', async () => {
    const h = makeHarness()
    h.setMedia('track', 'trk-1', [mediaFile('keyFrameSmall', 'kfs'), mediaFile('keyFrame')])
    await h.dispatcher.deliver(makeEntry({ media: 'keyFrame' }))
    expect(h.sends[0]!.notification.attachments![0]!.name).toBe('keyFrame.jpg')
  })

  it('no media anywhere → delivered without attachments (never delayed)', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.deliver(makeEntry({ media: 'best' }))
    expect(result.ok).toBe(true)
    expect(h.sends[0]!.notification.attachments).toBeUndefined()
  })

  it('an AUDIO entry (no eventId/trackId owner) delivers text-only, never attaching media', async () => {
    const h = makeHarness()
    // Even if unrelated media exists in the store, an audio subject carries no
    // owner ref, so the attach ladder resolves nothing → text-only send.
    h.setMedia('object', 'ev-1', [mediaFile('crop')])
    const audioEntry = makeEntry(
      {
        media: 'best',
        subject: {
          deviceId: 104,
          className: 'audio-dog',
          zones: [],
          timestamp: 1_753_000_000_000,
        },
      },
      { recordKind: 'audio-event', recordId: 'aud-1', trackId: undefined },
    )
    const result = await h.dispatcher.deliver(audioEntry)
    expect(result.ok).toBe(true)
    expect(h.sends[0]!.notification.attachments).toBeUndefined()
    // The wire id renders through the shared event-kind label map (aaf37d743),
    // lowercased as a placeholder and sentence-cased once as the body.
    expect(h.sends[0]!.notification.body).toBe('Dog on driveway')
  })

  it('a failing media read never blocks delivery', async () => {
    const h = makeHarness()
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'n', kind: 'ntfy', enabled: true },
      ],
      send: async (input) => {
        h.sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => {
        throw new Error('disk gone')
      },
      getDeviceName: async () => null,
    })
    const result = await dispatcher.deliver(makeEntry({ media: 'best' }))
    expect(result.ok).toBe(true)
    expect(h.sends[0]!.notification.attachments).toBeUndefined()
  })
})

describe('NcDispatcher per-target opt-out (send-time)', () => {
  const enabledTarget: NcTargetRef = {
    id: 'tgt-1',
    addonId: 'notifiers',
    name: 'My phone',
    kind: 'pushover',
    enabled: true,
  }
  const baseDeps = {
    logger: makeSilentLogger(),
    listTargets: async (): Promise<readonly NcTargetRef[]> => [enabledTarget],
    getMediaForOwner: async (): Promise<readonly MediaFile[]> => [],
    getDeviceName: async (): Promise<string | null> => null,
  }

  it('skips send when the target is opted out of the rule', async () => {
    let sent = 0
    const d = new NcDispatcher({
      ...baseDeps,
      send: async () => {
        sent += 1
        return { success: true }
      },
      isRuleTargetDisabled: async (ruleId, targetId) => ruleId === 'rule-1' && targetId === 'tgt-1',
    })
    const res = await d.deliver(makeEntry({ media: 'none' }))
    expect(res.ok).toBe(true)
    expect(sent).toBe(0)
  })

  it('delivers a non-opted target (opt-out check returns false)', async () => {
    let sent = 0
    const d = new NcDispatcher({
      ...baseDeps,
      send: async () => {
        sent += 1
        return { success: true }
      },
      isRuleTargetDisabled: async () => false,
    })
    const res = await d.deliver(makeEntry({ media: 'none' }))
    expect(res.ok).toBe(true)
    expect(sent).toBe(1)
  })

  it('an absent opt-out dep preserves today’s behavior (delivered)', async () => {
    let sent = 0
    const d = new NcDispatcher({
      ...baseDeps,
      send: async () => {
        sent += 1
        return { success: true }
      },
    })
    const res = await d.deliver(makeEntry({ media: 'none' }))
    expect(res.ok).toBe(true)
    expect(sent).toBe(1)
  })

  it('the target-level kill-switch is an independent benign skip (post-catalog, not a dead-letter)', async () => {
    // Both gates now short-circuit benignly but stay independent paths: the
    // per-rule opt-out skips BEFORE the catalog fetch; the global kill-switch
    // skips AFTER resolving the (disabled) target. Neither dead-letters.
    let sent = 0
    let listed = 0
    const d = new NcDispatcher({
      ...baseDeps,
      listTargets: async (): Promise<readonly NcTargetRef[]> => {
        listed += 1
        return [{ ...enabledTarget, enabled: false }]
      },
      send: async () => {
        sent += 1
        return { success: true }
      },
      isRuleTargetDisabled: async () => false,
    })
    const res = await d.deliver(makeEntry({ media: 'none' }))
    expect(res).toEqual({ ok: true })
    expect(sent).toBe(0)
    // Independent path proof: the catalog WAS resolved (unlike the opt-out gate
    // which returns before any listTargets call).
    expect(listed).toBe(1)
  })
})

// ── Artifact URLs (D8, 2026-07-30) ──────────────────────────────────────────
// Attachments used to carry BYTES only, and the degrade engine drops a
// bytes-only attachment for a `mode:'url'` target (`attachment:noUrl`) — so
// WhatsApp and gotify silently received no media at all. Emitting both lets
// each backend take what it can.
describe('NcDispatcher artifact urls', () => {
  it('attaches a signed url ALONGSIDE the bytes when the plane mints one', async () => {
    const h = makeHarness()
    const sends: NcSendInput[] = h.sends
    h.setMedia('object', 'ev-1', [
      { kind: 'keyFrame', base64: Buffer.from([1, 2, 3]).toString('base64'), mime: 'image/jpeg' },
    ] as never)
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      publishArtifact: async () =>
        'https://hub.lan:4443/addon/pipeline-analytics/nc-artifact/a?exp=1&sig=x',
    })
    await dispatcher.deliver(makeEntry())
    const att = sends[0]?.notification.attachments ?? []
    for (const a of att) expect(a.url).toContain('nc-artifact')
  })

  it('indexes still / gif / mp4 and names the still as the gif and clip poster', async () => {
    const indexed: Array<{ kind: string; posterArtifactId?: string }> = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () =>
        [
          {
            kind: 'keyFrame',
            base64: Buffer.from([1, 2, 3]).toString('base64'),
            mime: 'image/jpeg',
          },
        ] as never,
      getDeviceName: async () => null,
      now: () => 1_753_000_000_000 + 1_000,
      renderEventMedia: async () => ({
        mp4: new Uint8Array([9, 9, 9]),
        gif: new Uint8Array([8, 8, 8]),
        source: 'produced',
        startOffsetMs: -3000,
        endOffsetMs: 5000,
        profile: 'low',
        video: 'copy',
      }),
      indexArtifact: async (_bytes, _mime, meta) => {
        indexed.push({
          kind: meta.kind,
          ...(meta.posterArtifactId !== undefined
            ? { posterArtifactId: meta.posterArtifactId }
            : {}),
        })
        return { url: `https://hub/a/${meta.kind}`, artifactId: `id-${meta.kind}` }
      },
    })
    await dispatcher.deliver(makeEntry({ mediaGif: true, mediaClip: true, media: 'best' }))
    expect(indexed.map((r) => r.kind)).toEqual(['event-still', 'event-gif', 'event-clip'])
    expect(indexed[1]?.posterArtifactId).toBe('id-event-still')
    expect(indexed[2]?.posterArtifactId).toBe('id-event-still')
  })

  // History links a delivered row to its media through EXACTLY these ids
  // (D8, 2026-08-26): the outbox writes back whatever `deliver()` returns
  // here, unmodified, onto the row `getHistory` later reads.
  it('returns the indexed artifact ids, in delivery order, on a successful send', async () => {
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () =>
        [
          {
            kind: 'keyFrame',
            base64: Buffer.from([1, 2, 3]).toString('base64'),
            mime: 'image/jpeg',
          },
        ] as never,
      getDeviceName: async () => null,
      now: () => 1_753_000_000_000 + 1_000,
      renderEventMedia: async () => ({
        mp4: new Uint8Array([9, 9, 9]),
        gif: new Uint8Array([8, 8, 8]),
        source: 'produced',
        startOffsetMs: -3000,
        endOffsetMs: 5000,
        profile: 'low',
        video: 'copy',
      }),
      indexArtifact: async (_bytes, _mime, meta) => ({
        url: `https://hub/a/${meta.kind}`,
        artifactId: `id-${meta.kind}`,
      }),
    })
    const result = await dispatcher.deliver(
      makeEntry({ mediaGif: true, mediaClip: true, media: 'best' }),
    )
    expect(result).toMatchObject({
      ok: true,
      artifactIds: ['id-event-still', 'id-event-gif', 'id-event-clip'],
    })
  })

  it('carries no artifactIds field when nothing indexed (no plane wired)', async () => {
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    })
    const result = await dispatcher.deliver(makeEntry())
    expect(result.ok).toBe(true)
    expect(result).not.toHaveProperty('artifactIds')
  })

  it('ships bytes-only when the plane cannot mint (loopback-only host)', async () => {
    const sends: NcSendInput[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      publishArtifact: async () => null,
    })
    const result = await dispatcher.deliver(makeEntry())
    expect(result.ok).toBe(true)
    for (const a of sends[0]?.notification.attachments ?? []) expect(a.url).toBeUndefined()
  })
})

// ── The clip must contain its moment (operator, 2026-07-30) ────────────────
// Only FINALIZED segments are addressable and the open one runs ~13 s behind,
// so at fire time the footage around the event does not exist yet. Rendering
// from what IS available shows the seconds BEFORE the trigger — the approach,
// not the event. Deferring gives the notification a clip that actually contains
// what it announces.
describe('NcDispatcher — footage from the clip ring', () => {
  function makeDispatcher(overrides: Partial<NcDispatcherDeps> = {}) {
    const sends: NcSendInput[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      // The clock sits just after the subject instant: a cut is only attempted
      // for a window the broker's ring can still hold (see
      // NC_CLIP_RING_RETENTION_SEC), and these entries are frozen in 2025.
      now: () => 1_753_000_000_000 + 1_000,
      ...overrides,
    })
    return { dispatcher, sends }
  }

  const oneByte = (): Uint8Array => Uint8Array.from([1])

  // Nothing to wait for: the ring only grows FORWARD, so a window it does not
  // already cover will never be covered by retrying — and retrying would age
  // the pre-roll out of it. An alarm must not be held hostage to that.
  it('a failed cut never blocks the send — the still goes out at once', async () => {
    const { dispatcher, sends } = makeDispatcher({
      renderEventMedia: async () => {
        throw new Error('clip buffer does not cover 2026-07-30T00:00:00.000Z')
      },
    })
    const result = await dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(result.ok).toBe(true)
    expect(sends).toHaveLength(1)
    expect(sends[0]?.notification.attachments ?? []).toHaveLength(0)
  })

  // The load-bearing one. Two renders is what shipped a gif around a doorbell
  // press beside a video of the six seconds after it: the dispatcher must not
  // be ABLE to ask twice.
  it('asks ONCE for both containers when the rule wants a gif and a clip', async () => {
    let calls = 0
    let seen: { wantGif: boolean; wantMp4: boolean } | null = null
    const { dispatcher, sends } = makeDispatcher({
      renderEventMedia: async (req: NcEventMediaRequest) => {
        calls += 1
        seen = { wantGif: req.wantGif, wantMp4: req.wantMp4 }
        return { gif: oneByte(), mp4: oneByte() }
      },
    })
    await dispatcher.deliver(makeEntry({ mediaGif: true, mediaClip: true }))
    expect(calls).toBe(1)
    expect(seen).toEqual({ wantGif: true, wantMp4: true })
    const attachments = sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['gif', 'video'])
    expect(attachments.map((a) => a.mime)).toEqual(['image/gif', 'video/mp4'])
  })

  it('attaches only what the cut produced — a missing gif is not a failed send', async () => {
    const { dispatcher, sends } = makeDispatcher({
      renderEventMedia: async () => ({ gif: null, mp4: oneByte() }),
    })
    const result = await dispatcher.deliver(makeEntry({ mediaGif: true, mediaClip: true }))
    expect(result.ok).toBe(true)
    expect((sends[0]?.notification.attachments ?? []).map((a) => a.mediaType)).toEqual(['video'])
  })

  it("forwards the rule's rolls and profile, and CENTRES on the subject instant", async () => {
    let seen: NcEventMediaRequest | null = null
    const { dispatcher } = makeDispatcher({
      renderEventMedia: async (req: NcEventMediaRequest) => {
        seen = req
        return { gif: null, mp4: oneByte() }
      },
    })
    const base = makeEntry()
    await dispatcher.deliver(
      makeEntry({
        mediaClip: true,
        mediaClipPreRollSec: 6,
        mediaClipPostRollSec: 9,
        mediaProfile: 'mid',
      }),
    )
    const captured = defined<NcEventMediaRequest>(seen, 'renderEventMedia request')
    expect(captured.aroundMs).toBe(base.payload.subject.timestamp)
    expect(captured.preRollSec).toBe(6)
    expect(captured.postRollSec).toBe(9)
    expect(captured.profile).toBe('mid')
  })

  // The clip window a rule that stores NO roll gets (D654): 4 s before the
  // moment, 6 s after. Literal numbers on purpose — asserting the constant
  // against itself could not notice the default moving.
  it('an absent roll resolves to 4 s before and 6 s after the moment', async () => {
    let seen: Pick<NcEventMediaRequest, 'preRollSec' | 'postRollSec'> | null = null
    const { dispatcher } = makeDispatcher({
      renderEventMedia: async (req: NcEventMediaRequest) => {
        seen = { preRollSec: req.preRollSec, postRollSec: req.postRollSec }
        return { gif: oneByte(), mp4: null }
      },
    })
    await dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(seen).toEqual({ preRollSec: 4, postRollSec: 6 })
  })

  it('a stored roll survives verbatim — including 0, which is not "absent"', async () => {
    let seen: Pick<NcEventMediaRequest, 'preRollSec' | 'postRollSec'> | null = null
    const { dispatcher } = makeDispatcher({
      renderEventMedia: async (req: NcEventMediaRequest) => {
        seen = { preRollSec: req.preRollSec, postRollSec: req.postRollSec }
        return { gif: oneByte(), mp4: null }
      },
    })
    await dispatcher.deliver(
      makeEntry({ mediaGif: true, mediaClipPreRollSec: 0, mediaClipPostRollSec: 3 }),
    )
    expect(seen).toEqual({ preRollSec: 0, postRollSec: 3 })
  })

  it('the default is the ONE published in @camstack/types, which the viewer reads too', () => {
    // A second copy is how the viewer came to DISPLAY 3/7 while the hub cut
    // 4/6 — and prune a typed 3 back to "absent", which the hub then read as 4.
    expect(NC_CLIP_PRE_ROLL_DEFAULT_SEC).toBe(4)
    expect(NC_CLIP_POST_ROLL_DEFAULT_SEC).toBe(6)
  })

  // Absent means "the broker's own preferred rendition" — a decision only it can
  // make, since only it knows which profiles the camera actually has.
  it('omits the profile entirely when the rule did not choose one', async () => {
    let seen: NcEventMediaRequest | null = null
    const { dispatcher } = makeDispatcher({
      renderEventMedia: async (req: NcEventMediaRequest) => {
        seen = req
        return { gif: oneByte(), mp4: null }
      },
    })
    await dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(seen).not.toBeNull()
    expect(seen && 'profile' in seen).toBe(false)
  })

  it('does not cut at all when the rule asked for no footage', async () => {
    let calls = 0
    const { dispatcher } = makeDispatcher({
      renderEventMedia: async () => {
        calls += 1
        return { gif: oneByte(), mp4: oneByte() }
      },
    })
    await dispatcher.deliver(makeEntry({}))
    expect(calls).toBe(0)
  })
})

/**
 * The target cache, published as ANSWERS for the deleted-target prune: it
 * consumes catalogs the delivery path already paid for and never reads one of
 * its own. Only a successful, non-empty refresh is an answer, each gets its own
 * generation, and a stale cache answers nothing (D633 fix round 1).
 */
describe('NcDispatcher.catalogSnapshot', () => {
  it('is null before any refresh, then carries each refresh as a new generation', async () => {
    let now = 1_000
    let listCalls = 0
    const target: NcTargetRef = {
      id: 'tgt-1',
      addonId: 'notifiers',
      name: 'phone',
      kind: 'ntfy',
      enabled: true,
    }
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => {
        listCalls += 1
        return [target]
      },
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      now: () => now,
      targetCacheTtlMs: 60_000,
    })
    expect(dispatcher.catalogSnapshot()).toBeNull()
    await dispatcher.deliver(makeEntry({ media: 'none' }))
    expect(dispatcher.catalogSnapshot()).toMatchObject({ generation: 1, targets: [target] })
    now += 61_000
    // Stale: no answer — and asking for one reads nothing.
    expect(dispatcher.catalogSnapshot()).toBeNull()
    expect(listCalls).toBe(1)
    await dispatcher.deliver(makeEntry({ media: 'none' }))
    expect(dispatcher.catalogSnapshot()?.generation).toBe(2)
  })

  it('an EMPTY catalog is never published as an answer', async () => {
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    })
    await dispatcher.deliver(makeEntry({ media: 'none' })).catch(() => undefined)
    expect(dispatcher.catalogSnapshot()).toBeNull()
  })
})
