/**
 * A records world for specs: the REAL `ctx.records` facade (`createRecordsAccess`
 * — secret classification, keychain-first writes, redaction, `resolveSecrets`)
 * over an in-memory transport that enforces the same rules the engine does:
 *
 *  - a secret leaf may hold only a marker bound to the row's own ref; the
 *    redaction token keeps what is stored; a plain string is REFUSED;
 *  - reads show the redaction token for a set secret;
 *  - a kind with `at: 'required'` refuses a write without `at`; an engine TTL
 *    stamps `expiresAt = at + ttlMs`;
 *  - a `where` field must belong to a declared index.
 *
 * Nothing is faked between the store and the facade, so a store that sent a
 * plaintext key, forgot `at`, or filtered on an unindexed field fails here.
 * Test-only; every value is fabricated.
 */
import {
  createRecordsAccess,
  isSecretMarker,
  mapSecretLeaves,
  REDACTED_SECRET,
  recordSecretRef,
  REMOVE_LEAF,
  type RecordKindDeclaration,
  type RecordsAccess,
  type RecordsTransport,
  type RecordView,
} from '@camstack/types'
import { aiRecordKinds } from '../../record-kinds.js'
import { makeFakeKeychain, type FakeKeychain } from './fake-keychain.js'

interface StoredRow {
  readonly id: string
  readonly at: number | null
  readonly expiresAt: number | null
  readonly rev: number
  readonly updatedAt: number
  readonly data: Record<string, unknown>
}

export interface FakeRecords {
  readonly records: RecordsAccess
  readonly keychain: FakeKeychain
  /** kind -> id -> row, as stored (secret leaves hold markers). */
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, StoredRow>>
  /** Seed a row as the engine would have stored it (what an adoption writes). */
  seed(kind: string, row: { id: string; at?: number; data: Record<string, unknown> }): void
  /** Delete every row whose `expiresAt` has passed (the engine's TTL sweep). */
  sweep(now: number): number
  /** kind -> every `where` field a query used (to assert the index was asked). */
  readonly queriedFields: ReadonlyMap<string, ReadonlySet<string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function markersOf(
  decl: RecordKindDeclaration,
  body: Record<string, unknown>,
): Map<string, string> {
  const out = new Map<string, string>()
  mapSecretLeaves(body, decl.secretPaths, decl.secretArrayKeys, (leaf) => {
    if (isSecretMarker(leaf.value)) out.set(leaf.concrete, leaf.value.$secret)
    return leaf.value
  })
  return out
}

export function makeFakeRecords(
  owner = 'ai',
  opts: { readonly keychainDoor?: boolean } = {},
): FakeRecords {
  const decls = new Map<string, RecordKindDeclaration>()
  const tables = new Map<string, Map<string, StoredRow>>()
  const queried = new Map<string, Set<string>>()
  let clock = 1

  const table = (kind: string): Map<string, StoredRow> => {
    let t = tables.get(kind)
    if (t === undefined) {
      t = new Map()
      tables.set(kind, t)
    }
    return t
  }
  const declOf = (kind: string): RecordKindDeclaration => {
    const decl = decls.get(kind)
    if (decl === undefined) throw new Error(`kind "${kind}" is not declared`)
    return decl
  }

  const redact = (
    decl: RecordKindDeclaration,
    body: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (decl.secretPaths.length === 0) return body
    const out = mapSecretLeaves(body, decl.secretPaths, decl.secretArrayKeys, (leaf) =>
      leaf.value === null ? null : REDACTED_SECRET,
    )
    return isRecord(out) ? out : body
  }
  const view = (kind: string, row: StoredRow): RecordView => ({
    id: row.id,
    deviceId: null,
    at: row.at,
    expiresAt: row.expiresAt,
    rev: row.rev,
    updatedAt: row.updatedAt,
    data: redact(declOf(kind), row.data),
  })

  /** The engine's write-side secret rule (`enforceSecrets`). */
  const enforce = (
    kind: string,
    id: string,
    body: Record<string, unknown>,
    stored: Record<string, unknown> | null,
  ): { body: Record<string, unknown>; released: string[] } => {
    const decl = declOf(kind)
    if (decl.secretPaths.length === 0) return { body, released: [] }
    const before = stored === null ? new Map<string, string>() : markersOf(decl, stored)
    const next = mapSecretLeaves(body, decl.secretPaths, decl.secretArrayKeys, (leaf) => {
      const expected = recordSecretRef(owner, kind, id, leaf.concrete)
      if (isSecretMarker(leaf.value)) {
        if (leaf.value.$secret !== expected) throw new Error('foreign secret marker')
        return leaf.value
      }
      if (leaf.value === REDACTED_SECRET) {
        const keep = before.get(leaf.concrete)
        return keep === undefined ? REMOVE_LEAF : { $secret: keep, v: 1 }
      }
      if (leaf.value === null || leaf.value === undefined) return REMOVE_LEAF
      throw new Error(`${kind}/${id}: a secret field takes a keychain marker, never a value`)
    })
    if (!isRecord(next)) throw new Error('the body must be an object')
    const after = markersOf(decl, next)
    const released = [...before.entries()]
      .filter(([p, ref]) => after.get(p) !== ref)
      .map(([, r]) => r)
    return { body: next, released }
  }

  const write = (
    kind: string,
    input: { id: string; at?: number; expiresAt?: number; data: Record<string, unknown> },
  ): { rev: number; released: string[] } => {
    const decl = declOf(kind)
    if (decl.at === 'required' && input.at === undefined) {
      throw new Error(`${kind}/${input.id}: the kind needs "at" on every write`)
    }
    const t = table(kind)
    const prev = t.get(input.id)
    const { body, released } = enforce(kind, input.id, input.data, prev?.data ?? null)
    const retention = decl.retention
    const expiresAt =
      'ttlMs' in retention && input.at !== undefined
        ? input.at + retention.ttlMs
        : (input.expiresAt ?? null)
    const rev = (prev?.rev ?? 0) + 1
    clock += 1
    t.set(input.id, {
      id: input.id,
      at: input.at ?? null,
      expiresAt,
      rev,
      updatedAt: clock,
      data: body,
    })
    return { rev, released }
  }

  const unimplemented = (op: string): never => {
    throw new Error(`the fake records transport does not implement ${op}`)
  }

  const transport: RecordsTransport = {
    declareKinds: async ({ kinds }) => {
      const out: Record<string, { kindId: number; state: 'created'; createdIndexes: string[] }> = {}
      let n = 0
      for (const [name, decl] of Object.entries(kinds)) {
        decls.set(name, decl)
        n += 1
        out[name] = {
          kindId: n,
          state: 'created',
          createdIndexes: decl.indexes.map((i) => i.name),
        }
      }
      return { kinds: out }
    },
    get: async ({ kind, id }) => {
      const row = table(kind).get(id)
      return row === undefined ? null : view(kind, row)
    },
    getMany: async ({ kind, ids }) =>
      ids.flatMap((id) => {
        const row = table(kind).get(id)
        return row === undefined ? [] : [view(kind, row)]
      }),
    secretRefs: async ({ kind, ids }) => {
      const decl = declOf(kind)
      const out: Record<string, Record<string, string>> = {}
      for (const id of ids) {
        const row = table(kind).get(id)
        if (row !== undefined) out[id] = Object.fromEntries(markersOf(decl, row.data))
      }
      return out
    },
    put: async ({ kind, record, ifRev }) => {
      if (ifRev !== undefined && (table(kind).get(record.id)?.rev ?? 0) !== ifRev) {
        throw new Error('stale ifRev')
      }
      const { rev, released } = write(kind, record)
      return { rev, releasedRefs: released }
    },
    putMany: async ({ kind, records }) => {
      const released: string[] = []
      for (const record of records) released.push(...write(kind, record).released)
      return { count: records.length, releasedRefs: released }
    },
    patch: async () => unimplemented('patch'),
    delete: async ({ kind, id }) => {
      const row = table(kind).get(id)
      if (row === undefined) return { deleted: false, secretRefs: [] }
      table(kind).delete(id)
      return { deleted: true, secretRefs: [...markersOf(declOf(kind), row.data).values()] }
    },
    deleteMany: async ({ kind, ids }) => {
      let deleted = 0
      const refs: string[] = []
      for (const id of ids) {
        const row = table(kind).get(id)
        if (row === undefined) continue
        table(kind).delete(id)
        deleted += 1
        refs.push(...markersOf(declOf(kind), row.data).values())
      }
      return { deleted, secretRefs: refs }
    },
    query: async (q) => {
      const decl = declOf(q.kind)
      const indexed = new Set(decl.indexes.flatMap((i) => i.fields))
      let rows = [...table(q.kind).values()]
      for (const [field, wanted] of Object.entries(q.where ?? {})) {
        if (!indexed.has(field)) throw new Error(`${q.kind}: "${field}" is not an indexed field`)
        const seen = queried.get(q.kind) ?? new Set<string>()
        seen.add(field)
        queried.set(q.kind, seen)
        rows = rows.filter((r) => r.data[field] === wanted)
      }
      if (q.atFrom !== undefined)
        rows = rows.filter((r) => r.at !== null && r.at >= (q.atFrom ?? 0))
      if (q.atTo !== undefined) rows = rows.filter((r) => r.at !== null && r.at <= (q.atTo ?? 0))
      const byAt = q.order === 'at' || (q.order === undefined && decl.at === 'required')
      rows.sort((a, b) =>
        byAt ? (a.at ?? 0) - (b.at ?? 0) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      if (q.desc === true) rows.reverse()
      const start = q.cursor === undefined ? 0 : Number(q.cursor)
      const page = rows.slice(start, start + q.limit)
      const more = start + q.limit < rows.length
      return {
        records: page.map((r) => view(q.kind, r)),
        nextCursor: more ? String(start + q.limit) : null,
      }
    },
    count: async ({ kind }) => ({ count: table(kind).size }),
    histogram: async () => unimplemented('histogram'),
    aggregate: async () => unimplemented('aggregate'),
    deleteWhere: async () => unimplemented('deleteWhere'),
    transact: async () => unimplemented('transact'),
    deleteDevice: async () => unimplemented('deleteDevice'),
    allocateId: async () => unimplemented('allocateId'),
  }

  const keychain = makeFakeKeychain(owner)
  // `keychainDoor: false` is a process with no `ctx.secrets` (a kind with secrets then refuses).
  const records = createRecordsAccess({
    owner,
    transport,
    secrets: opts.keychainDoor === false ? null : keychain.access,
  })
  return {
    records,
    keychain,
    tables,
    queriedFields: queried,
    seed: (kind, row) => {
      table(kind).set(row.id, {
        id: row.id,
        at: row.at ?? null,
        expiresAt: null,
        rev: 1,
        updatedAt: 1,
        data: row.data,
      })
    },
    sweep: (now) => {
      let removed = 0
      for (const t of tables.values()) {
        for (const [id, row] of t) {
          if (row.expiresAt !== null && row.expiresAt <= now) {
            t.delete(id)
            removed += 1
          }
        }
      }
      return removed
    },
  }
}

/** The fake with the AI kinds declared, as `onInitialize` leaves it. */
export async function makeAiRecords(
  opts: { readonly keychainDoor?: boolean } = {},
): Promise<FakeRecords> {
  const world = makeFakeRecords('ai', opts)
  await world.records.declare(aiRecordKinds)
  return world
}
