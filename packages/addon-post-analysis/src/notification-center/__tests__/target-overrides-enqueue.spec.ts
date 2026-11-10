/**
 * #487 — a rule's targets each carry settings of their own (`targetOverrides`).
 *
 * 1. A target outside its OWN schedule gets no outbox row, and the other
 *    targets of the same fire still get theirs.
 * 2. A target's text override replaces the rule's text for that target only;
 *    a field it does not name is inherited from the rule.
 * 3. A target's priority override replaces the rule's — and a legacy
 *    `params.priority`, which the dispatcher would otherwise read first.
 * 4. A rule with no overrides freezes exactly what it froze before.
 */
import type { InMemoryRecords, NcRuleInput, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import type { NcOutboxPayload } from '../outbox.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const DEVICE = 101
const CALLER = { userId: 'admin-42', isAdmin: true }
/** Monday 2026-09-21 14:18 UTC. */
const AT = 1_790_000_300_000
const MONDAY = 1
/** A Monday window that does NOT cover 14:18 UTC. */
const MORNING_ONLY = {
  windows: [{ days: [MONDAY], startMinute: 6 * 60, endMinute: 9 * 60 }],
  timezone: 'UTC',
}
/** A Monday window that does. */
const AFTERNOON = {
  windows: [{ days: [MONDAY], startMinute: 12 * 60, endMinute: 18 * 60 }],
  timezone: 'UTC',
}

function delivered(): ObjectEvent {
  return {
    id: 1,
    kind: 'object',
    deviceId: DEVICE,
    timestamp: AT,
    trackId: 'trk-1',
    className: 'package',
    state: 'entered',
    zones: ['porch'],
    confidence: 1,
  }
}

function makeCenter(world: InMemoryRecords, logger = makeSilentLogger()): NotificationCenter {
  return new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger,
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => [
        { id: 'tgt-phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
        { id: 'tgt-echo', addonId: 'import-alexa', name: 'kitchen', kind: 'echo', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => AT,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
}

/** targetId → frozen payload. */
function rowsByTarget(world: InMemoryRecords): ReadonlyMap<string, NcOutboxPayload> {
  const rows = [...(ncTable(world, 'outbox')?.values() ?? [])]
  return new Map(
    rows.map((row) => {
      const payload = row['payload']
      if (payload === null || typeof payload !== 'object') throw new Error('no outbox payload')
      // Documented type boundary — the payload JSON round-trips as `unknown`
      // through the fake store, same narrowing as notification-center.spec.ts.
      return [String(row['targetId']), payload as NcOutboxPayload]
    }),
  )
}

function ruleWith(extra: Partial<NcRuleInput>): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Parcel',
    delivery: 'package-event',
    targets: [{ targetId: 'tgt-phone' }, { targetId: 'tgt-echo', params: { priority: 1 } }],
    conditions: { packagePhase: 'delivered' },
    template: { title: 'Parcel at {{device}}', body: 'A parcel arrived' },
    priority: 3,
    ...extra,
  })
}

async function fire(rule: NcRuleInput, logger = makeSilentLogger()) {
  const world = makeNcRecords()
  const center = makeCenter(world, logger)
  centers.push(center)
  await center.start({ evaluation: true })
  await center.buildProvider().createRule({ rule, caller: CALLER })
  center.onPackageEventPersisted(delivered(), 'delivered')
  return { world, center }
}

const centers: NotificationCenter[] = []
afterEach(async () => {
  await Promise.all(centers.map((c) => c.stop()))
  centers.length = 0
})

describe('per-target schedule (#487)', () => {
  it('a target outside its own window is skipped, logged, and the others still deliver', async () => {
    const logger = makeSilentLogger()
    const info = vi.spyOn(logger, 'info')
    const { world } = await fire(
      ruleWith({ targetOverrides: { 'tgt-echo': { schedule: MORNING_ONLY } } }),
      logger,
    )
    await vi.waitFor(() => expect(rowsByTarget(world).has('tgt-phone')).toBe(true))
    expect(rowsByTarget(world).has('tgt-echo')).toBe(false)
    const skip = info.mock.calls.find(([msg]) => msg.includes('outside its own schedule'))
    expect(skip?.[1]).toMatchObject({ tags: { deviceId: DEVICE }, meta: { targetId: 'tgt-echo' } })
  })

  it('a target inside its own window delivers', async () => {
    const { world } = await fire(
      ruleWith({ targetOverrides: { 'tgt-echo': { schedule: AFTERNOON } } }),
    )
    await vi.waitFor(() => expect(rowsByTarget(world).size).toBe(2))
  })
})

describe('per-target texts and priority (#487)', () => {
  it('the override is used for its target; the field it does not name is inherited', async () => {
    const { world } = await fire(
      ruleWith({ targetOverrides: { 'tgt-echo': { template: { title: 'Pacco!' } } } }),
    )
    await vi.waitFor(() => expect(rowsByTarget(world).size).toBe(2))
    const rows = rowsByTarget(world)
    expect(rows.get('tgt-echo')?.template).toEqual({ title: 'Pacco!', body: 'A parcel arrived' })
    expect(rows.get('tgt-phone')?.template).toEqual({
      title: 'Parcel at {{device}}',
      body: 'A parcel arrived',
    })
  })

  it('a priority override replaces the rule priority AND a legacy params.priority', async () => {
    const { world } = await fire(ruleWith({ targetOverrides: { 'tgt-echo': { priority: 5 } } }))
    await vi.waitFor(() => expect(rowsByTarget(world).size).toBe(2))
    const rows = rowsByTarget(world)
    expect(rows.get('tgt-echo')?.priority).toBe(5)
    expect(rows.get('tgt-echo')?.params?.['priority']).toBeUndefined()
    expect(rows.get('tgt-phone')?.priority).toBe(3)
  })

  it('a rule with no overrides freezes what it always did', async () => {
    const { world } = await fire(ruleWith({}))
    await vi.waitFor(() => expect(rowsByTarget(world).size).toBe(2))
    const echo = rowsByTarget(world).get('tgt-echo')
    expect(echo?.priority).toBe(3)
    expect(echo?.params).toEqual({ priority: 1 })
    expect(echo?.template).toEqual({ title: 'Parcel at {{device}}', body: 'A parcel arrived' })
  })
})
