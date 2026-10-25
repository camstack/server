/**
 * `PlacementService` — the one seam that answers "which location does this
 * (camera, profile) write to?", and the only place that answer is logged,
 * audited and volume-checked.
 *
 * Every decision carries `tags: { deviceId }`: a placement fault is ALWAYS
 * asked per-camera ("why is 102 on the NAS and 101 on the SSD?"), and a line
 * without the tag cannot answer it.
 *
 * An audit row is written only when the assignment CHANGES. A row per attach
 * would flood the 500-row ring on every boot (N cameras × profiles) and bury
 * the eviction rows that share it.
 */

import { createDurableState, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { RecordingOpsLogAppendInput, RecordingOpsLogSink } from '../addon/ops-log-store.js'
import { PlacementService } from '../addon/placement-service.js'
import {
  EMPTY_PLACEMENT,
  RECORDING_PLACEMENT_KEY,
  type RecordingPlacementBlob,
  RecordingPlacementBlobSchema,
  type RecordingPlacementState,
} from '../addon/placement-store.js'
import type { LocationMarker, VolumeProbeDeps } from '../addon/placement-volume.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'

const SSD: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/mnt/ssd' },
  'active',
)
const NAS: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:nas', type: 'recordings', root: '/mnt/nas' },
  'active',
)

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  return logger as unknown as IScopedLogger
}

/** The same DurableState contract `BaseAddon.state()` hands the addon. */
function makeState(): RecordingPlacementState {
  const blob: Record<string, unknown> = {}
  return createDurableState<RecordingPlacementBlob>({
    key: RECORDING_PLACEMENT_KEY,
    schema: RecordingPlacementBlobSchema,
    fallback: EMPTY_PLACEMENT,
    read: async () => ({ ...blob }),
    write: async (patch) => {
      Object.assign(blob, patch)
    },
  })
}

interface Harness {
  readonly service: PlacementService
  readonly logger: IScopedLogger
  readonly rows: RecordingOpsLogAppendInput[]
  readonly markers: Map<string, LocationMarker>
  readonly alerts: string[]
}

function makeService(
  locations: readonly RecordingsLocation[],
  markers: Map<string, LocationMarker> = new Map(),
  clock?: { now: () => number },
): Harness {
  const logger = makeLogger()
  const rows: RecordingOpsLogAppendInput[] = []
  const alerts: string[] = []
  const opsLog: RecordingOpsLogSink = {
    append: async (input) => {
      rows.push(input)
    },
    list: async () => [],
  }
  const probe: VolumeProbeDeps = {
    readMarker: async (root) => markers.get(root) ?? null,
    writeMarker: async (root, marker) => {
      markers.set(root, marker)
    },
    newVolumeId: () => `vol-${markers.size + 1}`,
  }
  const service = new PlacementService({
    logger,
    locations: () => locations,
    state: makeState(),
    opsLog,
    probe,
    alert: (input) => alerts.push(input.detail),
    ...(clock ? { now: clock.now } : {}),
  })
  return { service, logger, rows, markers, alerts }
}

/** Every location's marker says a different volume than the one remembered —
 *  the shape of "no disk mounted anywhere", observed live on 2026-08-19. */
function breakEveryVolume(markers: Map<string, LocationMarker>): void {
  for (const [root, marker] of markers) {
    markers.set(root, { ...marker, volumeId: `${marker.volumeId}-imposter` })
  }
}

describe('PlacementService.place', () => {
  it('routes by profile exactly as the pure resolver does', async () => {
    const low: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordingsLow:default', type: 'recordingsLow', root: '/mnt/low' },
      'active',
    )
    const h = makeService([SSD, low])
    expect((await h.service.place(101, 'high')).id).toBe('recordings:default')
    expect((await h.service.place(101, 'low')).id).toBe('recordingsLow:default')
  })

  it('logs every decision with tags.deviceId', async () => {
    const h = makeService([SSD])
    await h.service.place(102, 'high')

    const call = vi
      .mocked(h.logger.info)
      .mock.calls.find(([msg]) => String(msg).includes('placement'))
    expect(call).toBeDefined()
    expect(call?.[1]).toMatchObject({ tags: { deviceId: 102 } })
  })

  it('writes an ops-log row the FIRST time a (camera, profile) is placed', async () => {
    const h = makeService([SSD])
    await h.service.place(101, 'high')
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]?.deviceId).toBe(101)
    expect(h.rows[0]?.detail).toContain('recordings:default')
  })

  it('does NOT write a row when the assignment is unchanged (the ring stays for evictions)', async () => {
    const h = makeService([SSD])
    await h.service.place(101, 'high')
    await h.service.place(101, 'high')
    await h.service.place(101, 'high')
    expect(h.rows).toHaveLength(1)
  })

  it('claims an unmarked root once, then verifies it on every later attach', async () => {
    const h = makeService([SSD])
    await h.service.place(101, 'high')
    expect(h.markers.get('/mnt/ssd')).toEqual({
      locationId: 'recordings:default',
      volumeId: 'vol-1',
    })

    await h.service.place(104, 'high')
    // Still one claim — adoption happens once per location, not per camera.
    expect(h.markers.size).toBe(1)
  })

  it('fails the assignment over to a sibling when the volume probe MISMATCHES', async () => {
    const markers = new Map<string, LocationMarker>([
      ['/mnt/ssd', { locationId: 'recordings:default', volumeId: 'vol-original' }],
    ])
    const h = makeService([SSD, NAS], markers)
    await h.service.place(101, 'high')
    h.service.onLocationsChanged()

    // The disk is swapped underneath us: same path, different volume.
    markers.set('/mnt/ssd', { locationId: 'recordings:default', volumeId: 'vol-imposter' })

    const placed = await h.service.place(101, 'high')
    expect(placed.id).toBe('recordings:nas')
    expect(vi.mocked(h.logger.error)).toHaveBeenCalled()
    expect(h.alerts.join(' ')).toContain('/mnt/ssd')
  })

  it('KEEPS the location when the probe mismatches and there is no sibling — never stops the camera', async () => {
    const markers = new Map<string, LocationMarker>([
      ['/mnt/ssd', { locationId: 'recordings:default', volumeId: 'vol-original' }],
    ])
    const h = makeService([SSD], markers)
    await h.service.place(101, 'high')
    h.service.onLocationsChanged()
    markers.set('/mnt/ssd', { locationId: 'recordings:default', volumeId: 'vol-imposter' })

    const placed = await h.service.place(101, 'high')
    expect(placed.id).toBe('recordings:default')
    expect(vi.mocked(h.logger.error)).toHaveBeenCalled()
  })

  it('an UNREADABLE probe changes nothing — a fallible read never destroys the assignment (D49)', async () => {
    const h = makeService([SSD, NAS])
    const service = new PlacementService({
      logger: h.logger,
      locations: () => [SSD, NAS],
      state: makeState(),
      opsLog: { append: async () => undefined, list: async () => [] },
      probe: {
        readMarker: async () => {
          throw new Error('EIO')
        },
        writeMarker: async () => undefined,
        newVolumeId: () => 'vol-x',
      },
    })
    expect((await service.place(101, 'high')).id).toBe('recordings:default')
  })

  it('throws loudly when there is nowhere writable — recording cannot start silently', async () => {
    const h = makeService([recordingsLocationOfMode(SSD, 'readonly')])
    await expect(h.service.place(101, 'high')).rejects.toThrow(/read-only/)
  })
})

/**
 * EVERY location unusable is a TERMINAL state, not a ping-pong.
 *
 * With two locations and no disk mounted (2026-08-19, the UD disk did not come
 * back after the reboot) `failoverForUnusableLocation` handed each attach the
 * OTHER unusable location, because the sibling search never consulted the
 * unusable set. So the stored assignment flipped A→B→A→B forever, and
 * `recordDecision` treated every flip as a change: one durable write plus one
 * ops-log row per attach, per camera, per profile — measured 716 EACCES/min,
 * with the audit ring flooded by the flapping and the real eviction rows buried.
 *
 * What replaces it: one line per camera, a target that does not move, no durable
 * write, and a slow re-probe so a disk that comes back is picked up.
 */
describe('PlacementService — every location unusable', () => {
  function everyLocationBroken(clock?: { now: () => number }): Harness {
    const markers = new Map<string, LocationMarker>()
    const h = makeService([SSD, NAS], markers, clock)
    return { ...h, markers }
  }

  /**
   * Drive the service into the state the live fault settled into: both volumes
   * claimed, both swapped underneath us, and every location actually PROBED.
   *
   * The probe is a claim, not a poll — a failover target is verified on the
   * attach that assigns it, not at the moment of the failover — so reaching
   * "every location unusable" takes one attach per location. Nothing here is
   * scaffolding: it is exactly the sequence a two-disk hub walks when neither
   * disk comes back after a reboot.
   */
  async function reachEveryLocationUnusable(h: Harness): Promise<void> {
    await h.service.place(101, 'high') // claims the SSD
    breakEveryVolume(h.markers)
    h.service.onLocationsChanged()
    await h.service.place(101, 'high') // SSD mismatch → assignment moves to the NAS
    await h.service.place(101, 'high') // …and THIS attach claims the NAS
    // Both roots carry our claim now; assert it before breaking them, so a green
    // test can never come from a probe that never ran.
    expect(h.markers.size).toBe(2)
    breakEveryVolume(h.markers)
    h.service.onLocationsChanged()
    await h.service.place(101, 'high') // probes one
    await h.service.place(101, 'high') // probes the other → terminal
  }

  it('stops flapping: the target does not move once every location has failed', async () => {
    const h = everyLocationBroken()
    await reachEveryLocationUnusable(h)

    const targets: string[] = []
    for (let attach = 0; attach < 6; attach += 1) {
      targets.push((await h.service.place(101, 'high')).id)
    }
    // One value, whatever it is — a writer that alternates between two broken
    // roots is the thing that produced 716 EACCES/min.
    expect(new Set(targets).size).toBe(1)
  })

  it('writes NOTHING durable and audits NOTHING while the state holds', async () => {
    const h = everyLocationBroken()
    await reachEveryLocationUnusable(h)
    const rowsBefore = h.rows.length

    for (let attach = 0; attach < 6; attach += 1) await h.service.place(101, 'high')

    // The mount-fault rows (one per location) are allowed; the per-attach
    // assignment rows are not.
    const flapRows = h.rows
      .slice(rowsBefore)
      .filter((row) => !(row.detail ?? '').includes('volume mismatch'))
    expect(flapRows).toEqual([])
  })

  it('says so ONCE per camera, as a warn carrying tags.deviceId', async () => {
    const h = everyLocationBroken()
    await reachEveryLocationUnusable(h)

    for (let attach = 0; attach < 4; attach += 1) await h.service.place(101, 'high')
    await h.service.place(104, 'high')

    const warned = vi
      .mocked(h.logger.warn)
      .mock.calls.filter(([message]) => /EVERY recordings location/.test(String(message)))
    // Once for 101, once for 104 — a storage fault is asked per-camera.
    expect(warned).toHaveLength(2)
    const tagged = warned.map(([, extras]) => (extras as { tags?: { deviceId?: number } }).tags)
    expect(tagged).toEqual([{ deviceId: 101 }, { deviceId: 104 }])
  })

  it('re-probes on a slow backoff, so a disk that comes back is picked up', async () => {
    let now = 1_000_000
    const h = everyLocationBroken({ now: () => now })
    await reachEveryLocationUnusable(h)
    await h.service.place(101, 'high')

    // The disk is back: both roots agree with what we remembered again.
    for (const [root, marker] of h.markers) {
      h.markers.set(root, { ...marker, volumeId: marker.volumeId.replaceAll('-imposter', '') })
    }

    // Inside the backoff window nothing is re-probed — the memo is the whole
    // point of a claim rather than a poll.
    await h.service.place(101, 'high')
    const warnedInWindow = vi
      .mocked(h.logger.info)
      .mock.calls.filter(([message]) => /re-probing/.test(String(message)))
    expect(warnedInWindow).toHaveLength(0)

    now += 60_001
    const placed = await h.service.place(101, 'high')
    expect(placed.id).toBe('recordings:default')
    const reprobed = vi
      .mocked(h.logger.info)
      .mock.calls.filter(([message]) => /re-probing/.test(String(message)))
    expect(reprobed).toHaveLength(1)
  })

  it('a single location that fails still keeps recording, and still shouts', async () => {
    const markers = new Map<string, LocationMarker>()
    const h = makeService([SSD], markers)
    await h.service.place(101, 'high')
    breakEveryVolume(markers)
    h.service.onLocationsChanged()

    // A shouting recorder beats a stopped camera: the target is still the
    // location, and the mount fault is still an error + an alert.
    expect((await h.service.place(101, 'high')).id).toBe('recordings:default')
    expect(vi.mocked(h.logger.error)).toHaveBeenCalled()
    expect(h.alerts.join(' ')).toContain('/mnt/ssd')
  })
})

describe('PlacementService storage-fault alert surface', () => {
  function build(markers: Map<string, LocationMarker>) {
    const raised: { locationId: string; reason: string }[] = []
    const recovered: string[] = []
    const logger = makeLogger()
    const service = new PlacementService({
      logger,
      locations: () => [SSD],
      state: makeState(),
      opsLog: { append: async () => undefined, list: async () => [] },
      probe: {
        readMarker: async (root) => markers.get(root) ?? null,
        writeMarker: async (root, marker) => {
          markers.set(root, marker)
        },
        newVolumeId: () => 'vol-x',
      },
      alert: (input) => raised.push({ locationId: input.locationId, reason: input.reason }),
      recovered: (locationId) => recovered.push(locationId),
    })
    return { service, raised, recovered, logger }
  }

  it('a volume mismatch raises reason "unusable"; the volume coming back reports it recovered', async () => {
    const markers = new Map<string, LocationMarker>([
      ['/mnt/ssd', { locationId: 'recordings:default', volumeId: 'vol-original' }],
    ])
    const h = build(markers)
    await h.service.place(101, 'high')
    h.service.onLocationsChanged()
    markers.set('/mnt/ssd', { locationId: 'recordings:default', volumeId: 'vol-imposter' })
    await h.service.place(101, 'high')
    expect(h.raised).toEqual([{ locationId: 'recordings:default', reason: 'unusable' }])
    expect(h.recovered).toEqual([])

    // the real disk is back; the next re-resolve + attach verifies it
    markers.set('/mnt/ssd', { locationId: 'recordings:default', volumeId: 'vol-original' })
    h.service.onLocationsChanged()
    await h.service.place(101, 'high')
    expect(h.recovered).toEqual(['recordings:default'])
    // a location that was never faulted does not announce a recovery
    await h.service.place(101, 'high')
    expect(h.recovered).toEqual(['recordings:default'])
  })
})
