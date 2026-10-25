/**
 * IdentityStore — per-person identity registry for face recognition.
 *
 * Two SQL-backed collections:
 *   - pipeline-analytics:identities         — named identity records
 *   - pipeline-analytics:identity-samples   — face embeddings (Task 2)
 *
 * Provides identity CRUD (create / rename / delete / list).
 * deleteIdentity cascades: queries + deletes all sample rows for the
 * identity (best-effort per row) before removing the identity record.
 *
 * Sample ingestion (addSample) and gallery loading (loadGallery) are
 * implemented in Task 2.
 */

import { randomUUID } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import { type FaceAlignmentVersion, parseFaceAlignment } from '../face-alignment-version.js'
import type { PhotoReenrolSample } from '../face-photo-reenrol-pass.js'
import type { FaceReembedSample } from '../face-reembed-pass.js'
import type { PhotoBbox } from '../photo-enrollment.js'
import type { SampleMediaRefs } from '../photo-source-backfill.js'
import type { GallerySample } from '../pipeline/face-matcher.js'
import type { EmbeddingConversionSpec } from './embedding-json-conversion.js'
import { type EmbeddingVectorIndex, IDENTITY_VECTOR_CLASS } from './embedding-vector-index.js'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="one row per person the OPERATOR creates by name. Updated on rename, and
 *     on every sample add or remove (sampleCount, coverMediaId). Nothing in the
 *     pipeline ever creates one — an identity exists independently of any
 *     observation of it."
 *   retention="none — no sweep and no cap touch this table. A row goes only on an
 *     explicit deleteIdentity, which removes the identity's samples first. Bounded
 *     solely by how many people the operator chooses to enrol. Losing it un-enrols
 *     everybody and every face falls back to unrecognised."
 */
import { IDENTITY_SAMPLES_COLLECTION } from './pa-collection-names.js'

export { IDENTITIES_COLLECTION, IDENTITY_SAMPLES_COLLECTION } from './pa-collection-names.js'

/** One gallery sample, identity only — see {@link IdentityStore.galleryManifest}. */
export interface GalleryManifestEntry {
  readonly sampleId: string
  readonly identityId: string
  readonly modelId: string
}

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per face the operator ENROLS onto an identity — the ArcFace
 *     embedding plus its modelId and dim, taken either from a detected face in the
 *     buffer or from an uploaded photo. This table IS the matching gallery
 *     loadGallery reads at boot."
 *   retention="none, by explicit exemption — RETENTION_EXEMPT_FAMILIES lists the
 *     whole table, and the classification registry marks it never-orphaned: a
 *     sample carries track-shaped provenance but is NOT owned by it, and deleting
 *     one because a track aged out would silently degrade recognition rather than
 *     just history. Rows go only on removeSample or deleteIdentity. Bounded solely
 *     by operator enrolment."
 */
/** How many torn samples one gallery-load warning names (D651). */
const TORN_SAMPLES_LOGGED = 5

export const IDENTITY_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'name', type: 'TEXT' as const, notNull: true },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'sampleCount', type: 'INTEGER' as const, notNull: true },
  { name: 'coverMediaId', type: 'INTEGER' as const },
] as const

export const SAMPLE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'identityId', type: 'TEXT' as const, notNull: true },
  /**
   * LEGACY, drained on 2026-08-30 (D304). The ArcFace vector lives in the
   * `identity-arcface` vector index now, keyed by this row's id.
   *
   * Still declared and still `notNull`: rows written before the conversion carry
   * their array, and `loadGallery` falls back to it for exactly as long as one
   * of them has not been converted. A CONVERTED row holds `[]`, which is both
   * the idempotence marker and the only way to see the conversion is done.
   */
  { name: 'embedding', type: 'JSON' as const, notNull: true },
  { name: 'mediaId', type: 'INTEGER' as const },
  /**
   * The ORIGINAL photograph a `source: 'photo'` sample was cut from.
   *
   * `mediaId` is the ALIGNED 112x112 template — the literal model input, and
   * the only thing a re-embed pass may send (D199). This is the master beside
   * it: the reloadable original, which is the entire reason a photo-built
   * gallery survives a model change that a crop-built one cannot (D196, D197).
   * On a `source: 'detected'` row it is the FULL FRAME the face was detected
   * on, moved to the identity at enrolment (D644); absent on detected rows
   * enrolled before that, whose frame did not outlive footage retention.
   */
  { name: 'sourceMediaId', type: 'INTEGER' as const },
  { name: 'source', type: 'TEXT' as const, notNull: true },
  /**
   * Which face ALIGNMENT produced `mediaId`'s template — `'scrfd-v2'` for every
   * sample written after the SCRFD fix, NULL (v1) for every one before (D643).
   * Audit-only: matching ignores it; the prune and the photo re-enrol pass read
   * it. See `face-alignment-version.ts`.
   */
  { name: 'alignment', type: 'TEXT' as const },
  /**
   * The face's rectangle IN THE ORIGINAL PHOTOGRAPH (`sourceMediaId`), for
   * `source: 'photo'` rows written since D643. It is what lets a later re-enrol
   * pick the same face out of a family photo by IoU instead of by cosine.
   * NULL on detected rows and on photo rows written before it existed.
   */
  { name: 'sourceBbox', type: 'JSON' as const },
  /**
   * The five landmarks IN `sourceMediaId`'s pixel space, for detected rows
   * enrolled since D644 when the runner reported them. NULL otherwise.
   */
  { name: 'sourceLandmarks', type: 'JSON' as const },
  /**
   * On a sample the gallery reset RE-ALIGNED from an old template (D644): the
   * id of the v1 sample it replaces. A rerun after a crash reads it to finish
   * the removal instead of re-aligning the same template twice. Not
   * `sourceMediaId`: that names a blob, and the old template it would name is
   * deleted with the old sample. NULL everywhere else.
   */
  { name: 'replacesSampleId', type: 'TEXT' as const },
  { name: 'deviceId', type: 'INTEGER' as const },
  { name: 'modelId', type: 'TEXT' as const, notNull: true },
  { name: 'dim', type: 'INTEGER' as const, notNull: true },
  { name: 'addedAt', type: 'INTEGER' as const, notNull: true },
] as const

export interface Identity {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly sampleCount: number
  readonly coverMediaId?: number
}

/**
 * One enrolled sample WITHOUT its vector.
 *
 * The vector lives in `identity-arcface`, keyed by `id`. It is not a field for
 * the same reason `Face` has none: every caller but the gallery loader wants
 * the metadata, and a shape that carries 512 floats is a shape that gets read
 * in bulk by something that does not need them.
 */
export interface IdentitySample {
  readonly id: string
  readonly identityId: string
  readonly mediaId?: number
  /** The original photograph, for `source: 'photo'` rows. See SAMPLE_COLUMNS. */
  readonly sourceMediaId?: number
  readonly source: 'detected' | 'photo'
  readonly deviceId?: number
  readonly modelId: string
  readonly dim: number
  readonly addedAt: number
  /** Absent = v1 (written before the SCRFD fix). See SAMPLE_COLUMNS. */
  readonly alignment?: FaceAlignmentVersion
  /** The face's box in the original photo. See SAMPLE_COLUMNS. */
  readonly sourceBbox?: PhotoBbox
  /** The five landmarks in `sourceMediaId`'s pixel space. See SAMPLE_COLUMNS. */
  readonly sourceLandmarks?: readonly SamplePoint[]
  /** The v1 sample a reset replacement replaces. See SAMPLE_COLUMNS. */
  readonly replacesSampleId?: string
}

/** A pixel-space point on a sample's source image. */
export interface SamplePoint {
  readonly x: number
  readonly y: number
}

/** One row of the prune's projected read. */
export interface IdentityPruneRow {
  readonly id: string
  readonly source: 'detected' | 'photo'
  readonly deviceId?: number
  readonly alignment?: FaceAlignmentVersion
}

/** What `addSample` takes. The vector is written to the index, never the row. */
export interface AddIdentitySampleInput {
  readonly identityId: string
  readonly embedding: readonly number[]
  readonly mediaId?: number
  readonly sourceMediaId?: number
  readonly modelId: string
  readonly source?: 'detected' | 'photo'
  readonly deviceId?: number
  readonly alignment?: FaceAlignmentVersion
  readonly sourceBbox?: PhotoBbox
  readonly sourceLandmarks?: readonly SamplePoint[]
  readonly replacesSampleId?: string
}

/** One row of `listSamples` — the metadata, never the vector. */
export type IdentitySampleSummary = Pick<
  IdentitySample,
  | 'id'
  | 'mediaId'
  | 'sourceMediaId'
  | 'source'
  | 'addedAt'
  | 'deviceId'
  | 'modelId'
  | 'alignment'
  | 'sourceBbox'
  | 'sourceLandmarks'
  | 'replacesSampleId'
>

/** Narrow a stored `sourceBbox` JSON value; anything malformed reads as absent. */
function parseSourceBbox(value: unknown): PhotoBbox | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const x: unknown = Reflect.get(value, 'x')
  const y: unknown = Reflect.get(value, 'y')
  const width: unknown = Reflect.get(value, 'width')
  const height: unknown = Reflect.get(value, 'height')
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return undefined
  }
  return { x, y, width, height }
}

/** Narrow a stored `sourceLandmarks` JSON value; anything malformed reads as absent. */
function parseSourceLandmarks(value: unknown): readonly SamplePoint[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out: SamplePoint[] = []
  for (const p of value) {
    if (typeof p !== 'object' || p === null) return undefined
    const x: unknown = Reflect.get(p, 'x')
    const y: unknown = Reflect.get(p, 'y')
    if (typeof x !== 'number' || typeof y !== 'number') return undefined
    out.push({ x, y })
  }
  return out
}

/**
 * The untyped row shape `loadGallery` narrows.
 *
 * An index signature over `unknown` rather than a cast: the store returns
 * untyped rows at a documented boundary, and `embedding` is a column that is no
 * longer part of {@link IdentitySample} but is still present on unconverted
 * rows — so it has to be named somewhere, and this is the one place.
 */
interface GalleryRowFields {
  readonly identityId?: unknown
  readonly modelId?: unknown
  readonly embedding?: unknown
}

export interface IdentityStoreDeps {
  /** The `identity-arcface` index — the enrolled gallery's vectors. REQUIRED. */
  readonly vectors: EmbeddingVectorIndex
  readonly logger: IScopedLogger
  readonly identityLedger: EventLedgerCollection
  readonly sampleLedger: EventLedgerCollection
}

export class IdentityStore {
  private readonly vectors: EmbeddingVectorIndex
  private readonly logger: IScopedLogger
  private readonly identityLedger: EventLedgerCollection
  private readonly sampleLedger: EventLedgerCollection

  constructor(deps: IdentityStoreDeps) {
    this.vectors = deps.vectors
    this.logger = deps.logger
    this.identityLedger = deps.identityLedger
    this.sampleLedger = deps.sampleLedger
  }

  /**
   * How an UNCONVERTED `identity-samples` row becomes an index row.
   *
   * `modelId` is `notNull` on this collection, so unlike the faces buffer there
   * is nothing to infer — a row that somehow holds no model is REFUSED and
   * keeps its JSON. An enrolled vector stamped with a guessed model is a sample
   * the matcher would compare across feature spaces, which is the one mistake
   * this gallery cannot survive.
   */
  conversionSpec(): EmbeddingConversionSpec {
    const sampleLedger = this.sampleLedger
    return {
      collection: IDENTITY_SAMPLES_COLLECTION,
      vectors: this.vectors,
      pageRows: (limit, offset) =>
        sampleLedger.query({ orderBy: { field: 'id', direction: 'asc' }, limit, offset }, [
          'identityId',
          'modelId',
          'embedding',
          'addedAt',
          'source',
          'deviceId',
        ]),
      drainEmbedding: (id) => sampleLedger.update(id, { embedding: [] }),
      write: (id, embedding, data) => {
        const modelId = data['modelId']
        if (typeof modelId !== 'string' || modelId.length === 0) return null
        const identityId = data['identityId']
        const deviceId = data['deviceId']
        const addedAt = data['addedAt']
        const source = data['source']
        return {
          id,
          embedding,
          className: IDENTITY_VECTOR_CLASS,
          modelId,
          timestamp: typeof addedAt === 'number' ? addedAt : 0,
          ...(typeof deviceId === 'number' ? { deviceId } : {}),
          extra: {
            ...(typeof identityId === 'string' ? { identityId } : {}),
            ...(typeof source === 'string' ? { source } : {}),
          },
        }
      },
    }
  }

  async createIdentity(input: { readonly name: string }): Promise<Identity> {
    const now = Date.now()
    const identity: Identity = {
      id: randomUUID(),
      name: input.name,
      createdAt: now,
      updatedAt: now,
      sampleCount: 0,
    }
    const { id, ...rest } = identity
    await this.identityLedger.upsertRow(id, rest as Record<string, unknown>)
    return identity
  }

  async renameIdentity(id: string, name: string): Promise<void> {
    await this.identityLedger.update(id, { name, updatedAt: Date.now() })
  }

  async deleteIdentity(id: string): Promise<void> {
    // Cascade: remove all sample rows for this identity first (best-effort),
    // then delete the identity record itself.
    const samples = await this.sampleLedger.query({ where: { identityId: id } })
    const droppedSamples: string[] = []
    for (const s of samples) {
      try {
        await this.sampleLedger.deleteKey(s.id)
        droppedSamples.push(s.id)
      } catch (err) {
        this.logger.warn('deleteIdentity sample delete failed', {
          meta: { identityId: id, sampleId: s.id, error: String(err) },
        })
      }
    }
    // Vectors of the rows that actually went — a row whose delete threw is still
    // in the gallery and still needs its vector.
    await this.vectors.drop(droppedSamples)
    await this.identityLedger.deleteKey(id)
  }

  /**
   * `identityId → name` for exactly the identities asked about.
   *
   * The decorating half of a face or plate page needs a NAME per referenced
   * identity, and it used to get it by reading the whole `identities`
   * collection — unbounded, unprojected, on every 30 s poll of
   * `faceGallery.listRecentFaces`, and again on every `getFaceByTrack`. The
   * table is small (4 rows on the live hub on 2026-08-31) so the bytes were
   * never the problem; the SHAPE was. It is a second question whose cost is
   * proportional to a collection, asked on a timer, to answer a question about
   * a page — and it carried no `limit`, so past
   * `SETTINGS_QUERY_DEFAULT_ROW_CAP` it would have handed back a name map
   * missing entries, shape-identical to a complete one (D320).
   *
   * **An empty request costs no round trip at all.** With
   * `filter: 'unassigned'` — the view the operator lives in — a page
   * references no identity, and the honest number of queries for that is zero.
   * `whereIn` with an empty list matches nothing, so asking anyway would be an
   * RPC to be told what the caller already knew.
   *
   * A cache belongs in the owner of the fact, and this store IS the owner —
   * but a name here changes only when the operator renames, through this same
   * store, and the read is now one indexed `IN` over at most a page's worth of
   * ids. There is nothing left to cache that would not be a second authority
   * over a fact one round trip away (D224).
   */
  async namesFor(identityIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(identityIds)]
    if (ids.length === 0) return new Map()
    const rows = await this.identityLedger.query({ whereIn: { id: ids }, limit: ids.length }, [
      'name',
    ])
    const names = new Map<string, string>()
    for (const r of rows) {
      const name = r.data['name']
      if (typeof name === 'string') names.set(r.id, name)
    }
    return names
  }

  async listIdentities(): Promise<readonly Identity[]> {
    const rows = await this.identityLedger.query({
      orderBy: { field: 'createdAt', direction: 'asc' },
    })
    return rows.map((r) => {
      // Normalize SQL NULL → undefined: the Identity schema's optional number
      // rejects null, so a raw spread of an unset coverMediaId breaks
      // faceGallery.listIdentities output validation (empty People list).
      const data = r.data as Omit<Identity, 'id'> & { coverMediaId?: number | null }
      return { id: r.id, ...data, coverMediaId: data.coverMediaId ?? undefined }
    })
  }

  /**
   * The gallery's IDENTITY of the moment — sample id, owner and model of every
   * sample, no vectors. What the rescore change detector hashes; projected so a
   * periodic look costs a few narrow columns, not the gallery's floats.
   */
  async galleryManifest(): Promise<readonly GalleryManifestEntry[]> {
    const rows = await this.sampleLedger.query({}, ['identityId', 'modelId'])
    const out: GalleryManifestEntry[] = []
    for (const r of rows) {
      const identityId = r.data['identityId']
      const modelId = r.data['modelId']
      if (typeof identityId === 'string' && typeof modelId === 'string') {
        out.push({ sampleId: r.id, identityId, modelId })
      }
    }
    return out
  }

  async addSample(input: AddIdentitySampleInput): Promise<IdentitySample> {
    const sample: IdentitySample = {
      id: randomUUID(),
      identityId: input.identityId,
      ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
      ...(input.sourceMediaId !== undefined ? { sourceMediaId: input.sourceMediaId } : {}),
      source: input.source ?? 'detected',
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      modelId: input.modelId,
      dim: input.embedding.length,
      addedAt: Date.now(),
      ...(input.alignment !== undefined ? { alignment: input.alignment } : {}),
      ...(input.sourceBbox !== undefined ? { sourceBbox: input.sourceBbox } : {}),
      ...(input.sourceLandmarks !== undefined ? { sourceLandmarks: input.sourceLandmarks } : {}),
      ...(input.replacesSampleId !== undefined ? { replacesSampleId: input.replacesSampleId } : {}),
    }
    // The VECTOR before the row. An enrolment whose vector did not land is a
    // person the matcher will never recognise, and the operator must not be told
    // it worked: the row is refused rather than written half-enrolled.
    const indexed = await this.vectors.put({
      id: sample.id,
      embedding: input.embedding,
      className: IDENTITY_VECTOR_CLASS,
      modelId: input.modelId,
      timestamp: sample.addedAt,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      extra: { identityId: input.identityId, source: sample.source },
    })
    if (!indexed) {
      throw new Error(
        `identity sample was not enrolled: its ${input.embedding.length}-dim vector could not be written to the gallery index`,
      )
    }
    const { id, ...rest } = sample
    try {
      await this.sampleLedger.upsertRow(id, {
        ...rest,
        embedding: [],
      } as Record<string, unknown>)
    } catch (err: unknown) {
      // The vector went in first; a row that did not follow leaves it naming a
      // sample nobody can list. Take it back out before reporting the failure.
      await this.vectors.drop([sample.id]).catch(() => undefined)
      throw err
    }
    // Bump the parent identity: sampleCount + updatedAt; set cover on first sample.
    const identity = (await this.listIdentities()).find((i) => i.id === input.identityId)
    if (identity) {
      const patch: Record<string, unknown> = {
        sampleCount: identity.sampleCount + 1,
        updatedAt: Date.now(),
      }
      // `== null` (not `=== undefined`): a freshly-created identity stores
      // coverMediaId as SQL NULL, so `=== undefined` never matched and the cover
      // was never set on the first sample (empty avatar in People).
      // `sampleCount === 0` heals a stale cover left by an emptied gallery: the
      // first fresh sample always becomes the face the operator sees.
      if (
        (identity.coverMediaId == null || identity.sampleCount === 0) &&
        input.mediaId !== undefined
      ) {
        patch['coverMediaId'] = input.mediaId
      }
      await this.identityLedger.update(input.identityId, patch)
    }
    return sample
  }

  /**
   * List all samples for a given identity, returning metadata needed by
   * FaceGalleryProvider to build `IdentitySampleInfo` (no embedding exposed).
   */
  async listSamples(identityId: string): Promise<readonly IdentitySampleSummary[]> {
    const rows = await this.sampleLedger.query({
      where: { identityId },
      orderBy: { field: 'addedAt', direction: 'asc' },
    })
    return rows.map((r) => {
      const d = r.data as Partial<IdentitySample>
      const alignment = parseFaceAlignment(r.data['alignment'])
      const sourceBbox = parseSourceBbox(r.data['sourceBbox'])
      const sourceLandmarks = parseSourceLandmarks(r.data['sourceLandmarks'])
      return {
        id: r.id,
        source: (d.source ?? 'detected') as 'detected' | 'photo',
        addedAt: Number(d.addedAt ?? 0),
        // The feature space this sample lives in. Carried because a caller
        // comparing samples MUST refuse across models (`identity-audit.ts`),
        // and a missing stamp has to read as "not the cluster's model" rather
        // than silently pass the gate.
        modelId: String(d.modelId ?? ''),
        // `!= null`, not `!== undefined`: the relational store surfaces an
        // unset column as SQL NULL, and a null id would be handed to a blob
        // read that can only fail — the same trap `coverMediaId` fell into.
        ...(d.mediaId != null ? { mediaId: d.mediaId } : {}),
        ...(d.sourceMediaId != null ? { sourceMediaId: d.sourceMediaId } : {}),
        ...(d.deviceId != null ? { deviceId: d.deviceId } : {}),
        ...(alignment !== undefined ? { alignment } : {}),
        ...(sourceBbox !== undefined ? { sourceBbox } : {}),
        ...(sourceLandmarks !== undefined ? { sourceLandmarks } : {}),
        ...(typeof d.replacesSampleId === 'string' ? { replacesSampleId: d.replacesSampleId } : {}),
      }
    })
  }

  /**
   * Every sample that can be RE-DERIVED from a stored source: every photo
   * sample, plus every detected sample that names its source frame (D644).
   * The source re-enrol pass reads this; the photo backfill and the automatic
   * trigger keep reading {@link listPhotoSamplesForReenrol}.
   */
  async listSourcedSamplesForReenrol(): Promise<readonly PhotoReenrolSample[]> {
    const photos = await this.listPhotoSamplesForReenrol()
    const names = new Map((await this.listIdentities()).map((i) => [i.id, i.name]))
    const detectedRows = await this.sampleLedger.query({ where: { source: 'detected' } })
    const detected: PhotoReenrolSample[] = []
    for (const r of detectedRows) {
      const identityId = r.data['identityId']
      const modelId = r.data['modelId']
      const sourceMediaId = r.data['sourceMediaId']
      if (typeof identityId !== 'string' || typeof modelId !== 'string') continue
      if (typeof sourceMediaId !== 'number' || r.data['source'] !== 'detected') continue
      const mediaId = r.data['mediaId']
      const deviceId = r.data['deviceId']
      const alignment = parseFaceAlignment(r.data['alignment'])
      const sourceBbox = parseSourceBbox(r.data['sourceBbox'])
      detected.push({
        sampleId: r.id,
        identityId,
        identityName: names.get(identityId) ?? identityId,
        modelId,
        source: 'detected',
        sourceMediaId,
        ...(typeof mediaId === 'number' ? { mediaId } : {}),
        ...(typeof deviceId === 'number' ? { deviceId } : {}),
        ...(alignment !== undefined ? { alignment } : {}),
        ...(sourceBbox !== undefined ? { sourceBbox } : {}),
      })
    }
    return [...photos, ...detected]
  }

  /**
   * Every PHOTO sample across every identity, shaped for the re-enrol pass
   * (`face-photo-reenrol-pass.ts`), identity names joined for its log lines.
   * Reads `sourceMediaId` from the column — never inferred from `mediaId`.
   */
  async listPhotoSamplesForReenrol(): Promise<readonly PhotoReenrolSample[]> {
    const names = new Map((await this.listIdentities()).map((i) => [i.id, i.name]))
    const rows = await this.sampleLedger.query({ where: { source: 'photo' } })
    const out: PhotoReenrolSample[] = []
    for (const r of rows) {
      const identityId = r.data['identityId']
      const modelId = r.data['modelId']
      if (typeof identityId !== 'string' || typeof modelId !== 'string') continue
      if (r.data['source'] !== 'photo') continue
      const mediaId = r.data['mediaId']
      const sourceMediaId = r.data['sourceMediaId']
      const alignment = parseFaceAlignment(r.data['alignment'])
      const sourceBbox = parseSourceBbox(r.data['sourceBbox'])
      out.push({
        sampleId: r.id,
        identityId,
        identityName: names.get(identityId) ?? identityId,
        modelId,
        source: 'photo',
        ...(typeof mediaId === 'number' ? { mediaId } : {}),
        ...(typeof sourceMediaId === 'number' ? { sourceMediaId } : {}),
        ...(alignment !== undefined ? { alignment } : {}),
        ...(sourceBbox !== undefined ? { sourceBbox } : {}),
      })
    }
    return out
  }

  /**
   * The enrolled vectors for these sample ids, straight off the index.
   *
   * Exposed because the gallery audit compares samples with each other, and
   * `loadGallery` — the only other vector read — drops the sample id in favour
   * of the identity id. An audit that cannot name the sample it accuses has
   * nothing to offer a Remove button.
   */
  async loadSampleVectors(
    sampleIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    return this.vectors.load(sampleIds)
  }

  /**
   * The media ids EVERY sample names — template and source, any provenance,
   * any identity. The photo-source backfill refuses a candidate somebody else
   * already names.
   */
  async listSampleMediaRefs(): Promise<readonly SampleMediaRefs[]> {
    const rows = await this.sampleLedger.query({}, ['mediaId', 'sourceMediaId'])
    return rows.map((r) => {
      const mediaId = r.data['mediaId']
      const sourceMediaId = r.data['sourceMediaId']
      return {
        sampleId: r.id,
        ...(typeof mediaId === 'number' ? { mediaId } : {}),
        ...(typeof sourceMediaId === 'number' ? { sourceMediaId } : {}),
      }
    })
  }

  /** Set a photo sample's original. The caller verifies it (`photo-source-backfill.ts`). */
  async setSourceMediaId(sampleId: string, sourceMediaId: number): Promise<void> {
    await this.sampleLedger.update(sampleId, { sourceMediaId })
  }

  /** The stored `sourceMediaId`, read back by key; null when unset or no row. */
  async readSourceMediaId(sampleId: string): Promise<number | null> {
    const row = await this.sampleLedger.get(sampleId)
    if (row === null) return null
    const value: unknown = row.data['sourceMediaId']
    return typeof value === 'number' ? value : null
  }

  /** Is the sample row present? One keyed read. */
  async sampleExists(sampleId: string): Promise<boolean> {
    const row = await this.sampleLedger.get(sampleId)
    return row !== null
  }

  /**
   * The prune's read (D643): exactly the columns it decides on, served from
   * `idx_sample_identity_prune` without touching a row (D447 — proved on the
   * real engine in `identity-prune-plan-over-real-sqlite.spec.ts`).
   */
  async listSamplesForPrune(identityId: string): Promise<readonly IdentityPruneRow[]> {
    const rows = await this.sampleLedger.query({ where: { identityId } }, [
      'source',
      'alignment',
      'deviceId',
    ])
    return rows.map((r) => {
      const deviceId = r.data['deviceId']
      const alignment = parseFaceAlignment(r.data['alignment'])
      return {
        id: r.id,
        source: r.data['source'] === 'photo' ? 'photo' : 'detected',
        ...(typeof deviceId === 'number' ? { deviceId } : {}),
        ...(alignment !== undefined ? { alignment } : {}),
      }
    })
  }

  async removeSample(identityId: string, sampleId: string): Promise<void> {
    // A row already gone must not be counted out twice: the prune and the
    // operator's Remove (or an unassign naming a pruned sample) can both reach
    // the same id, and each decrement is `sampleCount` drifting from the truth.
    if (!(await this.sampleExists(sampleId))) {
      await this.vectors.drop([sampleId])
      this.logger.warn('removeSample: the sample row is already gone — nothing counted out', {
        meta: { identityId, sampleId },
      })
      return
    }
    await this.sampleLedger.deleteKey(sampleId)
    // The vector leaves with the row it belongs to. A gallery vector whose row
    // is gone would keep matching a person the operator un-enrolled.
    await this.vectors.drop([sampleId])
    const identity = (await this.listIdentities()).find((i) => i.id === identityId)
    if (identity) {
      const patch: Record<string, unknown> = {
        sampleCount: Math.max(0, identity.sampleCount - 1),
        updatedAt: Date.now(),
      }
      // A cover pointing at media no remaining sample owns is worse than no
      // cover: the avatar renders a deleted blob, and addSample's "only when
      // null" rule would never repair it. Promote a survivor, or clear.
      if (identity.coverMediaId != null) {
        const remaining = await this.listSamples(identityId)
        const coverStillOwned = remaining.some((r) => r.mediaId === identity.coverMediaId)
        if (!coverStillOwned) {
          patch['coverMediaId'] = remaining.find((r) => r.mediaId !== undefined)?.mediaId ?? null
        }
      }
      await this.identityLedger.update(identityId, patch)
    }
  }

  /**
   * Build the in-memory matching gallery from every persisted sample. Samples
   * missing an embedding or modelId are skipped (defensive). The matcher itself
   * filters by modelId/dim per probe, so all models can coexist here.
   */
  async loadGallery(): Promise<readonly GallerySample[]> {
    const rows = await this.sampleLedger.query({})
    const wanted: string[] = []
    for (const r of rows) {
      const d = r.data as GalleryRowFields
      if (typeof d.modelId === 'string' && typeof d.identityId === 'string') wanted.push(r.id)
    }
    const vectors = await this.vectors.loadStampedFloat32(wanted)

    const gallery: GallerySample[] = []
    let fromLegacyColumn = 0
    let missing = 0
    const torn: { sampleId: string; rowModelId: string; vectorModelId: string }[] = []
    for (const r of rows) {
      const d = r.data as GalleryRowFields
      if (typeof d.modelId !== 'string' || typeof d.identityId !== 'string') continue
      const indexed = vectors.get(r.id)
      if (indexed !== undefined) {
        // D651: the matcher compares a probe only with samples of the SAME
        // modelId, and it reads that id from here. A vector whose own stamp
        // disagrees with its row is a torn restamp (vector written, row not):
        // serving it under the row's id would compare two feature spaces. The
        // sample sits out until the next re-embed pass restamps it — a miss,
        // never a wrong match.
        if (indexed.modelId !== null && indexed.modelId !== d.modelId) {
          torn.push({ sampleId: r.id, rowModelId: d.modelId, vectorModelId: indexed.modelId })
          continue
        }
        gallery.push({ identityId: d.identityId, embedding: indexed.embedding, modelId: d.modelId })
        continue
      }
      // Not in the index: either this row has not been converted yet, or the
      // index could not answer. The legacy column is still the truth for an
      // unconverted row, and serving it is what keeps recognition working
      // through the conversion instead of across a gap in it.
      const legacy = d.embedding
      if (Array.isArray(legacy) && legacy.length > 0) {
        fromLegacyColumn += 1
        gallery.push({
          identityId: d.identityId,
          embedding: new Float32Array(legacy),
          modelId: d.modelId,
        })
        continue
      }
      missing += 1
    }
    if (torn.length > 0) {
      this.logger.warn(
        'identity gallery: samples whose vector and row name different models are NOT served — a re-embed pass restamps them',
        {
          meta: {
            index: this.vectors.name,
            torn: torn.length,
            examples: torn.slice(0, TORN_SAMPLES_LOGGED),
          },
        },
      )
    }
    if (fromLegacyColumn > 0 || missing > 0) {
      // A gallery that quietly loaded fewer people than are enrolled is the one
      // failure of this store nobody would notice from the outside: recognition
      // simply stops matching someone.
      this.logger.warn('identity gallery did not come entirely from the vector index', {
        meta: {
          index: this.vectors.name,
          enrolled: rows.length,
          loaded: gallery.length,
          fromLegacyColumn,
          missing,
        },
      })
    }
    return gallery
  }

  /**
   * Every sample across every identity, shaped for `reembedFaceGallery`
   * (`face-reembed-pass.ts`) — identity names joined so the pass can log and
   * report per person without a second lookup.
   */
  async listSamplesForReembed(): Promise<readonly FaceReembedSample[]> {
    const names = new Map((await this.listIdentities()).map((i) => [i.id, i.name]))
    const rows = await this.sampleLedger.query({})
    const out: FaceReembedSample[] = []
    for (const r of rows) {
      const d = r.data as Partial<IdentitySample>
      if (typeof d.identityId !== 'string' || typeof d.modelId !== 'string') continue
      out.push({
        sampleId: r.id,
        identityId: d.identityId,
        identityName: names.get(d.identityId) ?? d.identityId,
        modelId: d.modelId,
        dim: Number(d.dim ?? 0),
        // `!= null`: the relational store surfaces an unset column as SQL NULL,
        // and the pass treats an absent id as "nothing to re-embed from".
        ...(d.mediaId != null ? { mediaId: d.mediaId } : {}),
      })
    }
    return out
  }

  /**
   * Stamp a sample with a NEW vector + model, and only claim success after
   * reading the row back (D58: "did it persist" is the gate, never "did the
   * call return" — a live CLIP pass once reported 704 rebuilt against an index
   * holding 0).
   */
  async restampSample(input: {
    readonly sampleId: string
    readonly identityId: string
    readonly embedding: readonly number[]
    readonly modelId: string
    readonly dim: number
  }): Promise<{ readonly landed: boolean; readonly reason?: string }> {
    const indexed = await this.vectors.put({
      id: input.sampleId,
      embedding: input.embedding,
      className: IDENTITY_VECTOR_CLASS,
      modelId: input.modelId,
      timestamp: Date.now(),
      extra: { identityId: input.identityId },
    })
    if (!indexed) {
      // The stamp must not move without the vector: a row claiming the new model
      // while the index still holds the old vector is a sample the matcher
      // believes is comparable and is not.
      return { landed: false, reason: 'the re-embedded vector did not reach the gallery index' }
    }
    try {
      await this.sampleLedger.update(input.sampleId, {
        embedding: [],
        modelId: input.modelId,
        dim: input.dim,
      })
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      return { landed: false, reason: `update failed: ${reason}` }
    }
    const rows = await this.sampleLedger.query({ where: { identityId: input.identityId } })
    const row = rows.find((r) => r.id === input.sampleId)
    if (row === undefined) {
      return { landed: false, reason: 'row not found on read-back' }
    }
    const d = row.data as Partial<IdentitySample>
    if (d.modelId !== input.modelId) {
      return {
        landed: false,
        reason: `read-back still stamped "${String(d.modelId)}", expected "${input.modelId}"`,
      }
    }
    return { landed: true }
  }
}
