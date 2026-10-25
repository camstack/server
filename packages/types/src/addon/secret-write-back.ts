/**
 * Writing back what an addon READ (D798).
 *
 * An addon-facing read of a settings store answers keychain VALUES, not
 * markers. Code that reads a blob and writes the whole thing back therefore
 * sends values where the store holds markers. This pass runs before the
 * schema-driven save path (`transformSecretWrite`) and turns that write-back
 * into exactly what it is — no change — at EVERY position where the stored
 * blob holds one of this owner's markers, declared secret or not:
 *
 *  - the value the marker resolves to → the marker (no put, no new version);
 *  - `''`, `null`, a redaction token → the marker (KEEP; `''` never clears);
 *  - another non-empty string → stored under the SAME ref (`put`), then the
 *    marker — never plaintext in the blob;
 *  - while the stored value cannot be resolved (`unavailable`, `forbidden`)
 *    an ADDON's new value is REFUSED ({@link SecretOverwriteRefusedError}):
 *    the addon cannot know what it would replace, and "I could not read it,
 *    so I minted a new one" is the regenerate-on-missing loop that rotated
 *    Reolink's SMTP password ~233 times a minute. The operator's own write
 *    still goes through (it is a deliberate change). `missing` is not refused:
 *    the ref is gone, and re-minting it is legitimate.
 *
 * Arrays are matched only where it is safe: a row's value equal to the
 * resolved value of the marker at the same index becomes that marker (the
 * content is identical either way). Everything else in an array is left to
 * `transformSecretWrite`, which matches rows by their id field.
 *
 * Pure apart from the `SecretsAccess` calls; browser-safe.
 */
import type { KeychainResolveResult } from '../capabilities/keychain.cap.js'
import {
  classifySecretWrite,
  isSecretMarker,
  type SecretMarker,
} from '../keychain/secret-marker.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import type { SecretNode, SecretTree } from './secret-paths.js'
import {
  collectSecretMarkerRefs,
  isSecretRefOwnedBy,
  KeychainWriteRefusedError,
} from './secret-settings-view.js'

/** An addon tried to replace a stored secret it could not read. Nothing was written. */
export class SecretOverwriteRefusedError extends Error {
  constructor(
    readonly ref: string,
    readonly reason: string,
  ) {
    super(
      `secret ${ref} was not replaced: its stored value cannot be read right now (${reason}), ` +
        'and an addon may not overwrite a secret it cannot see. Nothing was written.',
    )
    this.name = 'SecretOverwriteRefusedError'
  }
}

export interface RestoreSecretsInput {
  readonly patch: Record<string, unknown>
  /** The blob as stored now (markers). */
  readonly stored: Record<string, unknown>
  readonly secrets: SecretsAccess
  /** The write is the operator's (a form, an admin API call), not the addon's own code. */
  readonly operatorWrite: boolean
}

export interface RestoreSecretsResult {
  readonly patch: Record<string, unknown>
  /** Refs whose keychain value this pass changed (a `put`). */
  readonly changedRefs: readonly string[]
}

interface Pass {
  readonly secrets: SecretsAccess
  readonly answers: KeychainResolveResult
  readonly operatorWrite: boolean
  readonly changedRefs: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolvedValue(pass: Pass, marker: SecretMarker): string | null {
  const answer = pass.answers[marker.$secret]
  return answer?.kind === 'value' ? answer.value : null
}

async function atMarker(pass: Pass, incoming: unknown, stored: SecretMarker): Promise<unknown> {
  if (incoming === null) return stored
  if (typeof incoming !== 'string') return incoming
  if (incoming === resolvedValue(pass, stored)) return stored
  const intent = classifySecretWrite(incoming)
  if (intent.kind !== 'set') return stored
  const ref = stored.$secret
  if (!isSecretRefOwnedBy(ref, pass.secrets.owner)) return incoming
  const answer = pass.answers[ref]
  const unreadable =
    answer === undefined || answer.kind === 'unavailable' || answer.kind === 'forbidden'
  if (unreadable && !pass.operatorWrite) {
    const reason =
      answer === undefined
        ? 'not-initialized'
        : answer.kind === 'unavailable'
          ? answer.reason
          : answer.kind
    throw new SecretOverwriteRefusedError(ref, reason)
  }
  try {
    await pass.secrets.put(ref, intent.value)
  } catch (err: unknown) {
    throw new KeychainWriteRefusedError(ref, err)
  }
  pass.changedRefs.push(ref)
  return stored
}

function inArray(pass: Pass, incoming: readonly unknown[], stored: readonly unknown[]): unknown[] {
  return incoming.map((item, index) => {
    const twin = stored[index]
    if (isSecretMarker(twin)) {
      return typeof item === 'string' && item === resolvedValue(pass, twin) ? twin : item
    }
    if (isRecord(item) && isRecord(twin)) return inArrayRow(pass, item, twin)
    if (Array.isArray(item) && Array.isArray(twin)) return inArray(pass, item, twin)
    return item
  })
}

function inArrayRow(
  pass: Pass,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming }
  for (const [key, value] of Object.entries(incoming)) {
    const twin = stored[key]
    if (isSecretMarker(twin)) {
      if (typeof value === 'string' && value === resolvedValue(pass, twin)) out[key] = twin
    } else if (isRecord(value) && isRecord(twin)) {
      out[key] = inArrayRow(pass, value, twin)
    } else if (Array.isArray(value) && Array.isArray(twin)) {
      out[key] = inArray(pass, value, twin)
    }
  }
  return out
}

async function walk(pass: Pass, incoming: unknown, stored: unknown): Promise<unknown> {
  if (isSecretMarker(stored)) return atMarker(pass, incoming, stored)
  if (Array.isArray(incoming) && Array.isArray(stored)) return inArray(pass, incoming, stored)
  if (!isRecord(incoming) || !isRecord(stored)) return incoming
  const out: Record<string, unknown> = { ...incoming }
  for (const [key, value] of Object.entries(incoming)) {
    out[key] = await walk(pass, value, stored[key])
  }
  return out
}

/** Restore markers a write-back carries as values. See the file doc. */
export async function restoreUnchangedSecrets(
  input: RestoreSecretsInput,
): Promise<RestoreSecretsResult> {
  const refs: string[] = []
  for (const key of Object.keys(input.patch)) collectSecretMarkerRefs(input.stored[key], refs)
  const owned = refs.filter((ref) => isSecretRefOwnedBy(ref, input.secrets.owner))
  if (owned.length === 0) return { patch: input.patch, changedRefs: [] }
  const pass: Pass = {
    secrets: input.secrets,
    answers: await input.secrets.resolve([...new Set(owned)]),
    operatorWrite: input.operatorWrite,
    changedRefs: [],
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.patch)) {
    out[key] = await walk(pass, value, input.stored[key])
  }
  return { patch: out, changedRefs: pass.changedRefs }
}

/** Structural equality over JSON-shaped values (key order does not matter). */
export function isJsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => isJsonEqual(v, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && isJsonEqual(a[k], b[k]))
  }
  return false
}

/** The patch without the keys whose value already equals the stored one. */
export function dropUnchangedKeys(
  patch: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const present = Object.prototype.hasOwnProperty.call(stored, key)
    if (present && isJsonEqual(value, stored[key])) continue
    out[key] = value
  }
  return out
}

/** The top-level keys of a blob that hold at least one of `owner`'s markers. */
export function markerKeysOf(blob: Record<string, unknown>, owner: string): Set<string> {
  const keys = new Set<string>()
  for (const [key, value] of Object.entries(blob)) {
    if (collectSecretMarkerRefs(value).some((ref) => isSecretRefOwnedBy(ref, owner))) keys.add(key)
  }
  return keys
}

function nodeFromStored(value: unknown, owner: string): SecretNode | null {
  if (isSecretMarker(value))
    return isSecretRefOwnedBy(value.$secret, owner) ? { kind: 'leaf' } : null
  if (!isRecord(value)) return null
  const children = new Map<string, SecretNode>()
  for (const [key, child] of Object.entries(value)) {
    const node = nodeFromStored(child, owner)
    if (node !== null) children.set(key, node)
  }
  return children.size > 0 ? { kind: 'object', children } : null
}

/**
 * The declared secret tree, widened by every place the STORED blob holds a
 * marker under one of `keys` — so a marker the schema no longer declares (or
 * never declared: Wyze before b4906cec6) still gets the save path's
 * KEEP / SET / CLEAR semantics instead of being overwritten by whatever the
 * addon writes. Markers inside arrays are not added: a row has no id field to
 * match by unless the schema declares one. Only `owner`'s markers count: a
 * builtin that keeps another addon's marker (device-manager) never takes it
 * over.
 */
export function widenTreeWithStoredMarkers(
  declared: SecretTree,
  stored: Record<string, unknown>,
  keys: readonly string[],
  owner: string,
): SecretTree {
  const added = new Map<string, SecretNode>()
  for (const key of keys) {
    const at = key.indexOf('@')
    const base = at > 0 ? key.slice(0, at) : key
    if (declared.has(base) || added.has(base)) continue
    const node = nodeFromStored(stored[key], owner)
    if (node !== null) added.set(base, node)
  }
  return added.size === 0 ? declared : new Map([...declared, ...added])
}
