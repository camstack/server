/**
 * Where the ordinary rules' AI narration sits in the dispatcher.
 *
 * Three things are pinned here and nowhere else:
 *
 *  - the two detection paths get DIFFERENT INPUTS. An `immediate` row is one
 *    moment and gets the very frame it is about to ship (the confirm gate's
 *    rule, D52); a `track-end` row is a passage that has closed and gets the
 *    passage — several whole-scene frames spanning it, oldest first. Handing
 *    the track path one still would ask "what happened" of one instant.
 *  - the WORD CAP default follows the delivery TARGET, resolved at send time
 *    because one row fans out to targets with different budgets.
 *  - ZERO frames skip the pass: the analyst is never called at all, so a
 *    text-only notification cannot be described by a model that saw nothing.
 *
 * And the neutralisation: a row with no `ai` policy must reach `send` having
 * never touched the analyst, with a body byte-for-byte what it was before.
 */
import type { MediaFile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcRuleAiInput, NcRuleAiOutcome } from '../rule-ai-analyst.js'

const STILL = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]).toString('base64')

/** A track's stored media: the passage's beginning, its best-seen moment, its
 *  end — plus a crop, which a "what happened" question must not be answered
 *  from. */
const TRACK_MEDIA: readonly MediaFile[] = [
  { mediaId: 8000, kind: 'firstFrame', base64: STILL, sizeBytes: 7, timestamp: 1_000 },
  { mediaId: 8001, kind: 'keyFrame', base64: STILL, sizeBytes: 7, timestamp: 5_000 },
  { mediaId: 8002, kind: 'snapshot', base64: STILL, sizeBytes: 7, timestamp: 7_000 },
  { mediaId: 8003, kind: 'lastFrame', base64: STILL, sizeBytes: 7, timestamp: 9_000 },
  { mediaId: 8004, kind: 'crop', base64: STILL, sizeBytes: 7, timestamp: 5_000 },
] as MediaFile[]

const ONE_STILL: readonly MediaFile[] = [
  { mediaId: 8004, kind: 'keyFrame', base64: STILL, sizeBytes: 7, timestamp: 1_753_000_000_000 },
] as MediaFile[]

function makeEntry(payload: Partial<NcOutboxPayload> = {}): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 102,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Parking',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      subject: {
        deviceId: 102,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'vehicle',
        zones: [],
        timestamp: 1_753_000_000_000,
      },
      ...payload,
    },
  }
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly aiCalls: NcRuleAiInput[]
}

interface HarnessOptions {
  readonly media?: readonly MediaFile[]
  readonly target?: NcTargetRef
  readonly text?: string | null
  readonly getDeviceLocation?: (deviceId: number) => Promise<string | null>
}

const NTFY: NcTargetRef = {
  id: 'tgt-1',
  addonId: 'notifiers',
  name: 'phone',
  kind: 'ntfy',
  enabled: true,
  bodyMaxLen: 4_096,
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const sends: NcSendInput[] = []
  const aiCalls: NcRuleAiInput[] = []
  const media = options.media ?? ONE_STILL
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    listTargets: async () => [options.target ?? NTFY],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => media,
    getDeviceName: async () => 'Parking',
    ...(options.getDeviceLocation !== undefined
      ? { getDeviceLocation: options.getDeviceLocation }
      : {}),
    now: () => 1_753_000_001_000,
    sleep: async () => undefined,
    ruleAi: async (input: NcRuleAiInput): Promise<NcRuleAiOutcome> => {
      aiCalls.push(input)
      const text = options.text === undefined ? 'A white van is parked in the bay.' : options.text
      return { text, latencyMs: 900, images: input.frames.length }
    },
    ruleAiStats: () => ({ described: 1, failedOpen: 0, refuted: 0 }),
  })
  return { dispatcher, sends, aiCalls }
}

describe('NcDispatcher — the AI narration pass', () => {
  it('is never consulted for a row that carries no ai policy', async () => {
    const h = makeHarness()
    const before = await h.dispatcher.deliver(makeEntry())
    expect(before).toEqual({ ok: true })
    expect(h.aiCalls).toHaveLength(0)
    const plainBody = h.sends[0]?.notification.body
    // …and the body is exactly what a row WITH a policy but no sentence gets.
    const h2 = makeHarness({ text: null })
    await h2.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
    expect(h2.sends[0]?.notification.body).toBe(plainBody)
  })

  it('appends the sentence BELOW the detection line, on its own line', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
    const body = h.sends[0]?.notification.body ?? ''
    expect(body.endsWith('\nA white van is parked in the bay.')).toBe(true)
    // The fact the notification is ABOUT still leads — a lock screen cuts from
    // the end.
    expect(body.split('\n')[0]).not.toContain('white van')
  })

  it('leaves a template that PLACES {{ai}} exactly where the operator put it', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(
      makeEntry({
        ai: { shape: 'detection-immediate' },
        template: { body: '[{{ai}}] on {{camera}}' },
      }),
    )
    expect(h.sends[0]?.notification.body).toBe('[A white van is parked in the bay.] on parking')
  })

  describe('the two detection paths get different inputs', () => {
    it('gives an IMMEDIATE row the one frame it is about to ship', async () => {
      const h = makeHarness()
      await h.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      expect(h.aiCalls).toHaveLength(1)
      const call = h.aiCalls[0]
      expect(call?.frames).toHaveLength(1)
      expect(call?.policy.shape).toBe('detection-immediate')
      // The very bytes the recipient will see (D52) — never a second ladder.
      const shipped = h.sends[0]?.notification.attachments?.[0]?.bytes
      expect(call?.frames[0]?.bytes).toEqual(shipped)
    })

    it('gives a TRACK-CLOSE row the passage — several scenes, oldest first', async () => {
      const h = makeHarness({ media: TRACK_MEDIA })
      await h.dispatcher.deliver(
        makeEntry({
          delivery: 'track-end',
          ai: { shape: 'detection-track' },
        }),
      )
      const call = h.aiCalls[0]
      expect(call?.policy.shape).toBe('detection-track')
      expect(call?.frames).toHaveLength(3)
      const times = call?.frames.map((f) => f.atMs) ?? []
      expect(times).toEqual([...times].toSorted((a, b) => (a ?? 0) - (b ?? 0)))
      // It SPANS the track: the first and the last stored scene are both in.
      expect(times[0]).toBe(1_000)
      expect(times.at(-1)).toBe(9_000)
    })

    it('and the two therefore differ — a track answer is not one still', async () => {
      const immediate = makeHarness({ media: TRACK_MEDIA })
      await immediate.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      const track = makeHarness({ media: TRACK_MEDIA })
      await track.dispatcher.deliver(
        makeEntry({ delivery: 'track-end', ai: { shape: 'detection-track' } }),
      )
      expect(immediate.aiCalls[0]?.frames.length).toBe(1)
      expect(track.aiCalls[0]?.frames.length).toBe(3)
      expect(immediate.aiCalls[0]?.policy.shape).not.toBe(track.aiCalls[0]?.policy.shape)
    })
  })

  describe('the camera location reaches the analyst', () => {
    it('threads the operator s location label into the AI input', async () => {
      const asked: number[] = []
      const h = makeHarness({
        getDeviceLocation: async (deviceId) => {
          asked.push(deviceId)
          return 'Garden'
        },
      })
      await h.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      expect(h.aiCalls[0]?.location).toBe('Garden')
      expect(asked).toEqual([102])
    })

    it('a camera with NO location, a throwing port and no port at all are the same: absent', async () => {
      const nullPort = makeHarness({ getDeviceLocation: async () => null })
      await nullPort.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      expect(nullPort.aiCalls[0]?.location).toBeUndefined()

      const throwing = makeHarness({
        getDeviceLocation: async () => {
          throw new Error('device manager unreachable')
        },
      })
      await throwing.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      // A failed read costs the label, never the sentence or the notification.
      expect(throwing.aiCalls).toHaveLength(1)
      expect(throwing.aiCalls[0]?.location).toBeUndefined()
      expect(throwing.sends).toHaveLength(1)

      const unwired = makeHarness()
      await unwired.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      expect(unwired.aiCalls[0]?.location).toBeUndefined()
    })
  })

  describe('the word cap default follows the target', () => {
    it('gives a push target few words and a webhook many', async () => {
      const push = makeHarness({ target: { ...NTFY, kind: 'zentik', bodyMaxLen: 1_000_000 } })
      await push.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      const hook = makeHarness({
        target: { ...NTFY, kind: 'webhook', bodyMaxLen: 1_000_000 },
      })
      await hook.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      expect(push.aiCalls[0]?.maxWords).toBe(120)
      expect(hook.aiCalls[0]?.maxWords).toBe(120)
    })

    it('yields to the number the operator wrote on the rule', async () => {
      const h = makeHarness({ target: { ...NTFY, kind: 'webhook', bodyMaxLen: 1_000_000 } })
      await h.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate', maxWords: 15 } }))
      expect(h.aiCalls[0]?.maxWords).toBe(15)
    })

    it('falls back to a push shape when the kind catalog said nothing', async () => {
      const h = makeHarness({ target: { ...NTFY, bodyMaxLen: undefined } })
      await h.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
      expect(h.aiCalls[0]?.maxWords).toBe(24)
    })
  })

  it('SKIPS the pass entirely when the notification ships text-only', async () => {
    const h = makeHarness({ media: [] })
    const result = await h.dispatcher.deliver(makeEntry({ ai: { shape: 'detection-immediate' } }))
    expect(result).toEqual({ ok: true })
    expect(h.aiCalls).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.attachments).toBeUndefined()
  })

  it('SKIPS a track-close row whose track owns no media at all', async () => {
    const h = makeHarness({ media: [] })
    await h.dispatcher.deliver(
      makeEntry({ delivery: 'track-end', ai: { shape: 'detection-track' } }),
    )
    expect(h.aiCalls).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
  })
})
