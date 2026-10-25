/**
 * The notification centre's production media read keeps only the rows of the
 * event GENERATION it was asked for (D694, fix round 1 M1/M3).
 *
 * Driven against a REAL `MediaStore` (over the fake settings store and blob
 * storage), because this factory is the one hop where the filter takes effect:
 * the dispatcher and the centre only carry the scope. One `object` owner id,
 * `292786`, holds three records' rows — the one asked about (camera 104, at
 * T0), a later holder of the id on another camera (101), and the leftovers of
 * a failed lockstep delete on the SAME camera at another instant.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeNcOwnerMediaReader } from '../nc-owner-media-reader.js'
import { MediaStore } from '../store/media-store.js'
import { makeFakeSettingsStore, makeFakeStorageProvider, makeSilentLogger } from './test-helpers.js'

const ID = '292786'
const T0 = 1_790_000_000_000

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
}

async function harness(logger: IScopedLogger = makeSilentLogger()): Promise<{
  readonly read: ReturnType<typeof makeNcOwnerMediaReader>
  readonly resolved: string[]
}> {
  const fake = makeFakeSettingsStore()
  const media = new MediaStore({
    storage: makeFakeStorageProvider(),
    store: fake.client,
    logger: makeSilentLogger(),
  })
  await MediaStore.declare(fake.client)
  const put = (
    deviceId: number,
    timestamp: number,
    kind: 'faceCrop' | 'plateCrop',
    text: string,
  ): Promise<number> =>
    media.put({
      deviceId,
      ownerKind: 'object',
      ownerId: ID,
      kind,
      timestamp,
      data: Buffer.from(text),
    })
  await put(104, T0, 'faceCrop', 'asked-record')
  // The SAME instant on purpose, so only the CAMERA tells these two apart. A
  // different kind, because `idx_media_slot` is (ownerKind, ownerId, kind,
  // slotTs) with no deviceId: the same kind at the same instant would UPSERT
  // over the first camera's row (inventory: the media slot index gap).
  await put(101, T0, 'plateCrop', 'other-camera')
  await put(104, T0 - 60_000, 'faceCrop', 'same-camera-leftover')
  await media.put({
    deviceId: 104,
    ownerKind: 'track',
    ownerId: 'k3m9x2v7qa',
    kind: 'thumbnail',
    timestamp: T0,
    data: Buffer.from('survivor-thumb'),
  })
  const resolved: string[] = []
  const read = makeNcOwnerMediaReader({
    media,
    resolveTrackOwnerId: async (trackId) => {
      resolved.push(trackId)
      return 'k3m9x2v7qa'
    },
    logger,
  })
  return { read, resolved }
}

const text = (base64: string): string => Buffer.from(base64, 'base64').toString()

describe('makeNcOwnerMediaReader (D694)', () => {
  it('an object read with a scope returns ONLY the asked generation', async () => {
    const { read } = await harness()
    const files = await read('object', ID, { deviceId: 104, recordAt: T0 })
    expect(files.map((f) => text(f.base64))).toEqual(['asked-record'])
  })

  it('another camera that reused the id gets its own rows, and only those', async () => {
    const { read } = await harness()
    const files = await read('object', ID, { deviceId: 101, recordAt: T0 })
    expect(files.map((f) => text(f.base64))).toEqual(['other-camera'])
  })

  it('an unscoped object read returns nothing and does not list other generations', async () => {
    const { read } = await harness()
    // Overload requires a scope for object; call through a widened alias so
    // the runtime refusal path stays covered.
    const unscoped = read as (
      kind: 'object',
      id: string,
      scope?: { deviceId: number; recordAt: number },
    ) => Promise<readonly { base64: string }[]>
    expect(await unscoped('object', ID)).toHaveLength(0)
  })

  it('a track read resolves the fusion alias and is never camera-scoped', async () => {
    const { read, resolved } = await harness()
    const files = await read('track', 'absorbed-id')
    expect(resolved).toEqual(['absorbed-id'])
    expect(files.map((f) => text(f.base64))).toEqual(['survivor-thumb'])
  })
})

describe('an unscoped object read is said out loud', () => {
  it('ERRORs when an object read arrives without NcEventMediaScope', async () => {
    const lines: LoggedLine[] = []
    const at =
      (level: string) =>
      (message: string, extras?: { tags?: Record<string, unknown> }): void => {
        lines.push({ level, message, deviceId: extras?.tags?.['deviceId'] })
      }
    const logger: IScopedLogger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: () => logger,
      withTags: () => logger,
    }
    const { read } = await harness(logger)
    const unscoped = read as (
      kind: 'object',
      id: string,
      scope?: { deviceId: number; recordAt: number },
    ) => Promise<readonly { base64: string }[]>
    await unscoped('object', ID)
    const refused = lines.filter((l) => l.message.includes('NcEventMediaScope required'))
    expect(refused).toHaveLength(1)
    expect(refused[0]?.level).toBe('error')
  })
})

describe('a refused generation is said out loud', () => {
  it('WARNs, tagged with the camera, when rows of the id are refused', async () => {
    const lines: LoggedLine[] = []
    const at =
      (level: string) =>
      (message: string, extras?: { tags?: Record<string, unknown> }): void => {
        lines.push({ level, message, deviceId: extras?.tags?.['deviceId'] })
      }
    const logger: IScopedLogger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: () => logger,
      withTags: () => logger,
    }
    const { read } = await harness(logger)
    await read('object', ID, { deviceId: 104, recordAt: T0 })
    const refused = lines.filter((l) => l.message.includes('reused event id'))
    expect(refused).toHaveLength(1)
    expect(refused[0]?.level).toBe('warn')
    expect(refused[0]?.deviceId).toBe(104)
  })
})
