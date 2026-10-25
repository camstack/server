import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { FACE_ARCFACE_INDEX } from '../../store/embedding-vector-index.js'
import { FaceStore } from '../../store/face-store.js'
import { scanEmbeddingOrphans } from '../embedding-orphan-scan.js'
import { FACE_VECTOR_ORPHAN_SCOPE, faceVectorOrphanDeps } from '../face-vector-orphans.js'

const NOW = 1_700_000_000_000
const OLD = NOW - 48 * 3600_000

const LIMITS = {
  mode: 'reclaim' as const,
  graceMs: 3600_000,
  pageSize: 50,
  maxRows: 1_000,
  maxReclaim: 100,
}

async function setup() {
  const { ledgers } = await makeAnalyticsWorld()
  const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
  const logger: IScopedLogger = makeSilentLogger()
  const store = new FaceStore({ vectors: index.vectors, logger, faceLedger: ledgers.faces })
  return { store, ledgers, rows: index.rows, logger }
}

function face(id: string, trackId: string, assigned = false) {
  return {
    id,
    deviceId: 102,
    trackId,
    timestamp: OLD,
    embedding: [0.1, 0.2],
    mediaId: OLD,
    assigned,
  }
}

describe('the face-arcface orphan leg', () => {
  it('judges a vector by its FACE row, never by the track in its metadata', async () => {
    // THE trap this module exists for. A face vector carries `trackId` in its
    // metadata, and an enrolled face is exempt from retention: it outlives its
    // track by design. A scan that asked "is this track alive?" would delete
    // the vectors of exactly the people the operator registered by hand, and
    // the recognition would degrade in silence.
    const { store } = await setup()
    await store.insert(face('face-enrolled', 'track-long-gone', true))

    const report = await scanEmbeddingOrphans(
      faceVectorOrphanDeps({ faces: store, now: () => NOW, logger: makeSilentLogger() }),
      LIMITS,
      0,
    )

    expect(report.scope).toBe(FACE_VECTOR_ORPHAN_SCOPE)
    expect(report.examined).toBe(1)
    expect(report.kept).toBe(1)
    expect(report.reclaimed).toBe(0)
    expect((await store.getWithEmbedding('face-enrolled'))?.embedding.length).toBeGreaterThan(0)
  })

  it('reclaims a vector whose face row is gone', async () => {
    const { store, ledgers, rows } = await setup()
    await store.insert(face('face-orphan', 'track-a'))
    // The ROW deleted out of band, leaving the vector behind — the way the
    // maintenance-window SQL did it, and the way a cascade with no vector leg
    // does it. `FaceStore.delete` would have taken the vector with it.
    await ledgers.faces.deleteKey('face-orphan')

    const report = await scanEmbeddingOrphans(
      faceVectorOrphanDeps({ faces: store, now: () => NOW, logger: makeSilentLogger() }),
      LIMITS,
      0,
    )

    expect(report.orphans).toBe(1)
    expect(report.reclaimed).toBe(1)
    expect(rows.get(FACE_ARCFACE_INDEX)?.size ?? 0).toBe(0)
  })

  it('abandons the pass when the face probe throws — never reads it as "all dead"', async () => {
    const { store } = await setup()
    await store.insert(face('face-a', 'track-a'))
    const broken = {
      ...faceVectorOrphanDeps({ faces: store, now: () => NOW, logger: makeSilentLogger() }),
      liveOwnerIds: async (): Promise<ReadonlySet<string>> => {
        throw new Error('settings store unreachable')
      },
    }

    const report = await scanEmbeddingOrphans(broken, LIMITS, 0)

    expect(report.stoppedBy).toBe('probe-failed')
    expect(report.reclaimed).toBe(0)
  })
})
