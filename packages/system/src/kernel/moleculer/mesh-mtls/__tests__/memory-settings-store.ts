/** An in-memory `SettingsStoreClient` for specs that need a real `MeshCertificateRegistry`. */
import type { SettingsStoreClient } from '@camstack/types'

interface Row {
  readonly id: string
  readonly data: Record<string, unknown>
}

export function memoryStore(): SettingsStoreClient {
  const rows = new Map<string, Map<string, Row>>()
  const coll = (name: string): Map<string, Row> => {
    let c = rows.get(name)
    if (c === undefined) {
      c = new Map()
      rows.set(name, c)
    }
    return c
  }
  const store = {
    insert: {
      mutate: async (a: { collection: string; record: Row }) => {
        coll(a.collection).set(a.record.id, a.record)
      },
    },
    update: {
      mutate: async (a: { collection: string; id: string; data: Record<string, unknown> }) => {
        coll(a.collection).set(a.id, { id: a.id, data: a.data })
      },
    },
    delete: {
      mutate: async (a: { collection: string; key: string }) =>
        void coll(a.collection).delete(a.key),
    },
    query: {
      query: async (a: { collection: string }) => [...coll(a.collection).values()],
    },
  }
  // TECH-DEBT: a structural fake of the tRPC client slice the registry touches.
  return store as unknown as SettingsStoreClient
}
