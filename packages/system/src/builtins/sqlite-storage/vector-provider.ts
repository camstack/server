import { createRequire } from 'node:module'
import type { IScopedLogger, IVectorStoreProvider } from '@camstack/types'
import type { OwnedSqliteFile } from './owned-sqlite-file.js'
import type { VectorInput, VectorOp, VectorOutput } from './file-host-protocol.js'
import type { SqliteSettingsBackend } from './sqlite-settings-backend.js'
import { SqliteVecVectorIndex } from './vector-index-vec.js'

/**
 * Build the vector index over a backend's connection.
 *
 * ONE implementation, deliberately. A second backend behind a flag means two
 * code paths that can disagree, two sets of gotchas, and a silent fallback
 * that turns "the extension is missing" into "search is mysteriously slow" —
 * the failure this codebase keeps paying for. The capability is the swap
 * point: another provider replaces this one wholesale, it does not hide
 * inside it.
 *
 * So a failed extension load THROWS. A node without the native binary must
 * fail at boot with a message naming sqlite-vec, not serve degraded results
 * nobody knows are degraded.
 */
export function createVectorIndex(
  backend: SqliteSettingsBackend,
  logger: IScopedLogger,
): SqliteVecVectorIndex {
  const db = backend.getDatabase()
  if (db === null) {
    throw new Error('vector-store: the SQLite database is not open')
  }
  const require_ = createRequire(import.meta.url)
  const sv = require_('sqlite-vec') as { getLoadablePath: () => string }
  // `getLoadablePath()` rather than `load()`: the latter uses
  // `import.meta.resolve`, which is absent under some bundlers and test
  // transforms and fails with a message that says nothing about SQLite.
  db.loadExtension(sv.getLoadablePath())
  logger.info('sqlite-vec extension loaded')
  const profiler = backend.getProfiler()
  return new SqliteVecVectorIndex({ db, logger, ...(profiler ? { profiler } : {}) })
}

/**
 * `vector-store` served from the events worker (P5): every call opens or reuses
 * `events.db` with sqlite-vec loaded there, not on the settings thread.
 */
export function vectorProviderOfOwnedFile(
  openEvents: () => Promise<OwnedSqliteFile>,
): IVectorStoreProvider {
  const call = async <K extends VectorOp>(
    op: K,
    input: VectorInput<K>,
  ): Promise<VectorOutput<K>> => {
    const file = await openEvents()
    return file.vector(op, input)
  }
  return {
    declareIndex: async (input) => call('declareIndex', input),
    upsert: async (input) => call('upsert', input),
    query: async (input) => call('query', input),
    getByIds: async (input) => call('getByIds', input),
    fetchByIds: async (input) => call('fetchByIds', input),
    scan: async (input) => call('scan', input),
    deleteByIds: async (input) => call('deleteByIds', input),
    deleteByFilter: async (input) => call('deleteByFilter', input),
    stats: async (input) => call('stats', input),
  }
}

/**
 * The `vector-store` provider surface over one sqlite-vec index. Extracted
 * from the addon so the main thread (settings) and the file-host worker
 * (events) serve the SAME mapping.
 */
export function vectorProviderOf(vectorIndex: SqliteVecVectorIndex): IVectorStoreProvider {
  return {
    declareIndex: async (input) => {
      await vectorIndex.declareIndex(input.index, input.dim, input.metric)
    },
    upsert: async (input) => vectorIndex.upsert(input.index, input.items),
    query: async (input) =>
      vectorIndex.query({
        index: input.index,
        vector: input.vector,
        topK: input.topK,
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
      }),
    getByIds: async (input) => ({ items: await vectorIndex.getByIds(input.index, input.ids) }),
    fetchByIds: async (input) => ({
      items: await vectorIndex.fetchByIds(input.index, input.ids),
    }),
    scan: async (input) => vectorIndex.scan(input.index, input.cursor, input.limit),
    deleteByIds: async (input) => ({
      deleted: await vectorIndex.deleteByIds(input.index, input.ids),
    }),
    deleteByFilter: async (input) => ({
      deleted: await vectorIndex.deleteByFilter(input.index, input.filter),
    }),
    stats: async (input) => vectorIndex.stats(input.index),
  }
}
