/**
 * Row-level helpers of the records engine (D881): validating a write against
 * its kind, enforcing the secret-field rules, and shaping what a read returns.
 * Pure - no database here.
 */
import {
  collectSecretLeaves,
  ForeignSecretMarkerError,
  InvalidRecordError,
  isSecretMarker,
  mapSecretLeaves,
  PlaintextSecretError,
  type RecordInput,
  type RecordKindDeclaration,
  type RecordView,
  RecordTooLargeError,
  REDACTED_SECRET,
  REMOVE_LEAF,
  recordSecretRef,
  RECORD_ID_MAX_LENGTH,
} from '@camstack/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A row as `SELECT` returns it (the `data` column is `json(data)`). */
export interface StoredRow {
  readonly rid: number
  readonly id: string
  readonly deviceId: number | null
  readonly at: number | null
  readonly expiresAt: number | null
  readonly rev: number
  readonly updatedAt: number
  readonly data: string
}

export function parseBody(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new InvalidRecordError('a stored body is not an object')
  return parsed
}

/** What a write is allowed to say about a row, after the kind's rules. */
export interface WriteHeader {
  readonly id: string
  readonly deviceId: number | null
  readonly at: number | null
  readonly expiresAt: number | null
}

export function validateHeader(
  kind: string,
  decl: RecordKindDeclaration,
  rec: Pick<RecordInput, 'id' | 'deviceId' | 'at' | 'expiresAt'>,
  nowMs: number,
): WriteHeader {
  const fail = (why: string): never => {
    throw new InvalidRecordError(`${kind}/${rec.id.slice(0, 64)}: ${why}`)
  }
  if (rec.id.length === 0 || rec.id.length > RECORD_ID_MAX_LENGTH) {
    fail(`the id must be 1..${RECORD_ID_MAX_LENGTH} characters`)
  }
  if (decl.device === 'required' && rec.deviceId === undefined) fail('deviceId is required')
  if (decl.device === 'none' && rec.deviceId !== undefined) fail('this kind is not device-scoped')
  if (decl.at === 'required' && rec.at === undefined) fail('at is required')
  if (decl.at === 'none' && rec.at !== undefined) fail('this kind has no time')

  const { retention } = decl
  let expiresAt: number | null = rec.expiresAt ?? null
  if ('ttlMs' in retention) {
    if (rec.expiresAt !== undefined) {
      fail('expiresAt is set by the engine on a kind with a ttl retention')
    }
    const from = retention.from === 'at' ? (rec.at ?? nowMs) : nowMs
    expiresAt = from + retention.ttlMs
  } else if (rec.expiresAt !== undefined && decl.secretPaths.length > 0) {
    fail(
      'a kind with secret fields cannot expire by the engine (its keychain values would be orphaned)',
    )
  }
  return { id: rec.id, deviceId: rec.deviceId ?? null, at: rec.at ?? null, expiresAt }
}

const sizeWarnedAt = new Map<string, number>()

/** Serialize the body and enforce `maxDataBytes`; `onTooLarge` is called (rate-limited) before throwing. */
export function serializeBody(
  kind: string,
  decl: RecordKindDeclaration,
  id: string,
  body: Record<string, unknown>,
  onTooLarge: (kind: string, bytes: number) => void,
  nowMs: number,
): string {
  const json = JSON.stringify(body)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > decl.maxDataBytes) {
    const last = sizeWarnedAt.get(kind) ?? 0
    if (nowMs - last >= 60_000) {
      sizeWarnedAt.set(kind, nowMs)
      onTooLarge(kind, bytes)
    }
    throw new RecordTooLargeError(
      `${kind}/${id.slice(0, 64)}: ${bytes} bytes exceeds maxDataBytes ${decl.maxDataBytes}. Bytes are never record fields - use files and ctx.peerBytes`,
    )
  }
  return json
}

/** Markers found in a stored body, by concrete path. */
export function markersOf(decl: RecordKindDeclaration, body: unknown): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  if (decl.secretPaths.length === 0) return out
  for (const leaf of collectSecretLeaves(body, decl.secretPaths, decl.secretArrayKeys)) {
    if (isSecretMarker(leaf.value)) out.set(leaf.concrete, leaf.value.$secret)
  }
  return out
}

/** Show a stored body: every set secret field becomes the redaction token. */
export function redactBody(
  decl: RecordKindDeclaration,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (decl.secretPaths.length === 0) return body
  const redacted = mapSecretLeaves(body, decl.secretPaths, decl.secretArrayKeys, (leaf) =>
    leaf.value === null ? null : REDACTED_SECRET,
  )
  return isRecord(redacted) ? redacted : body
}

/**
 * The secret rule of a write (D878, once, in the store): a secret field may
 * hold ONLY a keychain marker bound to this row's own ref. The redaction token
 * keeps the stored marker (or leaves the field absent when nothing is stored);
 * `null` removes; a plain string is refused - plaintext is never stored.
 *
 * `stored` is the row's current body (null for a new row). Returns the body to
 * write and the refs the write RELEASES (markers that were stored and are gone).
 */
export function enforceSecrets(
  owner: string,
  kind: string,
  decl: RecordKindDeclaration,
  id: string,
  body: Record<string, unknown>,
  stored: Record<string, unknown> | null,
  mode: 'put' | 'patch',
): { readonly body: Record<string, unknown>; readonly releasedRefs: readonly string[] } {
  if (decl.secretPaths.length === 0) return { body, releasedRefs: [] }
  const storedMarkers = stored === null ? new Map<string, string>() : markersOf(decl, stored)
  const next = mapSecretLeaves(body, decl.secretPaths, decl.secretArrayKeys, (leaf) => {
    const expected = recordSecretRef(owner, kind, id, leaf.concrete)
    if (isSecretMarker(leaf.value)) {
      if (leaf.value.$secret !== expected) {
        throw new ForeignSecretMarkerError(
          `${kind}/${id.slice(0, 64)} field "${leaf.concrete}": the marker is not this row's own ref`,
        )
      }
      return leaf.value
    }
    if (leaf.value === REDACTED_SECRET) {
      const keep = storedMarkers.get(leaf.concrete)
      if (keep === undefined) return REMOVE_LEAF
      // A patch leaves a plain field alone by dropping it from the merge; an array is
      // REPLACED by the merge, so its element must carry the stored marker or lose it.
      if (mode === 'patch' && !leaf.concrete.includes('[')) return REMOVE_LEAF
      return { $secret: keep, v: 1 }
    }
    if (leaf.value === null || leaf.value === undefined) {
      // A patch's null is RFC 7396 removal and is left for the merge; a put drops the field.
      return mode === 'patch' ? null : REMOVE_LEAF
    }
    throw new PlaintextSecretError(
      `${kind}/${id.slice(0, 64)} field "${leaf.concrete}": a secret field takes a keychain marker, never a value`,
    )
  })
  if (!isRecord(next)) throw new InvalidRecordError(`${kind}/${id}: the body must be an object`)
  const nextMarkers = markersOf(decl, next)
  const released = [...storedMarkers.entries()]
    .filter(([path, ref]) => mode === 'put' && nextMarkers.get(path) !== ref)
    .map(([, ref]) => ref)
  return { body: next, releasedRefs: released }
}

export function toView(row: StoredRow, decl: RecordKindDeclaration): RecordView {
  return {
    id: row.id,
    deviceId: row.deviceId,
    at: row.at,
    expiresAt: row.expiresAt,
    rev: row.rev,
    updatedAt: row.updatedAt,
    data: redactBody(decl, parseBody(row.data)),
  }
}
