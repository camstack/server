/**
 * The face re-embed mechanism against the REAL enrolled gallery.
 *
 * The rows in `fixtures/gallery-2026-08-19.json` are verbatim
 * `pipeline-analytics:identity-samples` from the incident evidence copy
 * (`/mnt/cache/appdata/camstack/db-incident-20260819/camstack-recovered.db`,
 * opened `mode=ro` — never the live database). 28 samples, 4 identities,
 * every one stamped `arcface-r100`.
 *
 * ## Why a fabricated fixture was not good enough
 *
 * Because it already lied. The first version of `faceReembedProgress` derived
 * "this sample can never be re-embedded" from `mediaKey === undefined`, and the
 * hand-written test data agreed with it. These rows do not: exactly ONE of the
 * 28 has a null `mediaKey` — the other 27 carry a well-formed key whose blob is
 * gone (D196 §2, D197). The derivation would have told an operator "1
 * unrecoverable" while deciding whether an AuraFace flip was safe, when the
 * true answer was 27 and the flip would have stranded three of the four people.
 *
 * That is the whole reason these tests exist against real rows: the shape of
 * this data is not what a reasonable person invents.
 */
import { describe, expect, it } from 'vitest'
import realGallery from './fixtures/gallery-2026-08-19.json' with { type: 'json' }
import {
  type FaceReembedSample,
  faceReembedProgress,
  reembedFaceGallery,
} from '../face-reembed-pass.js'

interface RealRow {
  readonly sampleId: string
  readonly identityId: string
  readonly identityName: string
  readonly modelId: string
  readonly dim: number
  readonly mediaKey: string | null
  readonly source: string
  readonly deviceId: number
  readonly addedAt: number
}

const rows: readonly RealRow[] = realGallery

// The evidence copy's `mediaKey` is the pre-D482 composite string key — kept
// verbatim in the fixture as recovered. `FaceReembedSample.mediaId` is now a
// row's own INTEGER id, so a row that HAD a key is given a synthetic one here
// (its index is otherwise meaningless); what the test cares about is presence
// vs. absence, and that shape — one null, 27 non-null — survives unchanged.
const samples: readonly FaceReembedSample[] = rows.map((r, i) => ({
  sampleId: r.sampleId,
  identityId: r.identityId,
  identityName: r.identityName,
  modelId: r.modelId,
  dim: r.dim,
  ...(r.mediaKey !== null ? { mediaId: i + 1 } : {}),
}))

const silent = { info: () => undefined, warn: () => undefined }

/**
 * The measured reality of 2026-08-19/20: the key is there, the blob is not.
 * Only the four samples enrolled on the 20th resolved, and none of those are in
 * this evidence copy — so against THIS snapshot every read misses.
 */
const noBlobsSurvive = async () => null

describe('the real gallery, as it stands', () => {
  it('is 28 samples across 4 identities, every one arcface-r100', () => {
    expect(samples).toHaveLength(28)
    expect(new Set(samples.map((s) => s.modelId))).toEqual(new Set(['arcface-r100']))
    const byName = new Map<string, number>()
    for (const s of samples) byName.set(s.identityName, (byName.get(s.identityName) ?? 0) + 1)
    expect([...byName.entries()].toSorted()).toEqual([
      ['Alice', 10],
      ['Bob', 2],
      ['Carol', 7],
      ['Dave', 9],
    ])
  })

  it('has ONE null mediaKey and 27 keys — the shape that broke the obvious heuristic', () => {
    expect(rows.filter((r) => r.mediaKey === null)).toHaveLength(1)
    expect(rows.filter((r) => r.mediaKey !== null)).toHaveLength(27)
  })
})

describe('a pass with the CURRENT model is a declared no-op, on the real rows', () => {
  it('touches no media and reports the whole gallery already in space', async () => {
    let reads = 0
    const out = await reembedFaceGallery(
      {
        listSamples: async () => samples,
        loadAlignedCrop: async () => {
          reads += 1
          return null
        },
        embed: async () => {
          throw new Error('a no-op pass must never dispatch')
        },
        store: async () => {
          throw new Error('a no-op pass must never write')
        },
        pause: async () => undefined,
        logger: silent,
      },
      { targetModelId: 'arcface-r100' },
    )
    expect(out).toMatchObject({
      total: 28,
      alreadyInSpace: 28,
      reembedded: 0,
      noPixels: 0,
      failed: 0,
      remaining: 0,
      complete: true,
    })
    // The proof it read the right state rather than simply doing nothing: the
    // two are indistinguishable in the gallery afterwards.
    expect(reads).toBe(0)
  })
})

describe('a pass into a NEW model space, on the real rows', () => {
  it('finds every sample unrecoverable — which is exactly why the flip is still blocked', async () => {
    const out = await reembedFaceGallery(
      {
        listSamples: async () => samples,
        loadAlignedCrop: noBlobsSurvive,
        embed: async () => {
          throw new Error('nothing can be embedded without pixels')
        },
        store: async () => {
          throw new Error('nothing can be written without a vector')
        },
        pause: async () => undefined,
        logger: silent,
      },
      { targetModelId: 'auraface-r100' },
    )
    expect(out).toMatchObject({
      total: 28,
      alreadyInSpace: 0,
      reembedded: 0,
      noPixels: 28,
      failed: 0,
      noCapableNode: 0,
      // Complete: the pass did everything it COULD. A pixel-less gallery is not
      // a stuck pass, and reporting it as one would send the operator hunting a
      // fault in the pass instead of in the media.
      complete: true,
    })
    expect(out.pixellessSampleIds).toHaveLength(28)
  })

  it('re-embeds exactly the samples whose blob DOES survive, and leaves the rest counted', async () => {
    // Models the live situation of 2026-08-20: only the freshly-enrolled crops
    // resolve. Here: the four most recent rows of the evidence copy stand in for
    // them, so the assertion is about the pass's selection, not about which four.
    const recoverable = new Set(rows.slice(-4).map((r) => r.sampleId))
    const embedded: string[] = []
    const written: Array<{ sampleId: string; modelId: string }> = []
    const out = await reembedFaceGallery(
      {
        listSamples: async () => samples,
        loadAlignedCrop: async (s) =>
          recoverable.has(s.sampleId) ? Buffer.from('aligned-112x112') : null,
        embed: async (s) => {
          embedded.push(s.sampleId)
          return { kind: 'embedded', embedding: new Array(512).fill(0.01), dim: 512 }
        },
        store: async (s, _e, modelId) => {
          written.push({ sampleId: s.sampleId, modelId })
          return { landed: true }
        },
        pause: async () => undefined,
        logger: silent,
      },
      { targetModelId: 'auraface-r100' },
    )
    expect(new Set(embedded)).toEqual(recoverable)
    expect(written.every((w) => w.modelId === 'auraface-r100')).toBe(true)
    expect(out).toMatchObject({ reembedded: 4, noPixels: 24, total: 28, complete: true })
  })

  it('is RESUMABLE: two budgeted passes cover what one unbounded pass would', async () => {
    const recoverable = new Set(rows.slice(-6).map((r) => r.sampleId))
    const done = new Set<string>()
    const run = (max: number) =>
      reembedFaceGallery(
        {
          listSamples: async () =>
            samples.map((s) => (done.has(s.sampleId) ? { ...s, modelId: 'auraface-r100' } : s)),
          loadAlignedCrop: async (s) => (recoverable.has(s.sampleId) ? Buffer.from('px') : null),
          embed: async () => ({ kind: 'embedded', embedding: [0.1], dim: 1 }),
          store: async (s) => {
            done.add(s.sampleId)
            return { landed: true }
          },
          pause: async () => undefined,
          logger: silent,
        },
        { targetModelId: 'auraface-r100', maxSamples: max },
      )

    const first = await run(4)
    expect(first).toMatchObject({ reembedded: 4, complete: false })
    const second = await run(4)
    // The second pass sees the first four as already in space and finishes the
    // remaining two — no sample is embedded twice.
    expect(second).toMatchObject({ alreadyInSpace: 4, reembedded: 2, complete: true })
    expect(done.size).toBe(6)
  })
})

describe('the flip-safety number, measured on the real gallery', () => {
  it('reports 0/28 in the AuraFace space and names every identity at zero', () => {
    const p = faceReembedProgress(samples, 'auraface-r100')
    expect(p).toMatchObject({ modelId: 'auraface-r100', inSpace: 0, total: 28 })
    expect(p.byIdentity.every((i) => i.inSpace === 0)).toBe(true)
    // Every one of the four would be below `minIdentitySamples` = 2.
    expect(p.byIdentity.map((i) => i.name).toSorted()).toEqual(['Alice', 'Bob', 'Carol', 'Dave'])
  })

  it('does NOT guess `unrecoverable` from the mediaKey — the real rows would make it say 1 of 27', () => {
    const unmeasured = faceReembedProgress(samples, 'auraface-r100')
    // Un-probed: only the single genuinely-keyless row is known unrecoverable.
    // That number is NOT a claim about the other 27, and the caller must not
    // render it as one.
    expect(unmeasured.unrecoverable).toBe(1)

    // Probed — the pass's own observation, which is the truth.
    const probed = faceReembedProgress(
      samples,
      'auraface-r100',
      new Set(rows.map((r) => r.sampleId)),
    )
    expect(probed.unrecoverable).toBe(28)
  })

  it('is a full 28/28 against the model the gallery is ACTUALLY in', () => {
    const p = faceReembedProgress(samples, 'arcface-r100')
    expect(p).toMatchObject({ inSpace: 28, total: 28, unrecoverable: 0 })
  })
})
