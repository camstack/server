/**
 * The dispatcher's AI CONFIRM gate.
 *
 * Where it sits is the whole design, and these pin it there:
 *  - AFTER the attachments resolve, so the crop JUDGED is the crop SHIPPED
 *    (D52). A verdict about a different rectangle is not a verdict about this
 *    notification;
 *  - and a suppression is BENIGN like a snooze — no send, no dead-letter — but
 *    unlike a snooze it RELEASES the cooldown window this fire consumed, so the
 *    next subject is not swallowed by a window opened for one the model
 *    rejected.
 *
 * A rule with no `confirm` on its row must reach `send` having never touched
 * the gate: that is the neutralisation these tests exist to keep honest.
 */
import { describe, expect, it } from 'vitest'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  type NcConfirmGateInput,
  NcDispatcher,
  type NcCooldownRelease,
  type NcSendInput,
} from '../dispatcher.js'
import type { NcOutboxConfirmVerdict, NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

const STILL = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]).toString('base64')

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
  readonly gateCalls: NcConfirmGateInput[]
  readonly releases: NcCooldownRelease[]
}

function makeHarness(verdict: NcOutboxConfirmVerdict | null, hasMedia = true): Harness {
  const sends: NcSendInput[] = []
  const gateCalls: NcConfirmGateInput[] = []
  const releases: NcCooldownRelease[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    listTargets: async () => [
      { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () =>
      hasMedia
        ? [makeTestMediaFile({ kind: 'keyFrame', base64: STILL, sizeBytes: 7, timestamp: 1 })]
        : [],
    getDeviceName: async () => 'Parking',
    now: () => 1_753_000_001_000,
    sleep: async () => undefined,
    ...(verdict !== null
      ? {
          confirmGate: async (input: NcConfirmGateInput): Promise<NcOutboxConfirmVerdict> => {
            gateCalls.push(input)
            return verdict
          },
        }
      : {}),
    releaseCooldown: (input) => {
      releases.push(input)
    },
    confirmStats: () => ({ confirmed: 3, suppressed: 1, failedOpen: 0 }),
  })
  return { dispatcher, sends, gateCalls, releases }
}

const CONFIRMED: NcOutboxConfirmVerdict = {
  decision: 'confirmed',
  reason: 'one car parked in the bay',
  count: 1,
  model: 'qwen/qwen3-vl-8b',
  latencyMs: 4900,
  at: 1_753_000_001_000,
}
const SUPPRESSED: NcOutboxConfirmVerdict = {
  decision: 'suppressed',
  reason: 'the bay is empty',
  count: 0,
  model: 'qwen/qwen3-vl-8b',
  latencyMs: 4400,
  at: 1_753_000_001_000,
}
const FAILED_OPEN: NcOutboxConfirmVerdict = {
  decision: 'failed-open',
  reason: 'no verdict within 8000ms',
  failOpen: 'timeout',
  latencyMs: 8000,
  at: 1_753_000_001_000,
}

describe('NcDispatcher — the AI confirm gate', () => {
  it('is never consulted for a row that carries no confirm policy', async () => {
    const h = makeHarness(CONFIRMED)
    const result = await h.dispatcher.deliver(makeEntry())
    expect(h.gateCalls).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    expect(result).toEqual({ ok: true })
  })

  it('judges the very bytes it is about to ship', async () => {
    const h = makeHarness(CONFIRMED)
    await h.dispatcher.deliver(makeEntry({ confirm: {} }))
    expect(h.gateCalls).toHaveLength(1)
    const shipped = h.sends[0]?.notification.attachments?.find((a) => a.mediaType === 'image')
    expect(shipped).toBeDefined()
    expect(h.gateCalls[0]?.image?.bytes).toEqual(shipped?.bytes)
  })

  it('passes the frozen policy and the subject through to the gate', async () => {
    const h = makeHarness(CONFIRMED)
    await h.dispatcher.deliver(
      makeEntry({ confirm: { expect: { op: '>=', count: 1 }, profileId: 'p1' } }),
    )
    expect(h.gateCalls[0]).toMatchObject({
      ruleId: 'rule-1',
      ruleName: 'Parking',
      deviceId: 102,
      recordId: 'ev-1',
      className: 'vehicle',
      confirm: { expect: { op: '>=', count: 1 }, profileId: 'p1' },
    })
  })

  it('delivers on a confirmed verdict and records it on the row', async () => {
    const h = makeHarness(CONFIRMED)
    const result = await h.dispatcher.deliver(makeEntry({ confirm: {} }))
    expect(h.sends).toHaveLength(1)
    expect(result).toEqual({ ok: true, confirm: CONFIRMED })
  })

  it('suppresses BENIGNLY on a negative verdict — no send, no dead-letter', async () => {
    const h = makeHarness(SUPPRESSED)
    const result = await h.dispatcher.deliver(makeEntry({ confirm: {} }))
    expect(h.sends).toHaveLength(0)
    expect(result).toEqual({ ok: true, confirm: SUPPRESSED })
  })

  it('releases the cooldown a suppressed fire consumed', async () => {
    const h = makeHarness(SUPPRESSED)
    await h.dispatcher.deliver(
      makeEntry({ confirm: {}, cooldown: { key: 'rule-1|102', at: 1_753_000_000_500 } }),
    )
    expect(h.releases).toEqual([
      {
        key: 'rule-1|102',
        at: 1_753_000_000_500,
        ruleId: 'rule-1',
        deviceId: 102,
      },
    ])
  })

  it('never releases the cooldown for a delivery that WENT OUT', async () => {
    const h = makeHarness(CONFIRMED)
    await h.dispatcher.deliver(
      makeEntry({ confirm: {}, cooldown: { key: 'rule-1|102', at: 1_753_000_000_500 } }),
    )
    expect(h.releases).toHaveLength(0)
  })

  it('DELIVERS on a failed-open verdict — a mute model never silences a camera', async () => {
    const h = makeHarness(FAILED_OPEN)
    const result = await h.dispatcher.deliver(makeEntry({ confirm: {} }))
    expect(h.sends).toHaveLength(1)
    expect(result).toEqual({ ok: true, confirm: FAILED_OPEN })
  })

  it('still asks when there is no picture — the gate owns that decision', async () => {
    // The dispatcher must not pre-empt the policy by skipping the gate: whether
    // "no image" means fire or suppress is `onTimeout`'s business, not the
    // dispatcher's, and the row must still record that it happened.
    const h = makeHarness(FAILED_OPEN, false)
    await h.dispatcher.deliver(makeEntry({ confirm: {} }))
    expect(h.gateCalls).toHaveLength(1)
    expect(h.gateCalls[0]?.image).toBeNull()
  })
})
