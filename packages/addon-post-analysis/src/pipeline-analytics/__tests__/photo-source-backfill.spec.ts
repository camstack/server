/**
 * The VERIFIED backfill of `identity_samples.sourceMediaId` (D643 follow-up).
 *
 * The live dry run of the photo re-enrol pass refused all nine photo samples
 * `no-source`: the column is empty on every one of them. A read-only
 * measurement found each original at `mediaId + 1` (template, then photo, as
 * `enrollPhotoFace` writes them) — but that is an INFERENCE, and writing it as
 * a fact would let the pass re-derive a sample from someone else's photograph.
 * So the candidate is `mediaId + 1` and nothing else, and it is written only
 * when four independent checks agree. Each check is asserted to refuse on its
 * own here.
 */
import { describe, expect, it } from 'vitest'
import {
  backfillPhotoSources,
  type PhotoSourceBackfillDeps,
  type PhotoSourceBackfillSample,
  type SampleMediaRefs,
} from '../photo-source-backfill.js'
import type { MediaOwnerRef } from '../store/media-store.js'

/** A baseline-JPEG header with just enough for `readJpegSize`. */
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ])
}

interface MediaRow {
  readonly owner: MediaOwnerRef
  readonly bytes: Buffer
}

interface LogLine {
  readonly level: 'info' | 'warn'
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface Harness {
  readonly deps: PhotoSourceBackfillDeps
  readonly written: Array<{ sampleId: string; sourceMediaId: number }>
  readonly logs: LogLine[]
  /** The sample table's `sourceMediaId` column, as the store holds it. */
  readonly column: Map<string, number>
}

const IDENTITY = 'id-bob'

function sample(over: Partial<PhotoSourceBackfillSample> = {}): PhotoSourceBackfillSample {
  return { sampleId: 'p1', identityId: IDENTITY, mediaId: 10, ...over }
}

function harness(
  samples: readonly PhotoSourceBackfillSample[],
  media: ReadonlyMap<number, MediaRow>,
  refs: readonly SampleMediaRefs[] = samples.map((s) => ({
    sampleId: s.sampleId,
    ...(s.mediaId !== undefined ? { mediaId: s.mediaId } : {}),
    ...(s.sourceMediaId !== undefined ? { sourceMediaId: s.sourceMediaId } : {}),
  })),
  over: Partial<PhotoSourceBackfillDeps> = {},
): Harness {
  const written: Harness['written'] = []
  const logs: LogLine[] = []
  const column = new Map<string, number>()
  for (const s of samples)
    if (s.sourceMediaId !== undefined) column.set(s.sampleId, s.sourceMediaId)
  const deps: PhotoSourceBackfillDeps = {
    listPhotoSamples: async () => samples,
    listSampleMediaRefs: async () => refs,
    mediaOwner: async (id) => media.get(id)?.owner ?? null,
    mediaBytes: async (id) => media.get(id)?.bytes ?? null,
    writeSourceMediaId: async (sampleId, sourceMediaId) => {
      written.push({ sampleId, sourceMediaId })
      column.set(sampleId, sourceMediaId)
    },
    readSourceMediaId: async (sampleId) => column.get(sampleId) ?? null,
    logger: {
      info: (message, extras) => logs.push({ level: 'info', message, meta: extras?.meta ?? {} }),
      warn: (message, extras) => logs.push({ level: 'warn', message, meta: extras?.meta ?? {} }),
    },
    ...over,
  }
  return { deps, written, logs, column }
}

const OWNED: MediaOwnerRef = { ownerKind: 'identity', ownerId: IDENTITY }
const PHOTO: MediaRow = { owner: OWNED, bytes: jpeg(4032, 3024) }
const TEMPLATE: MediaRow = { owner: OWNED, bytes: jpeg(112, 112) }

describe('backfillPhotoSources', () => {
  it('writes mediaId + 1 when all four checks pass, reads it back, and logs sample + identity', async () => {
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, {})

    expect(h.written).toEqual([{ sampleId: 'p1', sourceMediaId: 11 }])
    expect(result.samples).toEqual([
      {
        sampleId: 'p1',
        identityId: IDENTITY,
        candidate: 11,
        checks: { exists: true, owner: true, dims: true, unreferenced: true },
        outcome: 'backfilled',
      },
    ])
    const line = h.logs.find((l) => l.meta['sampleId'] === 'p1' && l.level === 'info')
    expect(line?.meta['identityId']).toBe(IDENTITY)
    expect(line?.meta['sourceMediaId']).toBe(11)
  })

  it('a dry run evaluates the same checks and writes NOTHING', async () => {
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, { dryRun: true })
    expect(h.written).toEqual([])
    expect(result.samples[0]).toMatchObject({
      candidate: 11,
      checks: { exists: true, owner: true, dims: true, unreferenced: true },
      outcome: 'would-backfill',
    })
  })

  it('refuses a candidate that does not exist', async () => {
    const h = harness([sample()], new Map([[10, TEMPLATE]]))
    const result = await backfillPhotoSources(h.deps, {})
    expect(h.written).toEqual([])
    expect(result.samples[0]).toMatchObject({ outcome: 'refused', checks: { exists: false } })
    expect(h.logs.some((l) => l.level === 'warn' && l.meta['sampleId'] === 'p1')).toBe(true)
  })

  it('refuses a candidate owned by ANOTHER identity', async () => {
    const foreign: MediaRow = {
      owner: { ownerKind: 'identity', ownerId: 'id-carol' },
      bytes: PHOTO.bytes,
    }
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, foreign],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, {})
    expect(h.written).toEqual([])
    expect(result.samples[0]).toMatchObject({
      outcome: 'refused',
      checks: { exists: true, owner: false, dims: true, unreferenced: true },
    })
  })

  it('refuses a candidate owned by something that is not an identity (a face, a track)', async () => {
    const faceOwned: MediaRow = {
      owner: { ownerKind: 'face', ownerId: IDENTITY },
      bytes: PHOTO.bytes,
    }
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, faceOwned],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, {})
    expect(result.samples[0]).toMatchObject({ outcome: 'refused', checks: { owner: false } })
  })

  it('refuses a 112×112 candidate — that is a template, not a photograph', async () => {
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, TEMPLATE],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, {})
    expect(h.written).toEqual([])
    expect(result.samples[0]).toMatchObject({
      outcome: 'refused',
      checks: { exists: true, owner: true, dims: false, unreferenced: true },
    })
  })

  it('refuses bytes that are not a parseable image', async () => {
    const junk: MediaRow = { owner: OWNED, bytes: Buffer.from('not a jpeg') }
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, junk],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, {})
    expect(result.samples[0]).toMatchObject({ outcome: 'refused', checks: { dims: false } })
  })

  it('refuses a candidate another sample already names (as its template or its source)', async () => {
    const asTemplate = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
      [
        { sampleId: 'p1', mediaId: 10 },
        { sampleId: 'other', mediaId: 11 },
      ],
    )
    const r1 = await backfillPhotoSources(asTemplate.deps, {})
    expect(asTemplate.written).toEqual([])
    expect(r1.samples[0]).toMatchObject({
      outcome: 'refused',
      checks: { exists: true, owner: true, dims: true, unreferenced: false },
    })

    const asSource = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
      [
        { sampleId: 'p1', mediaId: 10 },
        { sampleId: 'other', mediaId: 30, sourceMediaId: 11 },
      ],
    )
    const r2 = await backfillPhotoSources(asSource.deps, {})
    expect(asSource.written).toEqual([])
    expect(r2.samples[0]).toMatchObject({ outcome: 'refused', checks: { unreferenced: false } })
  })

  it('skips a sample that already has a source (idempotent) and checks nothing for it', async () => {
    const h = harness(
      [sample({ sourceMediaId: 11 })],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, {})
    expect(h.written).toEqual([])
    expect(result.samples[0]).toMatchObject({
      outcome: 'already-set',
      candidate: null,
      checks: null,
    })
  })

  it('a second run after a successful one writes nothing', async () => {
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
    )
    await backfillPhotoSources(h.deps, {})
    const again = harness(
      [sample({ sourceMediaId: h.column.get('p1') })],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
    )
    await backfillPhotoSources(again.deps, {})
    expect(again.written).toEqual([])
  })

  it('a sample with no template id has no candidate and is refused', async () => {
    const h = harness([sample({ mediaId: undefined })], new Map())
    const result = await backfillPhotoSources(h.deps, {})
    expect(result.samples[0]).toMatchObject({ outcome: 'refused', candidate: null })
  })

  it('a read-back that does not show the value is a FAILURE, not a success', async () => {
    const h = harness(
      [sample()],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
      ]),
      undefined,
      {
        readSourceMediaId: async () => null,
      },
    )
    const result = await backfillPhotoSources(h.deps, {})
    expect(result.samples[0]?.outcome).toBe('failed')
    expect(result.backfilled).toBe(0)
    expect(h.logs.some((l) => l.level === 'warn' && l.meta['sampleId'] === 'p1')).toBe(true)
  })

  it('two samples never both claim one photo in the same run', async () => {
    // p2's template is p1's candidate — so p1's candidate is referenced.
    const h = harness(
      [sample(), sample({ sampleId: 'p2', mediaId: 11 })],
      new Map([
        [10, TEMPLATE],
        [11, PHOTO],
        [12, PHOTO],
      ]),
    )
    const result = await backfillPhotoSources(h.deps, {})
    expect(result.samples.find((s) => s.sampleId === 'p1')?.outcome).toBe('refused')
  })
})
