import type { KeychainDoor } from '../keychain-store.js'

type Row = Record<string, unknown>

/** An in-memory settings door with the subset of filter semantics the keychain uses. */
export class MemoryDoor implements KeychainDoor {
  readonly tables = new Map<string, Map<string, Row>>()
  failReads = false

  private table(collection: string, namespace?: string): Map<string, Row> {
    const name = namespace !== undefined ? `${namespace}:${collection}` : collection
    let t = this.tables.get(name)
    if (t === undefined) {
      t = new Map()
      this.tables.set(name, t)
    }
    return t
  }

  async declareCollection(input: Parameters<KeychainDoor['declareCollection']>[0]): Promise<void> {
    this.table(input.collection, input.namespace)
  }

  async get(input: Parameters<KeychainDoor['get']>[0]): Promise<unknown> {
    if (this.failReads) throw new Error('door down')
    const row = this.table(input.collection, input.namespace).get(input.key)
    return row === undefined ? undefined : structuredClone(row)
  }

  async set(input: Parameters<KeychainDoor['set']>[0]): Promise<void> {
    const value = input.value
    const row: Row = value !== null && typeof value === 'object' ? { ...value } : { value }
    this.table(input.collection, input.namespace).set(input.key, structuredClone(row))
  }

  private matches(row: Row, filter: Parameters<KeychainDoor['query']>[0]['filter']): boolean {
    if (filter === undefined) return true
    for (const [k, v] of Object.entries(filter.where ?? {})) if (row[k] !== v) return false
    for (const [k, vs] of Object.entries(filter.whereIn ?? {}))
      if (!vs.includes(row[k])) return false
    for (const [k, [lo, hi]] of Object.entries(filter.whereBetween ?? {})) {
      const v = row[k]
      if (typeof v === 'number' && typeof lo === 'number' && typeof hi === 'number') {
        if (v < lo || v > hi) return false
      } else if (typeof v === 'string' && typeof lo === 'string' && typeof hi === 'string') {
        if (v < lo || v > hi) return false
      } else {
        return false
      }
    }
    return true
  }

  async query(input: Parameters<KeychainDoor['query']>[0]): ReturnType<KeychainDoor['query']> {
    if (this.failReads) throw new Error('door down')
    const t = this.table(input.collection, input.namespace)
    let rows = [...t.entries()].map(([id, data]) => {
      const full: Row = { id, ...data }
      return { id, data: full }
    })
    rows = rows.filter((r) => this.matches(r.data, input.filter))
    const order = input.filter?.orderBy
    if (order !== undefined) {
      rows.sort((a, b) => {
        const av = a.data[order.field]
        const bv = b.data[order.field]
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
        return order.direction === 'asc' ? cmp : -cmp
      })
    }
    const offset = input.filter?.offset ?? 0
    const limit = input.filter?.limit ?? rows.length
    return rows
      .slice(offset, offset + limit)
      .map((r) => ({ id: r.id, data: structuredClone(r.data) }))
  }

  async delete(input: Parameters<KeychainDoor['delete']>[0]): Promise<void> {
    this.table(input.collection, input.namespace).delete(input.key)
  }

  async deleteWhere(
    input: Parameters<KeychainDoor['deleteWhere']>[0],
  ): Promise<{ deleted: number }> {
    const t = this.table(input.collection, input.namespace)
    let deleted = 0
    for (const [id, row] of [...t.entries()]) {
      if (this.matches({ id, ...row }, input.filter)) {
        t.delete(id)
        deleted++
      }
    }
    return { deleted }
  }
}
