/**
 * An object event's media is read for the ROW'S camera (D694).
 *
 * An object/package event id is a SQLite rowid without AUTOINCREMENT (D474),
 * so a deleted record's id is handed to the next insert. A row still pending
 * (or retrying, or waiting for its recorded cut) for the deleted record then
 * resolves `object:<id>` — and, read with no camera, finds the NEW record's
 * crops: a picture from another camera on this notification. The cap reads
 * (`getEventMedia` / `listEventMedia`) already require a `deviceId`; this pins
 * the delivery-time read the dispatcher makes in-process.
 */

import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import type { MediaFileBytes, MediaFileKind, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { eventMediaScopeOf, type NcEventMediaScope } from '../outbox-key.js'
import type { NcOutboxEntry } from '../outbox.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const REUSED_ID = '292786'
const AT = 1_790_000_000_000

/** A stored media row as `MediaStore.listByOwner` sees it — with its camera. */
interface StoredRow {
  readonly ownerKind: 'object' | 'track'
  readonly ownerId: string
  readonly deviceId: number
  readonly file: MediaFileBytes
}

function file(mediaId: number, kind: MediaFileKind, text: string): MediaFileBytes {
  return {
    mediaId,
    kind,
    base64: Buffer.from(text).toString('base64'),
    sizeBytes: text.length,
    timestamp: AT,
  }
}

/**
 * Two records shared the rowid: the pick-up on 101 is the NEW owner of
 * `object:292786` and its crop is listed first, as the newer row; the record
 * this outbox row speaks for was on 104.
 */
const ROWS: readonly StoredRow[] = [
  {
    ownerKind: 'object',
    ownerId: REUSED_ID,
    deviceId: 101,
    file: file(2, 'fullFrame', 'camera-101'),
  },
  {
    ownerKind: 'object',
    ownerId: REUSED_ID,
    deviceId: 104,
    file: file(1, 'fullFrame', 'camera-104'),
  },
]

/**
 * The production reader's semantics (`nc-owner-media-reader.ts`, specced on a
 * real MediaStore): a scope narrows to its camera and its timestamp, and only
 * then.
 */
async function listByOwner(
  ownerKind: 'object' | 'track',
  ownerId: string,
  scope?: NcEventMediaScope,
): Promise<readonly MediaFileBytes[]> {
  return ROWS.filter(
    (r) =>
      r.ownerKind === ownerKind &&
      r.ownerId === ownerId &&
      (scope === undefined ||
        (r.deviceId === scope.deviceId && r.file.timestamp === scope.recordAt)),
  ).map((r) => r.file)
}

function entry(): NcOutboxEntry {
  return {
    id: `rule-pkg:${REUSED_ID}@104:${String(AT)}:tgt-1`,
    ruleId: 'rule-pkg',
    targetId: 'tgt-1',
    deviceId: 104,
    recordKind: 'package-event',
    recordId: REUSED_ID,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: AT,
    updatedAt: AT,
    payload: {
      ruleName: 'Pacchi',
      delivery: 'package-event',
      priority: 3,
      media: 'best',
      subject: {
        deviceId: 104,
        eventId: REUSED_ID,
        className: 'package',
        zones: [],
        timestamp: AT,
      },
    },
  }
}

describe('the object-owner media read is scoped to the row camera (D694)', () => {
  it('a reused event id never attaches the other camera crop', async () => {
    const sends: NcSendInput[] = []
    const asked: (NcEventMediaScope | undefined)[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'zentik', enabled: true },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async (ownerKind, ownerId, scope) => {
        if (ownerKind === 'object') asked.push(scope)
        return listByOwner(ownerKind, ownerId, scope)
      },
      getDeviceName: async () => null,
      now: () => AT + 1_000,
    })

    const result = await dispatcher.deliver(entry())

    expect(result.ok).toBe(true)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((d) => d?.deviceId === 104 && d.recordAt === AT)).toBe(true)
    const attachments = sends[0]?.notification.attachments ?? []
    expect(attachments).toHaveLength(1)
    const shipped = attachments[0]
    if (shipped === undefined || shipped.bytes === undefined) throw new Error('no still shipped')
    expect(Buffer.from(shipped.bytes).toString()).toBe('camera-104')
  })
})

/**
 * The centre wraps the dispatcher's read (synthetic media, the still shelf,
 * departed tracks) before it reaches the addon's `listByOwner`. The camera must
 * survive that wrapper — a wrapper that drops it reopens the cross-camera read
 * with every dispatcher spec still green.
 */
describe('the notification centre forwards the camera to the media read (D694)', () => {
  let center: NotificationCenter | undefined
  afterEach(async () => {
    await center?.stop()
    center = undefined
  })

  it('a package notification reads object:<id> for its own camera', async () => {
    const world = makeNcRecords()
    const asked: { ownerKind: string; scope: NcEventMediaScope | undefined }[] = []
    const sends: NcSendInput[] = []
    center = new NotificationCenter({
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
        listTargets: async () => [
          { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
        ],
        send: async (input) => {
          sends.push(input)
          return { success: true }
        },
        getMediaForOwner: async (ownerKind, ownerId, scope) => {
          asked.push({ ownerKind, scope })
          return listByOwner(ownerKind, ownerId, scope)
        },
        getDeviceName: async () => null,
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      now: () => AT + 1_000,
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 3_600_000,
    })
    await center.start({ evaluation: true })
    await center.whenHydrated()
    await center.buildProvider().createRule({
      rule: NcRuleInputSchema.parse({
        name: 'Pacchi',
        delivery: 'package-event',
        targets: [{ targetId: 'tgt-1' }],
        conditions: { packagePhase: 'both' },
        media: { attach: 'best' },
      }),
      caller: { userId: 'admin-42', isAdmin: true },
    })
    const delivered: ObjectEvent = {
      id: Number(REUSED_ID),
      kind: 'object',
      deviceId: 104,
      timestamp: AT,
      trackId: 'trk-van',
      className: 'package',
      state: 'entered',
      zones: [],
      confidence: 1,
    }
    center.onPackageEventPersisted(delivered, 'delivered')
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox').size).toBe(1)
    })
    await center.drainNow()

    const objectReads = asked.filter((a) => a.ownerKind === 'object')
    expect(objectReads.length).toBeGreaterThan(0)
    expect(objectReads.every((a) => a.scope?.deviceId === 104 && a.scope.recordAt === AT)).toBe(
      true,
    )
    expect(sends).toHaveLength(1)
  })
})

describe('eventMediaScopeOf (D694)', () => {
  it('an ordinary row is scoped to its own subject', () => {
    expect(eventMediaScopeOf(entry().payload.subject)).toEqual({ deviceId: 104, recordAt: AT })
  })

  it('a COMBINED alarm row is scoped to the alarm SOURCE, never the transition instant', () => {
    const subject = {
      ...entry().payload.subject,
      timestamp: AT + 45_000,
      systemEvent: {
        kind: 'alarm-triggered' as const,
        subject: 'panel',
        data: {},
        alarmSource: {
          ruleId: 'rule-pkg',
          ruleName: 'Pacchi',
          deviceId: 104,
          recordId: REUSED_ID,
          eventId: REUSED_ID,
          timestamp: AT,
          zones: [],
        },
      },
    }
    expect(eventMediaScopeOf(subject)).toEqual({ deviceId: 104, recordAt: AT })
  })
})
