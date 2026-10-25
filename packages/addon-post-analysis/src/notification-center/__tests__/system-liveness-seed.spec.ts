/**
 * THE HUB RESTART MUST NOT LOOK LIKE THE WORLD CHANGING.
 *
 * ## The bug this pins, end to end
 *
 * 2026-08-13: the hub container was recreated. Every provider reconnected and
 * emitted `device.online` for its devices, and the operator's phone received a
 * "camera online" notification for EVERY camera on the installation (~15+).
 * Nothing had come back — nothing had gone away in the first place.
 *
 * The notification centre remembered the last liveness of a subject in RAM
 * only, so a fresh process held no previous observation and every
 * re-announcement read as a transition. `liveness-ledger.spec.ts` pins the
 * ledger itself; this file pins the WIRING — that the centre reseeds it at
 * boot, consults it before evaluating, and still lets a genuine recovery
 * through.
 *
 * ## How the negatives are proved
 *
 * "Zero notifications" cannot be asserted by waiting a while and hoping. Every
 * negative here is followed by a CONTROL event that must produce exactly one
 * outbox row, and the assertion is on the total: the row that arrives proves
 * the path was alive, and the count proves the suppressed events produced
 * nothing.
 */
import type { InMemoryRecords } from '@camstack/types'
import { createEvent, DeviceType, NcRuleInputSchema, type SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CAMERA_IDS = Array.from({ length: 15 }, (_, i) => 600 + i)

const TARGETS: readonly NcTargetRef[] = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]

const centers: NotificationCenter[] = []

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
})

/** One directory entry. `online` absent = this hub did not supply liveness. */
function identity(deviceId: number, online?: boolean): NcDeviceIdentity {
  return {
    deviceId,
    type: DeviceType.Camera,
    name: `Camera ${deviceId}`,
    isCamera: true,
    ...(online !== undefined ? { online } : {}),
  }
}

/**
 * A centre wired over `store`, started as the evaluating node.
 *
 * `identities` defaults to a directory that carries NO liveness at all — the
 * older wiring, and the shape every test above the directory-seed block was
 * written against.
 */
async function startCenter(
  world: InMemoryRecords,
  identities: readonly NcDeviceIdentity[] = CAMERA_IDS.map((deviceId) => identity(deviceId)),
): Promise<NotificationCenter> {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => [...TARGETS],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Camera',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => identities,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  // The ledger reseed + the directory seed are BACK-FILL phases now (`start()`
  // resolving means the intake is open, not that the ledger has been
  // recovered). THIS suite is about the reseed, so it waits for it. A cold
  // ledger in the live window still fails toward DISCARD — it seeds silently
  // rather than notifying — which is the direction D130 requires.
  await center.whenHydrated()
  return center
}

/** The operator's rule: tell me when a camera goes down or comes back. */
async function createLivenessRule(center: NotificationCenter): Promise<void> {
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Camera liveness',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-online', 'device-offline'] } },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
}

function liveness(deviceId: number, online: boolean): SystemEvent {
  return createEvent(
    online ? 'device.online' : 'device.offline',
    { type: 'device', id: deviceId },
    { deviceId, providerId: 'reolink' },
  )
}

function outboxRows(world: InMemoryRecords): readonly Record<string, unknown>[] {
  return [...(ncTable(world, 'outbox')?.values() ?? [])]
}

/** The frozen `kind` of every enqueued row, in insertion order. */
function enqueuedKinds(world: InMemoryRecords): readonly unknown[] {
  return outboxRows(world).map((row) => {
    const payload = row['payload']
    if (payload === null || typeof payload !== 'object') return undefined
    const subject = (payload as Record<string, unknown>)['subject']
    if (subject === null || typeof subject !== 'object') return undefined
    const systemEvent = (subject as Record<string, unknown>)['systemEvent']
    if (systemEvent === null || typeof systemEvent !== 'object') return undefined
    return (systemEvent as Record<string, unknown>)['kind']
  })
}

describe('the liveness ledger, wired into the notification centre', () => {
  it('a COLD ledger seeds the first device.online and notifies nothing', async () => {
    const world = makeNcRecords()
    const center = await startCenter(world)
    await createLivenessRule(center)

    // The boot announcement. On a cold ledger this is the FIRST observation of
    // device 600 — it is recorded, and it says nothing.
    center.onSystemEvent(liveness(600, true))

    // CONTROL: the same camera then genuinely goes away. The ledger holds
    // `online`, so this is a real flip and MUST notify.
    center.onSystemEvent(liveness(600, false))

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline'])
  })

  it('a repeat of the state the ledger holds is discarded (no-flip)', async () => {
    const world = makeNcRecords()
    const center = await startCenter(world)
    await createLivenessRule(center)

    center.onSystemEvent(liveness(601, true)) // seed
    center.onSystemEvent(liveness(601, true)) // no-flip
    // …including the OTHER category that describes the same edge.
    center.onSystemEvent({
      id: 'same-edge-from-runtime-state',
      timestamp: new Date(),
      source: { type: 'device', id: 601 },
      category: 'device.state-changed',
      data: { deviceId: 601, capName: 'device-status', slice: { online: true } },
    })

    center.onSystemEvent(liveness(601, false)) // CONTROL — a real flip

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline'])
  })

  it('a genuine offline → online RECOVERY still notifies — the ledger holds a state that differs', async () => {
    const world = makeNcRecords()
    const center = await startCenter(world)
    await createLivenessRule(center)

    center.onSystemEvent(liveness(602, false)) // seed: offline
    center.onSystemEvent(liveness(602, true)) // the camera comes back — NOTIFY

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-online'])
  })

  it('THE INCIDENT: 15 cameras re-announce online across a RESTART and not one notifies', async () => {
    const world = makeNcRecords()

    // ── First boot: the installation settles, every camera seeds `online`.
    const first = await startCenter(world)
    await createLivenessRule(first)
    for (const deviceId of CAMERA_IDS) first.onSystemEvent(liveness(deviceId, true))
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size ?? 0).toBe(0)
    })
    await first.stop()

    // ── The container is recreated: a NEW centre over the SAME durable store,
    //    and every provider re-announces every camera as online.
    const second = await startCenter(world)
    for (const deviceId of CAMERA_IDS) second.onSystemEvent(liveness(deviceId, true))

    // CONTROL: one camera really does go away after the restart.
    second.onSystemEvent(liveness(607, false))

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline'])
    expect(outboxRows(world)[0]?.['deviceId']).toBe(607)
  })

  it('the ledger survives the restart as DURABLE rows, not as a warm process', async () => {
    const world = makeNcRecords()
    const first = await startCenter(world)
    await createLivenessRule(first)
    first.onSystemEvent(liveness(610, true))
    await vi.waitFor(() => {
      expect(ncTable(world, 'liveness')?.get('device:610')).toMatchObject({
        state: 'online',
      })
    })
    await first.stop()

    // The reseeded centre answers from SQLite alone.
    const second = await startCenter(world)
    second.onSystemEvent(liveness(610, true)) // no-flip
    second.onSystemEvent(liveness(610, false)) // CONTROL — flip

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline'])
  })
})

/**
 * …AND THE FIRST OUTAGE MUST NOT LOOK LIKE A RESTART.
 *
 * ## The bug this pins, end to end
 *
 * 2026-08-13, 21:35 CEST. The operator physically unplugged four cameras.
 * TWO offline notifications arrived:
 *
 * ```
 * 21:35:54  device:104  (hall) offline → flip  → notified
 * 21:36:01  device:103  (porch) offline → SEEDED → silent
 * 21:36:03  device:111 (pranzo) offline → flip  → notified
 * 21:36:16  device:112  (kitchen) offline → SEEDED → silent
 * ```
 *
 * 104 and 111 had a row because they happened to emit a `device.state-changed`
 * earlier that afternoon; 103 and 587 had emitted nothing since the ledger was
 * created, so their FIRST observation ever was the outage — and the ledger's
 * "the first observation seeds" rule (D130, correct against the boot flood)
 * threw the outage away. The ledger only ever learned a subject from an
 * incoming event, so any camera that is quiet until it dies is a camera whose
 * death is silent, indefinitely.
 *
 * ## The fix, and why it CANNOT re-arm the flood
 *
 * The boot reseed also seeds from the device directory, which already holds
 * the device manager's own `online` flag (D132 §3: the authority seeds the
 * mirror at boot; the authority stays the authority).
 *
 * Only devices the directory reports **online** are seeded. That is not a
 * convenience — it is what makes the change one-directional: a row seeded
 * `online` can only ever turn a later `device.offline` into a notification. It
 * can never turn a `device.online` into one, which is the ONLY shape the
 * 2026-08-13 flood had. A device the directory calls offline, or does not
 * describe at all, keeps today's behaviour exactly.
 */
describe('the boot reseed also seeds from the device directory', () => {
  it('THE INCIDENT: a camera that has never spoken, then dies, IS announced', async () => {
    const world = makeNcRecords()
    // The directory knows 103 and it is up — which is precisely what the
    // ledger had no way to learn.
    const center = await startCenter(world, [identity(103, true)])
    await createLivenessRule(center)

    center.onSystemEvent(liveness(103, false)) // unplugged. This is its FIRST event.

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline'])
    expect(outboxRows(world)[0]?.['deviceId']).toBe(103)
  })

  it('the seed can NEVER announce a recovery — only online devices are seeded', async () => {
    const world = makeNcRecords()
    // A directory that reports every camera DOWN is the shape a cold boot
    // would have. Seeding those rows would make each provider re-announcement
    // a phantom "camera online" — the exact flood D130 exists to prevent.
    const center = await startCenter(
      world,
      CAMERA_IDS.map((deviceId) => identity(deviceId, false)),
    )
    await createLivenessRule(center)

    for (const deviceId of CAMERA_IDS) center.onSystemEvent(liveness(deviceId, true))

    // CONTROL: the path is alive — one camera that IS seeded (from its own
    // first observation) then genuinely goes away.
    center.onSystemEvent(liveness(600, false))

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline'])
  })

  it('the seed NEVER overwrites a row the ledger already accepted', async () => {
    const world = makeNcRecords()

    // First boot: 611 is observed offline and the ledger records it.
    const first = await startCenter(world, [identity(611, true)])
    await createLivenessRule(first)
    first.onSystemEvent(liveness(611, false))
    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    await first.stop()

    // The runner respawns. The directory is STALE — it still calls 611 online.
    // The ledger is the authority for what it ACCEPTED, so the stale directory
    // must not overwrite it: if it did, the camera coming back would be a
    // no-flip and the recovery would be lost.
    const second = await startCenter(world, [identity(611, true)])
    second.onSystemEvent(liveness(611, true)) // the real recovery — MUST notify

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(2)
    })
    expect(enqueuedKinds(world)).toEqual(['device-offline', 'device-online'])
  })

  it('a directory that supplies no liveness at all seeds nothing (older wiring)', async () => {
    const world = makeNcRecords()
    const center = await startCenter(world, [identity(612)]) // `online` absent
    await createLivenessRule(center)

    center.onSystemEvent(liveness(612, false)) // first observation → seeded, silent

    // CONTROL: the recovery after that seed is a real flip and DOES notify, so
    // the zero above is a suppression and not a dead path.
    center.onSystemEvent(liveness(612, true))

    await vi.waitFor(() => {
      expect(ncTable(world, 'outbox')?.size).toBe(1)
    })
    expect(enqueuedKinds(world)).toEqual(['device-online'])
  })
})
