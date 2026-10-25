import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFakeSettingsStore, mergeSilentLogger } from '../../__tests__/test-helpers.js'
import { OBJECT_EVENTS_COLLECTION } from '../../store/event-store.js'
import { MEDIA_COLLECTION, MediaStore } from '../../store/media-store.js'
import { TRACKS_COLLECTION } from '../../store/track-store.js'
import { forgetMissingMediaRows, type MediaForgetDeps } from '../media-row-forget.js'

const roots = new Set<string>()
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  roots.clear()
})

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'media-forget-'))
  roots.add(root)
  return root
}

function plant(root: string, rel: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), 'jpeg')
}

const DRAINED = (root: string) => ({
  id: 'eventMedia:default',
  type: 'eventMedia',
  mode: 'drain' as const,
  config: { basePath: root },
  nodeId: 'hub',
})
const SSD = {
  id: 'eventMedia:ssd',
  type: 'eventMedia',
  mode: 'active' as const,
  config: { basePath: '/nonexistent-ssd' },
  nodeId: 'hub',
}

function mediaRow(
  id: string,
  deviceId: number,
  kind: string,
  file: string,
  locationId: string | undefined,
  ownerKind = 'track',
  ownerId = `t-${id}`,
) {
  return {
    id,
    data: {
      deviceId,
      ownerKind,
      ownerId,
      kind,
      timestamp: Number(id),
      path: file,
      sizeBytes: 10,
      ...(locationId === undefined ? {} : { locationId }),
    },
  }
}

interface Logged {
  readonly message: string
  readonly deviceId: unknown
}

async function arrange() {
  const root = makeRoot()
  const fake = makeFakeSettingsStore()
  await MediaStore.declare(fake.client)
  // 1443: two absent (thumbnail, keyFrame) + one PRESENT file.
  plant(root, '111/events/track/t-3/thumbnail.jpg')
  fake.seed(MEDIA_COLLECTION, [
    mediaRow('1', 111, 'thumbnail', '111/events/track/t-1/thumbnail.jpg', 'eventMedia:default'),
    mediaRow('2', 111, 'keyFrame', '111/events/track/t-2/keyFrame.jpg', 'eventMedia:default'),
    mediaRow('3', 111, 'thumbnail', '111/events/track/t-3/thumbnail.jpg', 'eventMedia:default'),
    // 3839: one absent, owned by an event that must survive.
    mediaRow(
      '4',
      3839,
      'thumbnail',
      '3839/events/event/e-1/thumbnail.jpg',
      'eventMedia:default',
      'event',
      'e-1',
    ),
    // Another location, file absent everywhere: untouched.
    mediaRow('5', 111, 'thumbnail', '111/events/track/t-5/thumbnail.jpg', 'eventMedia:ssd'),
    // Legacy NULL-location row: never selected.
    mediaRow('6', 111, 'thumbnail', '111/events/track/t-6/thumbnail.jpg', undefined),
    // Retention-exempt owner stamped here: kept.
    mediaRow(
      '7',
      3839,
      'crop',
      '3839/events/identity/i-1/crop.jpg',
      'eventMedia:default',
      'identity',
      'i-1',
    ),
  ])
  fake.seed(TRACKS_COLLECTION, [
    { id: 't-1', data: { deviceId: 111 } },
    { id: 't-2', data: { deviceId: 111 } },
  ])
  fake.seed(OBJECT_EVENTS_COLLECTION, [{ id: 'e-1', data: { deviceId: 3839, mediaId: 4 } }])
  const logged: Logged[] = []
  const logger: IScopedLogger = mergeSilentLogger({
    info: (message, context) => {
      logged.push({ message, deviceId: context?.tags?.['deviceId'] })
    },
  })
  const deps: MediaForgetDeps = {
    listLocations: async () => [DRAINED(root), SSD],
    localNodeId: 'hub',
    store: fake.client,
    logger,
    pace: async () => {},
  }
  return { root, fake, deps, logged }
}

function mediaIds(fake: ReturnType<typeof makeFakeSettingsStore>): string[] {
  return [...(fake.data.get(MEDIA_COLLECTION)?.keys() ?? [])].sort()
}

describe('forgetMissingMediaRows', () => {
  it('dry run reports per device / kind / verdict and writes nothing', async () => {
    const { fake, deps } = await arrange()
    const before = mediaIds(fake)
    const result = await forgetMissingMediaRows(deps, {
      locationId: 'eventMedia:default',
    })

    expect(result.dryRun).toBe(true)
    expect(result.totals).toEqual({
      rows: 5,
      absent: 3,
      present: 1,
      error: 0,
      kept: 1,
      deleted: 0,
    })
    expect(result.absentIds).toEqual([1, 2, 4])
    expect(result.samples.present.map((s) => s.mediaId)).toEqual([3])
    expect(result.samples.kept.map((s) => s.reason)).toEqual(['retention-exempt owner'])
    expect(result.byDevice).toEqual([
      {
        deviceId: 111,
        rows: 3,
        absent: 2,
        present: 1,
        error: 0,
        kept: 0,
        deleted: 0,
      },
      {
        deviceId: 3839,
        rows: 2,
        absent: 1,
        present: 0,
        error: 0,
        kept: 1,
        deleted: 0,
      },
    ])
    expect(result.byKind.find((k) => k.kind === 'keyFrame')?.absent).toBe(1)
    expect(mediaIds(fake)).toEqual(before)
  })

  it('apply forgets ONLY absent rows of the location; parents, present files and other locations survive', async () => {
    const { fake, deps, logged } = await arrange()
    const result = await forgetMissingMediaRows(deps, {
      locationId: 'eventMedia:default',
      dryRun: false,
      expectAbsent: 3,
    })

    expect(result.totals.deleted).toBe(3)
    expect(mediaIds(fake)).toEqual(['3', '5', '6', '7'])
    // No cascade: the parent track and event rows are all still there.
    expect(fake.size(TRACKS_COLLECTION)).toBe(2)
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
    // Every batch line names its camera.
    const batches = logged.filter((l) => l.message.includes('forgot media rows'))
    expect(batches.map((l) => l.deviceId).sort()).toEqual([111, 3839])
  })

  it('restricts to deviceIds', async () => {
    const { fake, deps } = await arrange()
    await forgetMissingMediaRows(deps, {
      locationId: 'eventMedia:default',
      deviceIds: [3839],
      dryRun: false,
      expectAbsent: 1,
    })
    expect(mediaIds(fake)).toEqual(['1', '2', '3', '5', '6', '7'])
  })

  it('a stat error that is not ENOENT keeps the row and reports the errno', async () => {
    const { fake, deps, root } = await arrange()
    const eacces = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })
    const result = await forgetMissingMediaRows(
      {
        ...deps,
        // Judged on the path UNDER the root, by directory: the root is a random
        // `media-forget-XXXXXX`, and a suffix starting with 2 or 3 put "t-2" /
        // "t-3" in every absolute path (a 2-in-62 lottery per run).
        stat: async (p) => {
          const owner = path.relative(root, p).split(path.sep)[3]
          if (owner === 't-2') throw eacces
          const enoent = Object.assign(new Error('missing'), {
            code: 'ENOENT',
          })
          if (owner !== 't-3') throw enoent
        },
      },
      { locationId: 'eventMedia:default', dryRun: false, expectAbsent: 2 },
    )
    expect(result.samples.error).toEqual([
      expect.objectContaining({ mediaId: 2, reason: 'EACCES' }),
    ])
    expect(mediaIds(fake)).toEqual(['2', '3', '5', '6', '7'])
  })

  it('apply refuses without expectAbsent, or with a different count, deleting nothing', async () => {
    const { fake, deps } = await arrange()
    const before = mediaIds(fake)
    await expect(
      forgetMissingMediaRows(deps, {
        locationId: 'eventMedia:default',
        dryRun: false,
      }),
    ).rejects.toThrow(/expectAbsent/)
    await expect(
      forgetMissingMediaRows(deps, {
        locationId: 'eventMedia:default',
        dryRun: false,
        expectAbsent: 2,
      }),
    ).rejects.toThrow(/nothing was deleted/)
    expect(mediaIds(fake)).toEqual(before)
  })

  it('refuses a writable location and a location on another node', async () => {
    const { deps, root } = await arrange()
    await expect(forgetMissingMediaRows(deps, { locationId: 'eventMedia:ssd' })).rejects.toThrow(
      /write target/,
    )
    await expect(
      forgetMissingMediaRows(
        {
          ...deps,
          listLocations: async () => [{ ...DRAINED(root), nodeId: 'agent-1' }, SSD],
        },
        { locationId: 'eventMedia:default' },
      ),
    ).rejects.toThrow(/lives on node/)
  })
})
