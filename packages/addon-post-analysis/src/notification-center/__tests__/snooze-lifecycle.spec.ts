/**
 * Snooze, end to end through the real center: a rule fires, the window hides
 * the delivery, the window closes on its own, and the operator is told what
 * they missed.
 *
 * This is the test that would have caught each half being wired to nothing —
 * the decision layer existed for a day before anything called it.
 */
import { ncTable } from './support/nc-test-deps.js'
import type { InMemoryRecords } from '@camstack/types'
import type { ObjectEvent } from '@camstack/types'
import { makeTestObjectEvent } from '../../__tests__/support/events.js'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { ncPruneWindowsPort, makeNcRecords } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const T0 = 1_800_000_000_000
const BOB = { userId: 'user-bob', isAdmin: false }
const ADMIN = { userId: 'admin-42', isAdmin: true }

const TARGETS: readonly NcTargetRef[] = [
  {
    id: 'tgt-bob',
    addonId: 'notifiers',
    name: 'bob-phone',
    kind: 'ntfy',
    enabled: true,
    ownerUserId: 'user-bob',
  },
]

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  setNow(ms: number): void
  fire(id: string): void
}

function makeHarness(): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  let now = T0
  const events: ObjectEvent[] = []
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async (deviceId) => (deviceId === 101 ? 'Cancello' : null),
    },
    listObjectEventsSince: async (since) => events.filter((e) => e.timestamp >= since),
    listRecentTracks: async () => [],
    now: () => now,
    // Fast enough to drive the drain (and with it the digest tick) from a test.
    drainIntervalMs: 5,
    ruleReloadIntervalMs: 3_600_000,
  })
  return {
    center,
    store,
    world,
    sends,
    setNow: (ms) => {
      now = ms
    },
    fire: (trackKey) => {
      const event: ObjectEvent = makeTestObjectEvent({
        trackId: `trk-${trackKey}`,
        deviceId: 101,
        timestamp: now,
        zones: [],
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      })
      events.push(event)
      center.onObjectEventPersisted(event)
    },
  }
}

async function makeRule(h: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
  const { rule } = await h.center.buildProvider().createRule({
    rule: NcRuleInputSchema.parse({
      name: 'person at gate',
      delivery: 'immediate',
      targets: [{ targetId: 'tgt-bob' }],
      conditions: { classes: ['person'] },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
      ...overrides,
    }),
    caller: ADMIN,
  })
  return rule.id
}

describe('snooze — end to end', () => {
  let harness: Harness | null = null
  afterEach(async () => {
    await harness?.center.stop()
    harness = null
  })

  it('hides the delivery while the window is open, and counts it', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    const ruleId = await makeRule(h)
    await h.center.createSnooze({ scope: 'rule', ruleId, durationMinutes: 60 }, BOB)

    h.fire('ev-1')
    // The drain runs every 5 ms; give it room to have NOT sent.
    await vi.waitFor(() => {
      expect(ncTable(h.world, 'snooze-suppressed').size).toBe(1)
    })
    expect(h.sends).toHaveLength(0)
  })

  it('delivers normally once the clock passes the window — nothing had to run', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    const ruleId = await makeRule(h)
    await h.center.createSnooze({ scope: 'rule', ruleId, durationMinutes: 1 }, BOB)

    h.setNow(T0 + 5 * 60_000)
    h.fire('ev-2')
    // These fakes hold no media at all, so every delivery here pays the bounded
    // still wait (NC_STILL_WAIT_MS) before shipping text-only.
    await vi.waitFor(
      () => {
        expect(h.sends.filter((s) => s.notification.title !== undefined)).not.toHaveLength(0)
      },
      { timeout: 8_000 },
    )
    expect(ncTable(h.world, 'snooze-suppressed').size).toBe(0)
  })

  it('sends the digest when the window closes, to the target that was silenced', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    const ruleId = await makeRule(h)
    await h.center.createSnooze({ scope: 'rule', ruleId, durationMinutes: 1 }, BOB)

    h.fire('ev-3')
    await vi.waitFor(() => {
      expect(ncTable(h.world, 'snooze-suppressed').size).toBe(1)
    })
    expect(h.sends).toHaveLength(0)

    // The window ends because the clock passed it.
    h.setNow(T0 + 5 * 60_000)
    await vi.waitFor(() => {
      expect(h.sends).toHaveLength(1)
    })
    const digest = h.sends[0]
    if (digest === undefined) {
      throw new Error('expected snooze digest send')
    }
    expect(digest.targetId).toBe('tgt-bob')
    expect(digest.notification.title).toContain('1 notification hidden')
    expect(digest.notification.body).toContain('person at gate')
    expect(digest.notification.body).toContain('Cancello')

    // And exactly once — a digest that repeats every drain tick is worse than
    // no digest at all.
    await new Promise((r) => setTimeout(r, 50))
    expect(h.sends).toHaveLength(1)
  })

  it('a window that asked for no summary leaves nothing behind at all', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    const ruleId = await makeRule(h)
    await h.center.createSnooze({ scope: 'rule', ruleId, durationMinutes: 1, summary: false }, BOB)

    h.fire('ev-4')
    await new Promise((r) => setTimeout(r, 40))
    expect(h.sends).toHaveLength(0)
    // Not counted either: nobody will ever read those rows.
    expect(ncTable(h.world, 'snooze-suppressed').size).toBe(0)

    h.setNow(T0 + 5 * 60_000)
    await new Promise((r) => setTimeout(r, 40))
    expect(h.sends).toHaveLength(0)
  })

  it('a personal window silences only its author, never the household', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    const ruleId = await makeRule(h)
    // ANN snoozes the same rule. Bob's phone must keep ringing.
    await h.center.createSnooze(
      { scope: 'rule', ruleId, durationMinutes: 60 },
      { userId: 'user-ann', isAdmin: false },
    )

    h.fire('ev-5')
    // Text-only, and therefore ~3 s late: see the bounded still wait above.
    await vi.waitFor(
      () => {
        expect(h.sends).toHaveLength(1)
      },
      { timeout: 8_000 },
    )
    expect(ncTable(h.world, 'snooze-suppressed').size).toBe(0)
  })
})

describe('snooze — who may silence other people', () => {
  let harness: Harness | null = null
  afterEach(async () => {
    await harness?.center.stop()
    harness = null
  })

  it('refuses a global window on a rule that did not opt in', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: false })
    const ruleId = await makeRule(h)
    await expect(
      h.center.createSnooze({ scope: 'rule', ruleId, durationMinutes: 60, global: true }, BOB),
    ).rejects.toThrow(/may not be made global/)
  })

  it('allows it once the rule opted in — the gardener case', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: false })
    const ruleId = await makeRule(h, { snoozeAllowGlobal: true })
    const snooze = await h.center.createSnooze(
      { scope: 'rule', ruleId, durationMinutes: 60, global: true },
      BOB,
    )
    expect(snooze.global).toBe(true)
  })

  it('refuses — rather than silently downgrading — a non-admin silencing a whole camera', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: false })
    await expect(
      h.center.createSnooze(
        { scope: 'device', deviceId: 101, durationMinutes: 60, global: true },
        BOB,
      ),
    ).rejects.toThrow(/may not be made global/)
  })

  it('refuses a scoped window with no id — it would otherwise match nothing, confusingly', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: false })
    await expect(
      h.center.createSnooze({ scope: 'device', durationMinutes: 60 }, BOB),
    ).rejects.toThrow(/needs a deviceId/)
  })

  it('lets a user end their own window and nobody else’s', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: false })
    const snooze = await h.center.createSnooze({ scope: 'all', durationMinutes: 60 }, BOB)
    await expect(
      h.center.cancelSnooze(snooze.id, { userId: 'user-ann', isAdmin: false }),
    ).rejects.toThrow(/not owned/)
    await h.center.cancelSnooze(snooze.id, ADMIN)
    expect(h.center.snoozeStore.get(snooze.id)?.expiresAt).toBe(T0)
  })
})

describe('a window never silences an ALARM rule', () => {
  let harness: Harness | null = null
  afterEach(async () => {
    await harness?.center.stop()
    harness = null
  })

  it('delivers an alarm-actuating rule THROUGH a whole-feed window', async () => {
    // The dangerous case the exemption exists for: a household window opened
    // at 22:00 to stop the garden camera must not swallow the siren at 03:00.
    // The button surface refusing to offer a snooze proves nothing here — this
    // window was opened from the app and knows nothing about the rules it will
    // meet.
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    await makeRule(h, {
      name: 'intruder — arm',
      actions: {
        onTrigger: [
          {
            kind: 'do',
            action: { kind: 'cap', deviceId: 900, cap: 'alarm-panel', method: 'trigger' },
          },
        ],
      },
    })
    await h.center.createSnooze({ scope: 'all', durationMinutes: 60 }, BOB)

    h.fire('ev-alarm')
    await vi.waitFor(
      () => {
        expect(h.sends.length).toBeGreaterThan(0)
      },
      { timeout: 8_000 },
    )
    expect(ncTable(h.world, 'snooze-suppressed').size).toBe(0)
  })

  it('CONTROL — the SAME window silences an ordinary rule', async () => {
    // Without this the test above would pass with the snooze gate removed
    // entirely.
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    await makeRule(h)
    await h.center.createSnooze({ scope: 'all', durationMinutes: 60 }, BOB)

    h.fire('ev-plain')
    await vi.waitFor(() => {
      expect(ncTable(h.world, 'snooze-suppressed').size).toBe(1)
    })
    expect(h.sends).toHaveLength(0)
  })
})
