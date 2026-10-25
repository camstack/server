/**
 * D692 Task 11 — the dispatcher READS a grouped row through the one reader, says it with the
 * moved composer, anchors its footage on the window's opening, and sends NO tag.
 *
 * The harness is the one of `dispatcher-texts.spec.ts` and `recorded-footage-one-shot.spec.ts`
 * (copied, not imported).
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  NC_RECORDED_FOOTAGE_WAIT_MS,
  NcDispatcher,
  type NcSendInput,
  type NcTargetRef,
} from '../dispatcher.js'
import type { NcOutboxGroupLegacy, NcOutboxGroupV2 } from '../grouped/grouped-payload.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcRecordedClipRequest } from '../recorded-clip.js'
import { NcTextCatalog } from '../text-catalog.js'

const DEVICE = 104
const SEC = 1_000
/** The instant the window CLOSED — what `subject.timestamp` carries on a v2 row. */
const CLOSED_AT = 1_786_185_854_852
const OPENED_AT = CLOSED_AT - 6 * SEC

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
]

function groupV2(overrides: Partial<NcOutboxGroupV2> = {}): NcOutboxGroupV2 {
  return {
    version: 2,
    key: 'grp:rule-1:104:trk-1@1',
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT,
    closeReason: 'all-final',
    members: [
      {
        trackId: 'trk-1',
        className: 'person',
        label: 'Person A',
        labelKind: 'identity',
        triggerAt: OPENED_AT,
      },
      { trackId: 'trk-2', className: 'person', triggerAt: OPENED_AT + 2 * SEC },
    ],
    ...overrides,
  }
}

function makeEntry(
  payload: Partial<NcOutboxPayload> = {},
  overrides: Partial<NcOutboxEntry> = {},
): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: DEVICE,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: CLOSED_AT,
    updatedAt: CLOSED_AT,
    payload: {
      ruleName: 'Persone',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: DEVICE,
        eventId: 'ev-1',
        trackId: 'trk-1',
        className: 'person',
        zones: [],
        timestamp: CLOSED_AT,
      },
      ...payload,
    },
    ...overrides,
  }
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly ringCuts: number[]
  readonly recordedAsks: NcRecordedClipRequest[]
}

function makeHarness(
  opts: { readonly texts?: NcTextCatalog; readonly now?: number } = {},
): Harness {
  const sends: NcSendInput[] = []
  const ringCuts: number[] = []
  const recordedAsks: NcRecordedClipRequest[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    ...(opts.texts !== undefined ? { texts: opts.texts } : {}),
    listTargets: async () => TARGETS,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Front door',
    renderEventMedia: async (req) => {
      ringCuts.push(req.aroundMs)
      return { gif: Uint8Array.from([1, 2, 3]), mp4: null }
    },
    cutRecordedClip: async (req) => {
      recordedAsks.push(req)
      return { ok: true, mp4: Uint8Array.from([7, 7, 7]), profile: 'low' }
    },
    now: () => opts.now ?? CLOSED_AT + 2 * SEC,
  })
  return { dispatcher, sends, ringCuts, recordedAsks }
}

async function deliver(h: Harness, entry: NcOutboxEntry): Promise<NcSendInput> {
  await h.dispatcher.deliver(entry)
  const sent = h.sends.at(-1)
  if (sent === undefined) throw new Error('nothing was sent')
  return sent
}

describe('a v2 grouped row speaks for its members (§6.4)', () => {
  it('names the recognised member and counts the rest, in Italian', async () => {
    const h = makeHarness({ texts: new NcTextCatalog({ language: 'it' }) })
    const sent = await deliver(h, makeEntry({ group: groupV2() }))
    expect(sent.notification.body).toContain('Person A e 1 altra persona')
  })

  it('{{count}} is the number of members', async () => {
    const h = makeHarness({ texts: new NcTextCatalog({ language: 'it' }) })
    const sent = await deliver(
      h,
      makeEntry({ group: groupV2(), template: { body: '{{count}} soggetti: {{subject}}' } }),
    )
    expect(sent.notification.body).toBe('2 soggetti: Person A e 1 altra persona')
  })

  it('{{detectionSummary}} is the class composition of the members', async () => {
    const h = makeHarness({ texts: new NcTextCatalog({ language: 'it' }) })
    const sent = await deliver(
      h,
      makeEntry({ group: groupV2(), template: { body: '{{detectionSummary}}' } }),
    )
    expect(sent.notification.body).toBe('2 persone')
  })

  it('a ONE-member v2 row renders byte-identically to the same row without a group', async () => {
    const member = {
      trackId: 'trk-1',
      className: 'person',
      label: 'Person A',
      labelKind: 'identity' as const,
      triggerAt: OPENED_AT,
    }
    const subject = {
      deviceId: DEVICE,
      eventId: 'ev-1',
      trackId: 'trk-1',
      className: 'person',
      label: 'Person A',
      labelKind: 'identity' as const,
      zones: [],
      timestamp: CLOSED_AT,
    }
    const grouped = await deliver(
      makeHarness({ texts: new NcTextCatalog({ language: 'it' }) }),
      makeEntry({ subject, group: groupV2({ members: [member] }) }),
    )
    const plain = await deliver(
      makeHarness({ texts: new NcTextCatalog({ language: 'it' }) }),
      makeEntry({ subject }),
    )
    // Everything the send carries except the per-row identity (`eventId`).
    const strip = (s: NcSendInput): unknown => {
      const { eventId: _eventId, ...rest } = s.notification
      return { ...s, notification: rest }
    }
    expect(strip(grouped)).toEqual(strip(plain))
  })

  it('a LEGACY D143 row with two members still renders the group sentence (tolerant reader)', async () => {
    const legacy: NcOutboxGroupLegacy = {
      key: 'grp:rule-1:104:1',
      revision: 2,
      anchorTrackId: 'trk-1',
      members: [
        { trackId: 'trk-1', className: 'person', label: 'Person A', labelKind: 'identity', at: 1 },
        { trackId: 'trk-2', className: 'person', at: 2 },
      ],
    }
    const h = makeHarness({ texts: new NcTextCatalog({ language: 'it' }) })
    const sent = await deliver(h, makeEntry({ group: legacy }))
    expect(sent.notification.body).toContain('Person A e 1 altra persona')
  })
})

describe('the footage is cut around the window OPENING (§6.3)', () => {
  const gifRule = { mediaGif: true } as const

  it('a v2 row anchors the ring cut on group.openedAt, not subject.timestamp', async () => {
    const h = makeHarness()
    await deliver(h, makeEntry({ ...gifRule, group: groupV2() }))
    expect(h.ringCuts).toEqual([OPENED_AT])
  })

  it('a row without a group (and a legacy row) keeps the subject anchor', async () => {
    const h = makeHarness()
    await deliver(h, makeEntry({ ...gifRule }))
    expect(h.ringCuts).toEqual([CLOSED_AT])
    const legacy: NcOutboxGroupLegacy = {
      key: 'k',
      revision: 1,
      anchorTrackId: 'trk-1',
      members: [
        { trackId: 'trk-1', className: 'person', at: 1 },
        { trackId: 'trk-2', className: 'person', at: 2 },
      ],
    }
    const h2 = makeHarness()
    await deliver(h2, makeEntry({ ...gifRule, group: legacy }))
    expect(h2.ringCuts).toEqual([CLOSED_AT])
  })

  it('an opening older than the ring takes the RECORDINGS path in the one message', async () => {
    // The window opened 12 minutes before it is sent: far outside the ring's retention.
    const now = CLOSED_AT + 12 * 60 * SEC
    const h = makeHarness({ now })
    const sent = await deliver(
      h,
      makeEntry({ mediaClip: true, group: groupV2({ openedAt: CLOSED_AT - 12 * 60 * SEC }) }),
    )
    expect(h.sends).toHaveLength(1)
    expect(h.ringCuts).toHaveLength(0)
    expect(h.recordedAsks).toHaveLength(1)
    expect(h.recordedAsks[0]?.aroundMs).toBe(CLOSED_AT - 12 * 60 * SEC)
    expect(h.recordedAsks[0]?.deadlineMs).toBe(now + NC_RECORDED_FOOTAGE_WAIT_MS)
    expect(sent.notification.attachments?.map((a) => a.mediaType)).toEqual(['video'])
  })
})
