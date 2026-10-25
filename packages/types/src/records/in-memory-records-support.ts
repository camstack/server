/**
 * Helpers of the in-memory records world (`in-memory-records.ts`): the spec
 * keychain, the keyset cursor, the declaration and ring rules, and the
 * aggregate fold. Each mirrors its engine counterpart under
 * `packages/system/src/builtins/sqlite-storage/records/`.
 */
import { buildSecretRef, type SecretScope } from '../keychain/secret-ref.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import type { KeychainResolveResult } from '../capabilities/keychain.cap.js'
import { DeclarationRefusedError, InvalidRecordError } from './errors.js'
import type { RecordKindDeclaration } from './record-kind.js'
import { compareSql, extractField, type SqlValue } from './in-memory-records-plan.js'

export function makeSpecKeychain(owner: string): { readonly access: SecretsAccess } {
  const values = new Map<string, string>()
  const access: SecretsAccess = {
    owner,
    ref: (scope: SecretScope, fieldPath: string) => buildSecretRef({ owner, scope, fieldPath }),
    resolve: async (refs) => {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const value = values.get(ref)
        out[ref] = value === undefined ? { kind: 'missing' } : { kind: 'value', value, version: 1 }
      }
      return out
    },
    put: async (ref, value) => {
      values.set(ref, value)
      return 1
    },
    delete: async (refs) => {
      let deleted = 0
      for (const ref of refs) if (values.delete(ref)) deleted += 1
      return deleted
    },
    state: async () => ({ state: 'ready' }),
    onChange: () => () => undefined,
    forOwner: null,
  }
  return { access }
}

export type CursorValue = string | number | null

export interface DecodedCursor {
  readonly tag: string
  readonly values: readonly CursorValue[]
}

export function encodeCursor(tag: string, values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify({ t: tag, v: values }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): DecodedCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const t: unknown = Reflect.get(parsed, 't')
      const v: unknown = Reflect.get(parsed, 'v')
      if (typeof t === 'string' && Array.isArray(v)) {
        const values: CursorValue[] = []
        for (const item of v) {
          if (typeof item === 'string' || typeof item === 'number' || item === null) {
            values.push(item)
          } else throw new Error('bad cursor value')
        }
        return { tag: t, values }
      }
    }
  } catch {
    /* falls through to the refusal below */
  }
  throw new InvalidRecordError('the cursor is not valid')
}

export function assertCursor(cursor: DecodedCursor, tag: string, length: number): void {
  if (cursor.tag !== tag || cursor.values.length !== length) {
    throw new InvalidRecordError('the cursor does not belong to this query')
  }
}

export function compareKeys(a: readonly SqlValue[], b: readonly SqlValue[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const c = compareSql(a[i] ?? null, b[i] ?? null)
    if (c !== 0) return c
  }
  return 0
}

/** What a re-declaration may not change (the engine's `assertAdditive`). */
export function assertAdditive(
  kind: string,
  before: RecordKindDeclaration,
  next: RecordKindDeclaration,
): void {
  const refuse = (why: string): never => {
    throw new DeclarationRefusedError(
      `kind "${kind}": ${why} - the engine never migrates data; a changed index is a new name`,
    )
  }
  if (before.database !== next.database) refuse('the database cannot change')
  if (before.device !== next.device) refuse('"device" cannot change')
  if (before.at !== next.at) refuse('"at" cannot change')
  for (const old of before.indexes) {
    const same = next.indexes.find((i) => i.name === old.name)
    if (same === undefined) continue
    if (same.unique !== old.unique || same.fields.join(',') !== old.fields.join(',')) {
      refuse(`index "${old.name}" was declared differently before`)
    }
  }
  for (const path of before.secretPaths) {
    if (!next.secretPaths.includes(path)) refuse(`secret path "${path}" cannot stop being secret`)
  }
}

export const TRIM_SLACK = 100

/** The row bounds of a kind whose retention is a ring, else null. */
export function ringBounds(
  decl: RecordKindDeclaration,
): { readonly maxRows?: number; readonly maxRowsPerDevice?: number } | null {
  const { retention } = decl
  if ('maxRows' in retention || 'maxRowsPerDevice' in retention) {
    return {
      ...(retention.maxRows === undefined ? {} : { maxRows: retention.maxRows }),
      ...(retention.maxRowsPerDevice === undefined
        ? {}
        : { maxRowsPerDevice: retention.maxRowsPerDevice }),
    }
  }
  return null
}

/** Buckets one histogram answer may carry (the engine's `HISTOGRAM_MAX_BUCKETS`). */
export const HISTOGRAM_MAX_BUCKETS = 10_000

/** SUM / MIN / MAX / COUNT over `json_extract` values, as SQLite folds them. */
export function aggregateOf(
  op: 'sum' | 'min' | 'max' | 'count',
  field: string | undefined,
  rows: readonly { readonly data: Record<string, unknown> }[],
): number | null {
  if (field === undefined) return rows.length
  const values = rows.map((r) => extractField(r.data, field)).filter((v) => v !== null)
  if (op === 'count') return values.length
  if (values.length === 0) return null
  if (op === 'sum') {
    return values.reduce<number>((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0)
  }
  const sorted = [...values].sort(compareSql)
  const picked = op === 'min' ? sorted[0] : sorted.at(-1)
  return typeof picked === 'number' ? picked : null
}
