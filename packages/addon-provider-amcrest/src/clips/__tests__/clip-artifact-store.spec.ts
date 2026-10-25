/**
 * The two artifact stores, on one data dir: one algorithm, two sets of bounds,
 * and they must not be the same directory.
 *
 * The service-level test at the bottom exists because nothing else could catch
 * the wiring: a still store handed the MEDIA kind type-checks, passes every
 * store-level test, and then puts every JPEG in the clip scratch — where the
 * eight-file bound throws it away and the media route offers it as
 * `video/mp4`. It reaches the real `createClipService` and needs no camera.
 */
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

import {
  ClipArtifactStore,
  CLIP_SCRATCH_MAX_FILES_PER_DEVICE,
  CLIP_THUMB_EXTENSION,
  CLIP_THUMB_KIND,
  THUMB_MAX_FILES_PER_DEVICE,
} from '../clip-artifact-store.js'
import { createClipService } from '../clip-service.js'

const DEVICE_ID = 3836
const CLIP_KEY = '1790168287-1790168435'

function makeLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amcrest-clips-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function thumbStore(): ClipArtifactStore {
  return new ClipArtifactStore({
    root,
    kind: CLIP_THUMB_KIND,
    extension: CLIP_THUMB_EXTENSION,
    maxFilesPerDevice: THUMB_MAX_FILES_PER_DEVICE,
  })
}

describe('the still store, beside the media scratch', () => {
  it('holds a still for a key the media scratch also holds, without either winning', async () => {
    const media = new ClipArtifactStore({ root })
    const thumbs = thumbStore()
    const clipBytes = Buffer.from('an mp4')
    await writeFile(await media.reserve(DEVICE_ID, CLIP_KEY), clipBytes)
    // (reserve+publish is what `prepareClipFile` does; `put` is the still's.)
    const temp = await media.reserve(DEVICE_ID, CLIP_KEY)
    await writeFile(temp, clipBytes)
    await media.publish(DEVICE_ID, CLIP_KEY, temp)
    await thumbs.put(DEVICE_ID, CLIP_KEY, Buffer.from([0xff, 0xd8, 0xff]))

    expect((await media.read(DEVICE_ID, CLIP_KEY))?.equals(clipBytes)).toBe(true)
    expect((await thumbs.read(DEVICE_ID, CLIP_KEY))?.byteLength).toBe(3)
  })

  it('outlives the media scratch’s file bound', async () => {
    const thumbs = thumbStore()
    const keep = CLIP_SCRATCH_MAX_FILES_PER_DEVICE + 4
    for (let i = 0; i < keep; i += 1) {
      await thumbs.put(
        DEVICE_ID,
        `${String(1_790_000_000 + i)}-${String(1_790_000_100 + i)}`,
        Buffer.from([0xff, 0xd8, i]),
      )
    }
    const names = await readdir(join(root, CLIP_THUMB_KIND, String(DEVICE_ID)))
    // Every one of them, where the media scratch would already have rolled.
    expect(names.filter((n) => n.endsWith(CLIP_THUMB_EXTENSION))).toHaveLength(keep)
  })

  it('evicts oldest-first once ITS own file bound is passed', async () => {
    const small = new ClipArtifactStore({
      root,
      kind: CLIP_THUMB_KIND,
      extension: CLIP_THUMB_EXTENSION,
      maxFilesPerDevice: 2,
    })
    for (let i = 0; i < 4; i += 1) {
      await small.put(
        DEVICE_ID,
        `${String(1_790_000_000 + i)}-${String(1_790_000_100 + i)}`,
        Buffer.from([0xff, 0xd8, i]),
      )
    }
    const names = await readdir(join(root, CLIP_THUMB_KIND, String(DEVICE_ID)))
    expect(names.filter((n) => n.endsWith(CLIP_THUMB_EXTENSION)).length).toBeLessThanOrEqual(2)
    // And it is the NEWEST that survived.
    expect(await small.has(DEVICE_ID, '1790000003-1790000103')).toBe(true)
  })

  it('never dresses a zero-length file as an artifact', async () => {
    const thumbs = thumbStore()
    await mkdir(join(root, CLIP_THUMB_KIND, String(DEVICE_ID)), {
      recursive: true,
    })
    await writeFile(thumbs.pathFor(DEVICE_ID, CLIP_KEY), Buffer.alloc(0))
    expect(await thumbs.has(DEVICE_ID, CLIP_KEY)).toBe(false)
    expect(await thumbs.read(DEVICE_ID, CLIP_KEY)).toBeNull()
  })
})

describe('the service’s still plane really reads the STILL store', () => {
  it('serves a JPEG written under the thumb kind, with no camera anywhere', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01])
    await mkdir(join(root, CLIP_THUMB_KIND, String(DEVICE_ID)), {
      recursive: true,
    })
    await writeFile(
      join(root, CLIP_THUMB_KIND, String(DEVICE_ID), `${CLIP_KEY}${CLIP_THUMB_EXTENSION}`),
      jpeg,
    )
    const service = createClipService({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      dataDir: root,
      logger: makeLogger(),
      // No camera at all: a cached still must never need one.
      resolveCamera: async () => null,
    })
    let status = 0
    let headers: Record<string, string> = {}
    let body: Buffer | null = null
    const res = {
      writeHead: (code: number, given?: Record<string, string>) => {
        status = code
        headers = given ?? {}
      },
      end: (chunk?: Buffer) => {
        body = chunk ?? null
      },
    } as unknown as ServerResponse
    await service.thumbHandler(
      {
        method: 'GET',
        url: `/${String(DEVICE_ID)}/${CLIP_KEY}`,
        headers: {},
      } as unknown as IncomingMessage,
      res,
    )
    await service.dispose()
    // A thumb store pointed at the media kind answers 204 here, because the
    // JPEG is not where it looked — which is exactly the wiring fault this
    // test exists for.
    expect(status).toBe(200)
    expect(headers['content-type']).toBe('image/jpeg')
    expect((body as Buffer | null)?.equals(jpeg)).toBe(true)
  })
})
