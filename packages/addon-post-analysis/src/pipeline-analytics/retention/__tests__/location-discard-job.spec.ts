import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeFakeSettingsStore } from '../../__tests__/test-helpers.js'
import { MEDIA_COLLECTION, MediaStore } from '../../store/media-store.js'
import { TrackAliasStore } from '../../store/track-alias-store.js'
import { TRACKS_COLLECTION, TrackStore } from '../../store/track-store.js'
import { createDiscardJob } from '../location-discard-job.js'
import { assertDiscardAllowed } from '../location-discard-policy.js'
import { wireRetrainFrameLedger } from '../../store/event-ledger-wiring.js'

const planted = new Set<string>()

afterEach(() => {
  for (const dir of planted) rmSync(dir, { recursive: true, force: true })
  planted.clear()
})

function plantRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'discard-job-'))
  planted.add(root)
  for (const cls of ['events', 'high', 'low']) {
    const dir = path.join(root, '104', cls)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${cls}.jpg`), cls)
  }
  return root
}

function exists(root: string, rel: string): boolean {
  try {
    readFileSync(path.join(root, rel))
    return true
  } catch {
    return false
  }
}

const HDD = {
  id: 'eventMedia:default',
  type: 'eventMedia',
  enabled: false,
  config: { basePath: '' },
  nodeId: 'hub',
}

const SSD = {
  id: 'eventMedia:ssd',
  type: 'eventMedia',
  enabled: true,
  config: { basePath: '/media-fast/eventMedia' },
  nodeId: 'hub',
}

describe('assertDiscardAllowed', () => {
  it('refuses a still-writable location', () => {
    expect(() =>
      assertDiscardAllowed({ ...HDD, enabled: true, config: HDD.config }, [HDD, SSD], 'hub'),
    ).toThrow(/refused/)
  })

  it('refuses when the disk lives on another node', () => {
    expect(() =>
      assertDiscardAllowed(
        { ...HDD, nodeId: 'agent-1' },
        [{ ...HDD, nodeId: 'agent-1' }, SSD],
        'hub',
      ),
    ).toThrow(/lives on node/)
  })
})

describe('createDiscardJob', () => {
  it('wipes events/, leaves high/, deletes HDD-only tracks, keeps tracks that still have SSD media', async () => {
    const root = plantRoot()
    const hdd = { ...HDD, config: { basePath: root } }
    const fake = makeFakeSettingsStore()
    await MediaStore.declare(fake.client)
    await TrackStore.declare(fake.client)
    const { ledgers } = await makeAnalyticsWorld()
    const aliasStore = new TrackAliasStore({ aliasLedger: ledgers.trackAliases })
    // D683 review H2/L6: `t-dead` is itself a fusion SURVIVOR — an alias
    // pointing at it must leave when it does, or it dangles forever (never
    // reached by `cascadeDeleteTracks`, since this job never calls it).
    await aliasStore.record(104, 'absorbed-by-dead', 't-dead', 1)
    fake.seed(MEDIA_COLLECTION, [
      {
        id: 'm-dead',
        data: {
          deviceId: 104,
          ownerKind: 'track',
          ownerId: 't-dead',
          kind: 'thumbnail',
          timestamp: 1,
          path: '104/events/dead.jpg',
          sizeBytes: 10,
          locationId: 'eventMedia:default',
        },
      },
      {
        id: 'm-hdd-live',
        data: {
          deviceId: 104,
          ownerKind: 'track',
          ownerId: 't-live',
          kind: 'thumbnail',
          timestamp: 1,
          path: '104/events/live-hdd.jpg',
          sizeBytes: 10,
          locationId: 'eventMedia:default',
        },
      },
      {
        id: 'm-ssd-live',
        data: {
          deviceId: 104,
          ownerKind: 'track',
          ownerId: 't-live',
          kind: 'thumbnail',
          timestamp: 2,
          path: '104/events/live-ssd.jpg',
          sizeBytes: 10,
          locationId: 'eventMedia:ssd',
        },
      },
    ])
    fake.seed(TRACKS_COLLECTION, [
      { id: 't-dead', data: { deviceId: 104 } },
      { id: 't-live', data: { deviceId: 104 } },
    ])
    const cascadedTracks: string[] = []
    const job = createDiscardJob({
      listLocations: async () => [hdd, SSD],
      localNodeId: 'hub',
      store: fake.client,
      retrainFrameLedger: wireRetrainFrameLedger({
        records: (await makeAnalyticsWorld()).world.records,
      }),
      deleteTrackEvents: async (id) => {
        cascadedTracks.push(id)
      },
      deleteTrackAliases: async (id) => {
        await aliasStore.deleteByTracks([id])
      },
      now: () => 1,
      paceMs: 0,
    })
    const started = await job.start({ locationId: 'eventMedia:default' })
    expect(started.started).toBe(true)
    await job.waitForIdle()
    const status = job.status()
    expect(status.phase).toBe('complete')
    expect(status.foldersRemoved).toBe(1)
    expect(status.dbRowsDeleted).toBe(2)
    expect(exists(root, '104/events/events.jpg')).toBe(false)
    expect(exists(root, '104/high/high.jpg')).toBe(true)
    expect(exists(root, '104/low/low.jpg')).toBe(true)
    expect([...(fake.data.get(MEDIA_COLLECTION)?.keys() ?? [])].toSorted()).toEqual(['m-ssd-live'])
    expect([...(fake.data.get(TRACKS_COLLECTION)?.keys() ?? [])].toSorted()).toEqual(['t-live'])
    expect(cascadedTracks).toEqual(['t-dead'])
    expect(await aliasStore.resolve('absorbed-by-dead'), "the dead survivor's alias").toBeNull()
  })

  it('returns alreadyRunning instead of starting a second wipe', async () => {
    const root = plantRoot()
    const hdd = { ...HDD, config: { basePath: root } }
    const fake = makeFakeSettingsStore()
    await MediaStore.declare(fake.client)
    const job = createDiscardJob({
      listLocations: async () => [hdd, SSD],
      localNodeId: 'hub',
      store: fake.client,
      retrainFrameLedger: wireRetrainFrameLedger({
        records: (await makeAnalyticsWorld()).world.records,
      }),
      deleteTrackEvents: async () => undefined,
      now: () => 1,
      paceMs: 50,
    })
    const first = job.start({ locationId: 'eventMedia:default' })
    const second = await job.start({ locationId: 'eventMedia:default' })
    expect(second.alreadyRunning).toBe(true)
    await first
    await job.waitForIdle()
  })

  it('refuses recordings types — those belong to the recorder addon', async () => {
    const fake = makeFakeSettingsStore()
    const job = createDiscardJob({
      listLocations: async () => [
        {
          id: 'recordingsLow:default',
          type: 'recordingsLow',
          enabled: false,
          config: { basePath: '/recordings' },
          nodeId: 'hub',
        },
        {
          id: 'recordingsLow:ssd',
          type: 'recordingsLow',
          enabled: true,
          config: { basePath: '/ssd' },
          nodeId: 'hub',
        },
      ],
      localNodeId: 'hub',
      store: fake.client,
      retrainFrameLedger: wireRetrainFrameLedger({
        records: (await makeAnalyticsWorld()).world.records,
      }),
      deleteTrackEvents: async () => undefined,
      now: () => 1,
      paceMs: 0,
    })
    await expect(job.start({ locationId: 'recordingsLow:default' })).rejects.toThrow(/eventMedia/)
  })
})
