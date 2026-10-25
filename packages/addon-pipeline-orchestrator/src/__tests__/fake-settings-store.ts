/**
 * A minimal in-memory `SettingsStoreClient` for the orchestrator's durable
 * stores.
 *
 * The orchestrator's `makeFakeContext` models the addon SETTINGS door
 * (`ctx.settings`), not the settings-STORE cap — nothing here declared a
 * collection until `node-stress-move-ledger.ts` and the device-features mirror
 * did. This is the smaller sibling of the post-analysis helper: it backs
 * declared collections with a `Map<collection, Map<id, data>>` and implements
 * exactly the verbs `DurableLedger` uses.
 *
 * It deliberately does NOT auto-create a collection on first write. The real
 * SQLite backend answers 412 for an undeclared collection and takes the runner
 * down; a fake that quietly created buckets is how three addons shipped that
 * crash (see `scripts/check-collection-declarations.ts`). Here, an undeclared
 * write throws — so a test proves the `declare` call exists rather than
 * assuming it.
 *
 * Known gap (follow-up 102 review, L4): reads hand values back as stored. The
 * SQLite backend hands back any TEXT starting with `[` / `{` already
 * JSON-decoded (`decodeColumnValue`), and booleans decoded from `0|1`. A
 * store that writes `JSON.stringify(x)` and parses on read passes here and
 * throws in production — prove such a read over the real engine.
 */

import type { SettingsStoreClient } from '@camstack/types'

export interface FakeSettingsStore {
  readonly client: SettingsStoreClient
  readonly declared: Set<string>
  readonly data: Map<string, Map<string, Record<string, unknown>>>
  /** Raw row count, for assertions. */
  size(collection: string): number
  /** Direct seeding, for arrange steps that model a previous process. */
  seed(collection: string, key: string, value: Record<string, unknown>): void
}

export function makeFakeSettingsStore(): FakeSettingsStore {
  const declared = new Set<string>()
  const data = new Map<string, Map<string, Record<string, unknown>>>()

  const bucket = (collection: string): Map<string, Record<string, unknown>> => {
    if (!declared.has(collection)) {
      throw new Error(`fake settings store: collection "${collection}" was never declared`)
    }
    let b = data.get(collection)
    if (!b) {
      b = new Map()
      data.set(collection, b)
    }
    return b
  }

  const matchesWhere = (
    row: Record<string, unknown>,
    where: Record<string, unknown> | undefined,
  ): boolean => {
    if (where === undefined) return true
    return Object.entries(where).every(([field, value]) => row[field] === value)
  }

  const client = {
    declareCollection: {
      mutate: async (input: { collection: string }): Promise<void> => {
        declared.add(input.collection)
        if (!data.has(input.collection)) data.set(input.collection, new Map())
      },
    },
    set: {
      mutate: async (input: {
        collection: string
        key: string
        value: Record<string, unknown>
      }): Promise<void> => {
        bucket(input.collection).set(input.key, { ...input.value })
      },
    },
    get: {
      query: async (input: {
        collection: string
        key: string
      }): Promise<Record<string, unknown> | null> =>
        bucket(input.collection).get(input.key) ?? null,
    },
    query: {
      query: async (input: {
        collection: string
        filter?: { where?: Record<string, unknown>; limit?: number }
      }): Promise<readonly { id: string; data: Record<string, unknown> }[]> => {
        const rows = [...bucket(input.collection)]
          .filter(([, value]) => matchesWhere(value, input.filter?.where))
          .map(([id, value]) => ({ id, data: { ...value } }))
        const limit = input.filter?.limit
        return limit === undefined ? rows : rows.slice(0, limit)
      },
    },
    delete: {
      mutate: async (input: { collection: string; key: string }): Promise<void> => {
        bucket(input.collection).delete(input.key)
      },
    },
    deleteWhere: {
      mutate: async (input: {
        collection: string
        filter: { where?: Record<string, unknown> }
      }): Promise<{ deleted: number }> => {
        const b = bucket(input.collection)
        let deleted = 0
        for (const [id, value] of [...b]) {
          if (!matchesWhere(value, input.filter.where)) continue
          b.delete(id)
          deleted += 1
        }
        return { deleted }
      },
    },
  } as unknown as SettingsStoreClient

  return {
    client,
    declared,
    data,
    size: (collection) => data.get(collection)?.size ?? 0,
    seed: (collection, key, value) => {
      declared.add(collection)
      let b = data.get(collection)
      if (!b) {
        b = new Map()
        data.set(collection, b)
      }
      b.set(key, { ...value })
    },
  }
}
