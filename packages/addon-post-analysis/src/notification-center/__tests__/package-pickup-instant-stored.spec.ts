/**
 * A pick-up's instant is read from its ROW (D684) — so the reconcile, the
 * dry-run and the live hook anchor the footage on the same moment.
 *
 * D682 handed the instant beside the row, on the live hook only. The boot
 * crash-gap reconcile re-reads the row, and the row did not store it: every
 * pick-up the reconcile replayed was anchored on its CONCLUSION, five minutes
 * after the parcel went. These pin the three things that have to be true now:
 *
 * 1. A stored pick-up row that carries `observedAt` reaches the outbox subject
 *    through the reconcile with that instant.
 * 2. The live hook and the reconcile freeze the SAME `observedAt` for the same
 *    row — one derivation (`subjectFromPackageEvent` reading the row), not two.
 * 3. A row written before D684 (no `observedAt`) still works, and still reads
 *    as UNKNOWN — the dispatcher's fallback line, never a guessed instant.
 */

import type { InMemoryRecords } from '@camstack/types'
import type { ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { mediaAnchor, selfDatingKindOf } from '../media-anchor.js'
import { type NcOutboxPayload } from '../outbox.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const DEVICE = 101
const CALLER = { userId: 'admin-42', isAdmin: true }
/** When the parcel was last seen — the pick-up. */
const PICKUP_AT = 1_790_000_000_000
/** When the detector CONCLUDED it: five minutes of unseen time later. */
const CONCLUDED_AT = PICKUP_AT + 300_000

function pickUpRow(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 283529,
    kind: 'object',
    deviceId: DEVICE,
    timestamp: CONCLUDED_AT,
    trackId: 'trk-person',
    className: 'package',
    state: 'left',
    zones: ['porch'],
    confidence: 1,
    observedAt: PICKUP_AT,
    ...overrides,
  }
}

function makeCenter(
  world: InMemoryRecords,
  events: readonly ObjectEvent[],
  now: number,
): NotificationCenter {
  return new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async (since) => events.filter((e) => e.timestamp >= since),
    listRecentTracks: async () => [],
    now: () => now,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
}

function outboxSubjects(world: InMemoryRecords): NcOutboxPayload['subject'][] {
  const rows = [...(ncTable(world, 'outbox')?.values() ?? [])]
  return rows.map((row) => {
    const payload = row['payload']
    if (payload === null || typeof payload !== 'object') throw new Error('no outbox payload')
    // Documented type boundary — the payload JSON round-trips as `unknown`
    // through the fake store, same narrowing as notification-center.spec.ts.
    return (payload as NcOutboxPayload).subject
  })
}

/** Create the pick-up rule in a first life, then stop — the crash. */
async function withPickupRule(world: InMemoryRecords): Promise<void> {
  const first = makeCenter(world, [], PICKUP_AT - 60_000)
  await first.start({ evaluation: true })
  await first.buildProvider().createRule({
    rule: NcRuleInputSchema.parse({
      name: 'Consegna pacco (front door)',
      delivery: 'package-event',
      targets: [{ targetId: 'tgt-1' }],
      conditions: { packagePhase: 'picked-up' },
      media: { attach: 'best-matching', gif: true },
    }),
    caller: CALLER,
  })
  await first.stop()
}

describe('a pick-up replayed from its stored row is anchored on the pick-up (D684)', () => {
  let center: NotificationCenter | undefined
  afterEach(async () => {
    await center?.stop()
    center = undefined
  })

  it('the reconcile freezes the stored instant onto the outbox subject', async () => {
    const world = makeNcRecords()
    await withPickupRule(world)
    center = makeCenter(world, [pickUpRow()], CONCLUDED_AT + 60_000)
    await center.start({ evaluation: true })
    await center.whenHydrated()

    const subjects = outboxSubjects(world)
    expect(subjects).toHaveLength(1)
    expect(subjects[0]?.timestamp).toBe(CONCLUDED_AT)
    expect(subjects[0]?.observedAt).toBe(PICKUP_AT)
    const anchor = mediaAnchor(subjects[0]!)
    expect(anchor.atMs).toBe(PICKUP_AT)
    expect(anchor.source).toBe('observed')
  })

  it('the live hook and the reconcile freeze the SAME instant for the same row', async () => {
    const live = makeNcRecords()
    await withPickupRule(live)
    center = makeCenter(live, [], CONCLUDED_AT)
    await center.start({ evaluation: true })
    center.onPackageEventPersisted(pickUpRow(), 'picked-up')
    await vi.waitFor(() => {
      expect(outboxSubjects(live)).toHaveLength(1)
    })
    await center.stop()

    const replayed = makeNcRecords()
    await withPickupRule(replayed)
    center = makeCenter(replayed, [pickUpRow()], CONCLUDED_AT + 60_000)
    await center.start({ evaluation: true })
    await center.whenHydrated()

    const liveSubject = outboxSubjects(live)[0]
    const replayedSubject = outboxSubjects(replayed)[0]
    expect(liveSubject?.observedAt).toBe(PICKUP_AT)
    expect(replayedSubject?.observedAt).toBe(liveSubject?.observedAt)
    expect(mediaAnchor(replayedSubject!)).toEqual(mediaAnchor(liveSubject!))
  })

  it('a row written before D684 still replays — its moment is UNKNOWN, never guessed', async () => {
    const world = makeNcRecords()
    await withPickupRule(world)
    const { observedAt: _absent, ...legacy } = pickUpRow()
    center = makeCenter(world, [legacy], CONCLUDED_AT + 60_000)
    await center.start({ evaluation: true })
    await center.whenHydrated()

    const subjects = outboxSubjects(world)
    expect(subjects).toHaveLength(1)
    expect(subjects[0]?.observedAt).toBeUndefined()
    // The dispatcher's fallback line fires for exactly this pair.
    expect(selfDatingKindOf(subjects[0]!)).toBe('package pick-up')
    expect(mediaAnchor(subjects[0]!).fallback).toBe('unknown')
  })
})
