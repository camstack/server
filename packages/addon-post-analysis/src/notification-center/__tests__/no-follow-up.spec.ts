/**
 * D692 Task 17 — the D142 follow-up and the D143 revisions are gone, and what they left on disk
 * still reads.
 *
 * Pinned on the real `NotificationCenter`, the real outbox and the real dispatcher:
 *
 *  1. an `immediate` recognition rule says it ONCE — a track that closes with a name the first
 *     message did not have enqueues nothing (it used to enqueue `<trackId>:enhanced`);
 *  2. a pending legacy row stamped `enhancement: true` still delivers, once, and never says
 *     "now recognised" (the field is ignored, §6.4);
 *  3. a pending legacy D143 row carrying `group.revision: 2` still delivers, once, with the
 *     group sentence and no push tag.
 *
 * Rows 2 and 3 are inserted into the fake store BEFORE boot, in the shape the old code wrote.
 */

import type { InMemoryRecords } from '@camstack/types'
import { ncTable, makeNcRecords } from './support/nc-test-deps.js'
import type { NcRuleInput, ObjectEvent, Track } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const NOW = 100_000
const DEVICE = 104
const PLATE = { stepId: 'plate-ocr', decidedAt: 1 } as const

function plateRule(): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'vehicles',
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['vehicle'], plates: { values: ['ZZ000ZZ'], maxDistance: 3 } },
  })
}

function makeEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 1,
    kind: 'object',
    deviceId: DEVICE,
    timestamp: NOW,
    trackId: 'trk-v',
    className: 'vehicle',
    confidence: 0.9,
    zones: [],
    subLabel: 'ZZ000ZZ',
    subLabelMeta: PLATE,
    ...overrides,
  }
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    trackId: 'trk-v',
    deviceId: DEVICE,
    className: 'vehicle',
    firstSeen: NOW - 10_000,
    lastSeen: NOW,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0.2,
    state: 'left',
    active: false,
    ...overrides,
  }
}

interface Harness {
  readonly center: NotificationCenter
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
}

function makeHarness(world: InMemoryRecords = makeNcRecords()): Harness {
  const sends: NcSendInput[] = []
  const targets: NcTargetRef[] = [
    { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Driveway',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => NOW,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  return { center, world, sends }
}

function outboxIds(world: InMemoryRecords): string[] {
  return [...(ncTable(world, 'outbox')?.keys() ?? [])]
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

/** A pending row in the shape the pre-D692 code wrote. */
function legacyRow(
  id: string,
  payloadExtras: Record<string, unknown>,
): { readonly id: string; readonly data: Record<string, unknown> } {
  return {
    id,
    data: {
      ruleId: 'rule-legacy',
      targetId: 'tgt-1',
      deviceId: DEVICE,
      recordKind: 'track-end',
      recordId: 'ev-legacy',
      trackId: 'trk-1',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: NOW - 5_000,
      updatedAt: NOW - 5_000,
      payload: {
        ruleName: 'Persone',
        delivery: 'immediate',
        priority: 3,
        media: 'none',
        subject: {
          deviceId: DEVICE,
          eventId: 'ev-legacy',
          trackId: 'trk-1',
          className: 'person',
          label: 'Person A',
          labelKind: 'identity',
          zones: [],
          timestamp: NOW - 5_000,
        },
        ...payloadExtras,
      },
    },
  }
}

describe('D142 removed — an immediate recognition rule says it once', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('1. a track whose label changes by the close enqueues ONE row in total, none at the close', async () => {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    await h.center.buildProvider().createRule({ rule: plateRule(), caller: CALLER })

    h.center.onObjectEventPersisted(makeEvent())
    await vi.waitFor(() => {
      expect(outboxIds(h.world)).toHaveLength(1)
    })

    // The plate gallery names the vehicle while the track is still open: the word changes.
    const closed = makeTrack({
      subLabel: 'Van',
      subLabelMeta: { stepId: 'operator:plate-gallery', decidedAt: 2, identityId: 'veh-1' },
    })
    h.center.onTrackClosed(closed, [])
    await settle()
    await settle()
    expect(outboxIds(h.world)).toHaveLength(1)
    expect(outboxIds(h.world).some((id) => id.includes(':enhanced'))).toBe(false)
  })
})

describe('legacy rows written by the removed paths still deliver', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  async function bootWith(row: ReturnType<typeof legacyRow>): Promise<readonly NcSendInput[]> {
    const world = makeNcRecords()
    world.seed('outbox', row)
    h = makeHarness(world)
    await h.center.start({ evaluation: true })
    // The back-fill (which loads the outbox) runs after `start` resolves: drain until it has.
    await vi.waitFor(async () => {
      await h.center.drainNow()
      expect(h.sends.length).toBeGreaterThan(0)
    })
    await h.center.drainNow()
    return h.sends
  }

  it('2. enhancement:true + a `:enhanced` id → delivered once, the field ignored', async () => {
    const sends = await bootWith(
      legacyRow('rule-legacy:trk-1:enhanced:tgt-1', { enhancement: true }),
    )
    expect(sends).toHaveLength(1)
    // The upgrade rows were `track-end` rows, so with the field ignored they read as the
    // ordinary track-end sentence — never the retired "now recognised" one.
    expect(sends[0]?.notification.body).toMatch(/^Person A on driveway/)
    expect(sends[0]?.notification.body).not.toContain('now recognised')
  })

  it('3. a D143 row with group.revision 2 → delivered once, the group sentence, no tag', async () => {
    const sends = await bootWith(
      legacyRow('rule-legacy:grp:rule-legacy:104:1:v2:tgt-1', {
        group: {
          key: 'grp:rule-legacy:104:1',
          revision: 2,
          anchorTrackId: 'trk-1',
          members: [
            {
              trackId: 'trk-1',
              className: 'person',
              label: 'Person A',
              labelKind: 'identity',
              at: 1,
            },
            { trackId: 'trk-2', className: 'person', at: 2 },
          ],
        },
      }),
    )
    expect(sends).toHaveLength(1)
    expect(sends[0]?.notification.body).toContain('Person A and 1 other person')
    expect(sends[0]?.notification.tag).toBeUndefined()
  })
})
