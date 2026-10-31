/**
 * The dispatcher's snooze gate.
 *
 * The gate has to sit in a very specific place, and these pin it there:
 *  - AFTER the target resolves, because a personal window silences a person and
 *    only the target knows whose delivery this is;
 *  - BEFORE the notification is built, because a silenced notification must not
 *    cost a clip render — the expensive half of a send;
 *  - and a suppression is BENIGN, never a dead-letter: the operator asked for
 *    this silence and it ends by itself.
 *
 * Plus the digest path, which reuses the same target catalog so a summary can
 * never reach a destination the snooze never touched.
 */
import type { NcSnooze } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  NcDispatcher,
  type NcSendInput,
  type NcSnoozeGateInput,
  type NcTargetRef,
} from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'
import { activeSnoozeFor } from '../snooze-policy.js'
import { snoozeCoverage, snoozeVerdict } from '../snooze-verdict.js'

function makeEntry(overrides: Partial<NcOutboxEntry> = {}): NcOutboxEntry {
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
      subject: {
        deviceId: 101,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        zones: [],
        timestamp: 1_753_000_000_000,
      },
    },
    ...overrides,
  }
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly gateCalls: NcSnoozeGateInput[]
  readonly mediaCalls: { count: number }
}

function makeHarness(opts: {
  readonly snoozeId?: string | null
  readonly targets?: readonly NcTargetRef[]
  readonly sendFails?: boolean
}): Harness {
  const sends: NcSendInput[] = []
  const gateCalls: NcSnoozeGateInput[] = []
  const mediaCalls = { count: 0 }
  const targets = opts.targets ?? [
    {
      id: 'tgt-1',
      addonId: 'notifiers',
      name: 'alice-phone',
      kind: 'ntfy',
      enabled: true,
      ownerUserId: 'alice',
    },
  ]
  const dispatcher = new NcDispatcher({
    // The bounded still poll (NC_STILL_WAIT_MS) paces itself through this seam; a real
    // 3 s per text-only delivery was this file's whole runtime.
    sleep: async () => {},
    logger: makeSilentLogger(),
    listTargets: async () => targets,
    send: async (input) => {
      sends.push(input)
      return opts.sendFails === true ? { success: false, error: 'nope' } : { success: true }
    },
    getMediaForOwner: async () => {
      mediaCalls.count += 1
      return []
    },
    getDeviceName: async (deviceId) => (deviceId === 101 ? 'Cancello' : null),
    now: () => 1_800_000_000_000,
    snoozeGate: async (input) => {
      gateCalls.push(input)
      return opts.snoozeId ?? null
    },
  })
  return { dispatcher, sends, gateCalls, mediaCalls }
}

describe('NcDispatcher — the snooze gate', () => {
  it('suppresses the send BENIGNLY: no RPC, no dead-letter', async () => {
    const h = makeHarness({ snoozeId: 'snooze-1' })
    const result = await h.dispatcher.deliver(makeEntry())
    expect(result).toEqual({ ok: true })
    expect(h.sends).toHaveLength(0)
  })

  it('does not pay for media it will not send', async () => {
    // The whole point of gating before `buildNotification`: a snoozed camera
    // must not keep rendering clips nobody will receive.
    const h = makeHarness({ snoozeId: 'snooze-1' })
    await h.dispatcher.deliver(makeEntry())
    expect(h.mediaCalls.count).toBe(0)
  })

  it('asks about the RECIPIENT — the target owner, not the rule author', async () => {
    const h = makeHarness({ snoozeId: null })
    await h.dispatcher.deliver(makeEntry())
    expect(h.gateCalls).toHaveLength(1)
    expect(h.gateCalls[0]).toMatchObject({
      ruleId: 'rule-1',
      ruleName: 'Person at gate',
      targetId: 'tgt-1',
      deviceId: 101,
      ownerUserId: 'alice',
    })
  })

  it('omits the owner for a target nobody owns, so a PERSONAL window cannot match it', async () => {
    const h = makeHarness({
      snoozeId: null,
      targets: [
        { id: 'tgt-1', addonId: 'notifiers', name: 'household', kind: 'ntfy', enabled: true },
      ],
    })
    await h.dispatcher.deliver(makeEntry())
    const [call] = h.gateCalls
    if (call === undefined) throw new Error('the gate was never asked')
    expect(call.ownerUserId).toBeUndefined()
  })

  it('delivers normally when nothing is snoozed', async () => {
    const h = makeHarness({ snoozeId: null })
    const result = await h.dispatcher.deliver(makeEntry())
    expect(result).toEqual({ ok: true })
    expect(h.sends).toHaveLength(1)
  })

  it('is never consulted for a target that is gone — that is still a dead-letter', async () => {
    const h = makeHarness({ snoozeId: 'snooze-1' })
    const result = await h.dispatcher.deliver(makeEntry({ targetId: 'ghost' }))
    expect(result.ok).toBe(false)
    expect(h.gateCalls).toHaveLength(0)
  })

  it('an unwired gate changes nothing (an older wiring simply has no snoozes)', async () => {
    const dispatcher = new NcDispatcher({
      // The bounded still poll (NC_STILL_WAIT_MS) paces itself through this seam; a real
      // 3 s per text-only delivery was this file's whole runtime.
      sleep: async () => {},
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    })
    expect(await dispatcher.deliver(makeEntry())).toEqual({ ok: true })
  })
})

describe('NcDispatcher — digest delivery', () => {
  const digest = {
    snoozeId: 'snooze-1',
    targetId: 'tgt-1',
    title: 'Snooze ended — 3 notifications hidden',
    body: 'body',
    total: 3,
  }

  it('sends the summary to the target that was silenced, with no media and no tag', async () => {
    const h = makeHarness({})
    expect(await h.dispatcher.deliverDigest(digest)).toBe(true)
    expect(h.sends).toHaveLength(1)
    const [sent] = h.sends
    if (sent === undefined) throw new Error('nothing was sent')
    expect(sent.notification.attachments).toBeUndefined()
    // A digest tagged with a rule id would be collapsed by a phone into the very
    // notifications it is reporting on.
    expect(sent.notification.tag).toBeUndefined()
    expect(sent.notification.title).toContain('3 notifications hidden')
  })

  it('reports a failure instead of throwing — the caller still marks it handled', async () => {
    const h = makeHarness({ sendFails: true })
    expect(await h.dispatcher.deliverDigest(digest)).toBe(false)
  })

  it('reports false when the target vanished while the window was open', async () => {
    const h = makeHarness({ targets: [] })
    expect(await h.dispatcher.deliverDigest(digest)).toBe(false)
  })
})

/**
 * A GROUPED row speaks for several classes (D692 C4, review T9a M-2). The send gate judges it
 * by ALL of them, through the same `snoozeCoverage` the close pass asks: a class snooze must
 * not silence the dog it was not set for.
 */
describe('NcDispatcher — a multi-class grouped row at the snooze gate', () => {
  const NOW = 1_800_000_000_000

  function classWindow(id: string, classes: readonly string[]): NcSnooze {
    return {
      id,
      userId: 'alice',
      scope: 'device',
      deviceId: 101,
      classes: [...classes],
      startedAt: NOW - 1_000,
      expiresAt: NOW + 3_600_000,
      global: false,
      summary: false,
    }
  }

  /** The real verdict over a fixed set of windows — the same chain the centre wires. */
  function realGate(windows: readonly NcSnooze[], gateCalls: NcSnoozeGateInput[]) {
    return async (input: NcSnoozeGateInput): Promise<string | null> => {
      gateCalls.push(input)
      const covered = snoozeCoverage(input, (single) =>
        snoozeVerdict(single, {
          activeFor: (query) => activeSnoozeFor(windows, query),
          ruleFor: () => null,
        }),
      )
      return covered?.[0]?.verdict.snooze.id ?? null
    }
  }

  function groupedEntry(): NcOutboxEntry {
    const base = makeEntry()
    return makeEntry({
      payload: {
        ...base.payload,
        subject: { ...base.payload.subject, timestamp: NOW },
        group: {
          version: 2,
          key: 'grp:rule-1:101:trk-1@1',
          openedAt: NOW - 10_000,
          closedAt: NOW,
          closeReason: 'all-final',
          members: [
            { trackId: 'trk-1', className: 'person', triggerAt: NOW - 10_000 },
            { trackId: 'trk-d', className: 'dog', triggerAt: NOW - 9_000 },
            { trackId: 'trk-2', className: 'person', triggerAt: NOW - 8_000 },
          ],
        },
      },
    })
  }

  function harnessWith(windows: readonly NcSnooze[]) {
    const sends: NcSendInput[] = []
    const gateCalls: NcSnoozeGateInput[] = []
    const dispatcher = new NcDispatcher({
      // The bounded still poll (NC_STILL_WAIT_MS) paces itself through this seam; a real
      // 3 s per text-only delivery was this file's whole runtime.
      sleep: async () => {},
      logger: makeSilentLogger(),
      listTargets: async () => [
        {
          id: 'tgt-1',
          addonId: 'notifiers',
          name: 'alice-phone',
          kind: 'ntfy',
          enabled: true,
          ownerUserId: 'alice',
        },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Cancello',
      now: () => NOW,
      snoozeGate: realGate(windows, gateCalls),
    })
    return { dispatcher, sends, gateCalls }
  }

  it('hands the gate the DISTINCT member classes, in member order', async () => {
    const h = harnessWith([])
    await h.dispatcher.deliver(groupedEntry())
    expect(h.gateCalls[0]?.classNames).toEqual(['person', 'dog'])
  })

  it('a single-class group (and a plain row) passes no classNames', async () => {
    const h = harnessWith([])
    await h.dispatcher.deliver(makeEntry())
    expect(h.gateCalls[0]).not.toHaveProperty('classNames')
  })

  it('a person+person v2 group passes no classNames either (one distinct class)', async () => {
    const h = harnessWith([])
    const base = groupedEntry()
    const group = base.payload.group
    if (group === undefined || !('version' in group)) throw new Error('fixture is not a v2 group')
    await h.dispatcher.deliver({
      ...base,
      payload: {
        ...base.payload,
        group: {
          ...group,
          members: group.members.map((m) => ({ ...m, className: 'person' })),
        },
      },
    })
    expect(h.gateCalls[0]).not.toHaveProperty('classNames')
  })

  it('a LEGACY person+dog burst passes no classNames (only a v2 group is judged by its members)', async () => {
    const h = harnessWith([])
    const base = makeEntry()
    await h.dispatcher.deliver({
      ...base,
      payload: {
        ...base.payload,
        group: {
          key: 'g',
          revision: 2,
          anchorTrackId: 'trk-1',
          members: [
            { trackId: 'trk-1', className: 'person', at: 1 },
            { trackId: 'trk-d', className: 'dog', at: 2 },
          ],
        },
      },
    })
    expect(h.gateCalls[0]).not.toHaveProperty('classNames')
  })

  it('a person+dog row with only a `person` class snooze is DELIVERED', async () => {
    const h = harnessWith([classWindow('w-person', ['person'])])
    await h.dispatcher.deliver(groupedEntry())
    expect(h.sends).toHaveLength(1)
  })

  it('snoozes on BOTH `person` and `dog` suppress it', async () => {
    const h = harnessWith([classWindow('w-person', ['person']), classWindow('w-dog', ['dog'])])
    await h.dispatcher.deliver(groupedEntry())
    expect(h.sends).toHaveLength(0)
  })

  it('one window naming both classes suppresses it', async () => {
    const h = harnessWith([classWindow('w-both', ['person', 'dog'])])
    await h.dispatcher.deliver(groupedEntry())
    expect(h.sends).toHaveLength(0)
  })

  it('a camera-scoped (classless) snooze is unchanged: it suppresses the row', async () => {
    const h = harnessWith([{ ...classWindow('w-cam', []), classes: undefined }])
    await h.dispatcher.deliver(groupedEntry())
    expect(h.sends).toHaveLength(0)
  })
})
