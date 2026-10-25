/**
 * A snooze silences a NOTIFICATION. It never stops the rule from doing things.
 *
 * The distinction is the whole reason the gate sits in `NcDispatcher.deliver`
 * rather than anywhere earlier: `runRuleActions` fires at MATCH time, in the
 * centre, long before an outbox row is drained. Moving the gate up to
 * `evaluateAndEnqueue` would be a one-line "optimisation" that quietly turns
 * "I do not want to be told about the garden this afternoon" into "the gate
 * does not open and the alarm does not arm this afternoon".
 *
 * The cooldown already has this property and states it (`runRuleActions` runs
 * before the cooldown gate). This pins the same property for the snooze, on
 * the real centre, with the real store.
 */

import type { ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
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

interface Actuation {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
}

interface Harness {
  readonly center: NotificationCenter
  readonly sends: NcSendInput[]
  readonly actuations: Actuation[]
  fire(id: string): void
}

function makeHarness(): Harness {
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const actuations: Actuation[] = []
  const events: ObjectEvent[] = []
  const now = T0
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
      getDeviceName: async () => 'Cancello',
    },
    listObjectEventsSince: async (since) => events.filter((e) => e.timestamp >= since),
    listRecentTracks: async () => [],
    now: () => now,
    drainIntervalMs: 5,
    ruleReloadIntervalMs: 3_600_000,
    // The two deps that make a rule able to MOVE something.
    actuate: async (input) => {
      actuations.push({ deviceId: input.deviceId, cap: input.cap, method: input.method })
    },
    isCapDeviceScoped: () => true,
  })
  return {
    center,
    sends,
    actuations,
    fire: (tag: string) => {
      const id = tag === 'ev-1' ? 90_001 : 90_002
      const event: ObjectEvent = {
        id,
        kind: 'object',
        deviceId: 101,
        trackId: `trk-${tag}`,
        className: 'person',
        confidence: 0.9,
        timestamp: now,
        zones: [],
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      }
      events.push(event)
      center.onObjectEventPersisted(event)
    },
  }
}

async function makeActuatingRule(h: Harness): Promise<string> {
  const { rule } = await h.center.buildProvider().createRule({
    rule: NcRuleInputSchema.parse({
      name: 'person at gate',
      delivery: 'immediate',
      targets: [{ targetId: 'tgt-bob' }],
      conditions: { classes: ['person'] },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
      actions: {
        onTrigger: [
          {
            kind: 'do',
            action: { kind: 'cap', deviceId: 42, cap: 'switch', method: 'turnOn' },
          },
        ],
      },
    }),
    caller: ADMIN,
  })
  return rule.id
}

describe('a snooze suppresses the notification and nothing else', () => {
  let harness: Harness | null = null
  afterEach(async () => {
    await harness?.center.stop()
    harness = null
  })

  it('runs the rule ACTIONS while the window hides the delivery', async () => {
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    const ruleId = await makeActuatingRule(h)
    await h.center.createSnooze({ scope: 'rule', ruleId, durationMinutes: 60 }, BOB)

    h.fire('ev-1')

    // The gate physically moved…
    await vi.waitFor(() => {
      expect(h.actuations).toEqual([{ deviceId: 42, cap: 'switch', method: 'turnOn' }])
    })
    // …and nothing was delivered. Both halves matter: an assertion on the
    // actuation alone would pass with the snooze doing nothing at all.
    await new Promise((r) => setTimeout(r, 60))
    expect(h.sends).toHaveLength(0)
  })

  it('CONTROL — the same rule with no window delivers AND actuates', async () => {
    // Without this the test above could pass because the rule never fired.
    const h = (harness = makeHarness())
    await h.center.start({ evaluation: true })
    await makeActuatingRule(h)

    h.fire('ev-2')
    await vi.waitFor(
      () => {
        expect(h.sends.length).toBeGreaterThan(0)
      },
      { timeout: 8_000 },
    )
    expect(h.actuations).toEqual([{ deviceId: 42, cap: 'switch', method: 'turnOn' }])
  })
})
