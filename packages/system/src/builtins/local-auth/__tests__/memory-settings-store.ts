/**
 * Collection-aware in-memory settings store — enough for local-auth's managers
 * (and the auth managers' own specs). Test-only.
 */
interface Row {
  id: string
  data: Record<string, unknown>
}

export function makeStore() {
  const collections = new Map<string, Map<string, Row>>()
  const coll = (name: string): Map<string, Row> => {
    let c = collections.get(name)
    if (c === undefined) {
      c = new Map()
      collections.set(name, c)
    }
    return c
  }
  const matches = (row: Row, where: Record<string, unknown> | undefined): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => row.data[k] === v)
  return {
    declareCollection: { mutate: async () => undefined },
    insert: {
      mutate: async (a: { collection: string; record: Row }) => {
        const c = coll(a.collection)
        if (c.has(a.record.id)) throw new Error('UNIQUE constraint failed')
        c.set(a.record.id, { id: a.record.id, data: { ...a.record.data, id: a.record.id } })
      },
    },
    update: {
      mutate: async (a: { collection: string; id: string; data: Record<string, unknown> }) => {
        const c = coll(a.collection)
        const prev = c.get(a.id)
        c.set(a.id, { id: a.id, data: { ...prev?.data, ...a.data } })
      },
    },
    delete: {
      mutate: async (a: { collection: string; key: string }) => {
        coll(a.collection).delete(a.key)
      },
    },
    deleteWhere: {
      mutate: async (a: { collection: string; filter?: { where?: Record<string, unknown> } }) => {
        const c = coll(a.collection)
        for (const [id, row] of c) if (matches(row, a.filter?.where)) c.delete(id)
        return { deleted: 0 }
      },
    },
    query: {
      query: async (a: { collection: string; filter?: { where?: Record<string, unknown> } }) =>
        [...coll(a.collection).values()].filter((row) => matches(row, a.filter?.where)),
    },
    count: {
      query: async (a: { collection: string; filter?: { where?: Record<string, unknown> } }) =>
        [...coll(a.collection).values()].filter((row) => matches(row, a.filter?.where)).length,
    },
  }
}
