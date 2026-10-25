/**
 * The row rules of the records engine for the in-memory world. MIRRORS
 * `packages/system/src/builtins/sqlite-storage/records/records-rows.ts`
 * (`validateHeader`, `enforceSecrets`, the `maxDataBytes` refusal); the
 * contract spec in `@camstack/system` holds the two together.
 */
import { REDACTED_SECRET } from '../interfaces/config-ui-secrets.js'
import { isSecretMarker } from '../keychain/secret-marker.js'
import { RECORD_ID_MAX_LENGTH } from './constants.js'
import {
  ForeignSecretMarkerError,
  InvalidRecordError,
  PlaintextSecretError,
  RecordTooLargeError,
} from './errors.js'
import type { RecordKindDeclaration } from './record-kind.js'
import {
  collectSecretLeaves,
  mapSecretLeaves,
  recordSecretRef,
  REMOVE_LEAF,
} from './secret-paths.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What a write is allowed to say about a row, after the kind's rules. */
export interface WriteHeader {
  readonly id: string
  readonly deviceId: number | null
  readonly at: number | null
  readonly expiresAt: number | null
}

/** The header fields of a write. */
export interface HeaderInput {
  readonly id: string
  readonly deviceId?: number | undefined
  readonly at?: number | undefined
  readonly expiresAt?: number | undefined
}

export function validateHeader(
  kind: string,
  decl: RecordKindDeclaration,
  rec: HeaderInput,
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
  return {
    id: rec.id,
    deviceId: rec.deviceId ?? null,
    at: rec.at ?? null,
    expiresAt,
  }
}

/** The stored text of a body; refuses one over `maxDataBytes`. */
export function serializeBody(
  kind: string,
  decl: RecordKindDeclaration,
  id: string,
  body: Record<string, unknown>,
): string {
  const json = JSON.stringify(body)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > decl.maxDataBytes) {
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

/** Every set secret field becomes the redaction token. */
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

/** The engine's secret rule of a write (D878): see `records-rows.ts` `enforceSecrets`. */
export function enforceSecrets(
  owner: string,
  kind: string,
  decl: RecordKindDeclaration,
  id: string,
  body: Record<string, unknown>,
  stored: Record<string, unknown> | null,
  mode: 'put' | 'patch',
): {
  readonly body: Record<string, unknown>
  readonly releasedRefs: readonly string[]
} {
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
      if (mode === 'patch' && !leaf.concrete.includes('[')) return REMOVE_LEAF
      return { $secret: keep, v: 1 }
    }
    if (leaf.value === null || leaf.value === undefined) {
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

/** RFC 7396, as `jsonb_patch`: objects merge key by key, `null` removes, anything else replaces. */
export function mergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const current = out[key]
    out[key] = isRecord(value) ? mergePatch(isRecord(current) ? current : {}, value) : value
  }
  return out
}

/** A JSON round trip: what the engine stores and hands back is never the caller's object. */
export function jsonCopy(body: Record<string, unknown>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(body))
  if (!isRecord(parsed)) throw new InvalidRecordError('a stored body is not an object')
  return parsed
}
