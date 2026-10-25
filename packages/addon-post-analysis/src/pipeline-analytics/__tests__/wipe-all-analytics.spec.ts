import type { AddonContext, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { encodeVectorBase64 } from '@camstack/types'
/**
 * Provider integration (design §5.3 + §9): boot the addon, seed a device with a
 * persisted track + its object event + event/track/face media + an unassigned
 * face + a CLIP embedding, PLUS an enrolled (assigned) face and identity media.
 * `wipeAllAnalytics({deviceId})` must:
 *  - drive the widened cascade end-to-end (select tracks < now → cascade),
 *  - wipe the ephemeral track footprint (track, event, embedding, unassigned
 *    face, track/event/face media),
 *  - PRESERVE the enrolled face + `ownerKind:'identity'` media,
 *  - return `tracks: 1` and leave `getKeyEvents` empty.
 */
import { afterEach, describe, expect, it } from 'vitest'
import PipelineAnalyticsAddon from '../index.js'
import { OBJECT_EVENTS_COLLECTION } from '../store/event-store.js'
import { FACES_COLLECTION } from '../store/face-store.js'
import { FACE_MEDIA_OWNER_PREFIX, MEDIA_COLLECTION } from '../store/media-store.js'
import { TRACKS_COLLECTION } from '../store/track-store.js'
import {
  type FakeSettingsStore,
  type FakeStorageProvider,
  makeFakeAddonApi,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeVectorStore,
  makePipelineBootRecordsWorld,
  phase5LedgerEntries,
  seedTracklessEvents,
} from './test-helpers.js'
import type { FakeRecords } from './fake-records.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: (_m: string, _e?: LogExtras) => {},
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: (_t: LogTags) => logger,
  }
  return logger
}

interface BootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly fake: FakeSettingsStore
  readonly storage: FakeStorageProvider
  readonly vectors: ReturnType<typeof makeFakeVectorStore>
  readonly recordsWorld: FakeRecords
}

async function boot(): Promise<BootResult> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const vectors = makeFakeVectorStore()
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
    vectorStore: vectors.client,
  })
  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>()
  const recordsWorld = await makePipelineBootRecordsWorld()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger: silentLogger(),
    records: recordsWorld.records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        allocateDeviceId: async () => {
          throw new Error('no')
        },
        create: async () => {
          throw new Error('no')
        },
        createContext: () => {
          throw new Error('no')
        },
        register: async () => {
          throw new Error('no')
        },
        remove: async () => {},
        decommission: async () => {},
        getAll: async () => [],
        getChildren: async () => [],
      },
    } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {},
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      async readAddonStore() {
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
        return { ...deviceStore.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        deviceStore.set(deviceId, { ...deviceStore.get(deviceId), ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {},
    },
    getNativeProvider: () => {
      throw new Error('no native providers')
    },
    fetchDevice: async () => {
      throw new Error('no devices')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return { addon, fake: settings, storage, vectors, recordsWorld }
}

const DEVICE = 3
const TRACK = 'track-abc'
const SIGLIP_INDEX = 'object-clip-siglip2-b16-224'

async function seedFixture(
  fake: FakeSettingsStore,
  storage: FakeStorageProvider,
  vectors: ReturnType<typeof makeFakeVectorStore>,
  recordsWorld: FakeRecords,
): Promise<void> {
  fake.seed(OBJECT_EVENTS_COLLECTION, [
    {
      id: 'ev-1',
      data: {
        deviceId: DEVICE,
        timestamp: 1000,
        trackId: TRACK,
        className: 'person',
        confidence: 0.9,
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        zones: [],
        state: 'new',
      },
    },
  ])
  const seedMedia = (id: string, ownerKind: string, ownerId: string, path: string): void => {
    fake.seed(MEDIA_COLLECTION, [
      {
        id,
        data: {
          deviceId: DEVICE,
          ownerKind,
          ownerId,
          kind: 'crop',
          timestamp: 1000,
          path,
          sizeBytes: 1,
        },
      },
    ])
    storage.files.set(`eventMedia:${path}`, Buffer.from('x'))
  }
  // D476: an object event's own media is owned by 'object', not 'event'.
  seedMedia('med-event', 'object', 'ev-1', 'p/event.jpg')
  seedMedia('med-track', 'track', TRACK, 'p/track.jpg')
  seedMedia('med-face', 'face', `${FACE_MEDIA_OWNER_PREFIX}${TRACK}`, 'p/face.jpg')
  seedMedia('med-identity', 'identity', 'id-1', 'p/identity.jpg')
  seedTracklessEvents(recordsWorld, FACES_COLLECTION, [
    {
      id: `${FACE_MEDIA_OWNER_PREFIX}${TRACK}`,
      data: {
        deviceId: DEVICE,
        trackId: TRACK,
        timestamp: 1000,
        embedding: [0.1],
        assigned: false,
      },
    },
    {
      id: `enrolled-${TRACK}`,
      data: { deviceId: DEVICE, trackId: TRACK, timestamp: 1000, embedding: [0.2], assigned: true },
    },
  ])
  // The CLIP vector lives in the vector store now, seeded through it.
  // At SigLIP2's real 768 dims, under its real model id: the addon's store
  // declares every CLIP index at its model's dimension before deleting (D649).
  await vectors.client.declareIndex.mutate({ index: SIGLIP_INDEX, dim: 768 })
  await vectors.client.upsert.mutate({
    index: SIGLIP_INDEX,
    items: [
      {
        id: TRACK,
        vector: encodeVectorBase64(Array.from({ length: 768 }, () => 0.1)),
        metadata: {
          deviceId: DEVICE,
          trackId: TRACK,
          timestamp: 1000,
          className: 'person',
          modelId: 'siglip2-b16-224',
          confidence: 0.9,
        },
      },
    ],
  })
  fake.seed(TRACKS_COLLECTION, [
    { id: TRACK, data: { deviceId: DEVICE, className: 'person', firstSeen: 500, lastSeen: 1000 } },
  ])
}

describe('wipeAllAnalytics (provider integration)', () => {
  let booted: BootResult

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
  })

  it('wipes the ephemeral track footprint but keeps enrolled faces + identity media', async () => {
    booted = await boot()
    const { addon, fake, storage, vectors, recordsWorld } = booted
    await seedFixture(fake, storage, vectors, recordsWorld)

    const counts = await addon.wipeAllAnalytics({ deviceId: DEVICE })

    expect(counts.tracks).toBe(1)
    // Ephemeral footprint gone.
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(0)
    expect(vectors.rows.get(SIGLIP_INDEX)?.size ?? 0).toBe(0)
    expect(fake.size(TRACKS_COLLECTION)).toBe(0)
    // Media: only the identity-owned crop survives.
    const media = await fake.client.query.query({ collection: MEDIA_COLLECTION, filter: {} })
    expect(media.map((r) => r.id)).toEqual(['med-identity'])
    expect(storage.files.has('eventMedia:p/identity.jpg')).toBe(true)
    // Faces: only the ENROLLED (assigned) face survives.
    const faces = phase5LedgerEntries({
      records: recordsWorld,
      collection: FACES_COLLECTION,
    })
    expect(faces.map((r) => r.id)).toEqual([`enrolled-${TRACK}`])
    // Key events empty.
    const keyEvents = await addon.getKeyEvents({
      deviceId: DEVICE,
      since: 0,
      until: 2000,
      limit: 50,
    })
    expect(keyEvents).toEqual([])
  })

  it('returns tracks: 0 when the device has no persisted tracks', async () => {
    booted = await boot()
    const counts = await booted.addon.wipeAllAnalytics({ deviceId: 999 })
    expect(counts).toEqual({
      tracks: 0,
      events: 0,
      media: 0,
      faces: 0,
      plates: 0,
      embeddings: 0,
    })
  })
})
