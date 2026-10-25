/**
 * The secret-aware half of an addon's settings store (D787).
 *
 * WRITE — `transformSecretWrite` rewrites a patch before it reaches the store:
 * every secret path (see `secret-paths.ts`) is classified by
 * `classifySecretWrite` and
 *  - KEEP  (`''`, `null`, a marker, a UI view, a redaction token) — the stored
 *          value stays exactly as it is; `''` NEVER clears;
 *  - SET   (a non-empty string) — `put` into the keychain FIRST, then the
 *          marker goes into the patch. A value equal to what the ref already
 *          holds is not re-put;
 *  - CLEAR (`{"$secretClear":true}` only) — the marker becomes `null`, and the
 *          ref is deleted AFTER the blob write succeeded.
 * Array items are matched by their id field: a reorder keeps refs, a removed
 * row's refs are deleted after the write, a copied row's secret is "not set".
 * Order is always put → blob → delete: a failed blob write can leave an orphan
 * (the Secrets page collects it), never a marker pointing at nothing.
 *
 * STRICT: when a value cannot be stored (keychain locked or unreachable) the
 * write is REFUSED. It never falls back to writing the plaintext into the blob,
 * and nothing migrates plaintext silently — a blob that still holds an inline
 * value keeps it until the operator's one-off migration.
 *
 * READ — `resolveSecretMarkers` substitutes every marker at any depth with its
 * value, in ONE keychain round-trip, before the runtime config is assembled. A
 * value that cannot be resolved is reported and left OUT (never `''`), so the
 * caller can say so instead of starting on an empty credential.
 */
import type { KeychainUnavailableReason } from '../capabilities/keychain.cap.js'
import {
  classifySecretWrite,
  isSecretMarker,
  makeSecretMarker,
  type SecretMarker,
} from '../keychain/secret-marker.js'
import {
  arrayItemFieldPath,
  globalSecretScope,
  parseSecretRef,
  type SecretScope,
} from '../keychain/secret-ref.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import type { SecretNode, SecretTree } from './secret-paths.js'

/** A write to a secret path could not be stored in the keychain, so it was refused. */
export class KeychainWriteRefusedError extends Error {
  constructor(
    readonly fieldPath: string,
    cause: unknown,
  ) {
    super(
      `secret "${fieldPath}" was not saved: the keychain could not store it ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). Nothing was written.`,
    )
    this.name = 'KeychainWriteRefusedError'
  }
}

export interface SecretWriteInput {
  readonly tree: SecretTree
  readonly secrets: SecretsAccess
  readonly patch: Record<string, unknown>
  /** The blob as stored now (markers, not values). */
  readonly stored: Record<string, unknown>
  /** Scope of a non-perNode key: `global` for the addon store, `device/<id>` for a device store. */
  readonly scope?: SecretScope
  readonly mintId?: () => string
  /**
   * The write comes from the OPERATOR (a settings form, an admin API call),
   * not from the addon's own code: a value equal to an inline pre-keychain one
   * is then stored as sent — in the keychain. An addon's own write-back of an
   * unchanged inline value keeps it inline (nothing migrates silently).
   */
  readonly operatorWrite?: boolean
}

export interface SecretWriteResult {
  /** The patch to write: markers in place of values. */
  readonly patch: Record<string, unknown>
  /** Delete the refs this write dropped. Call ONLY after the blob write succeeded. */
  readonly afterWrite: () => Promise<{ readonly orphaned: readonly string[] }>
}

type NodeResult = { readonly kind: 'keep' } | { readonly kind: 'value'; readonly value: unknown }

const KEEP: NodeResult = { kind: 'keep' }

interface WriteContext {
  readonly secrets: SecretsAccess
  readonly scope: SecretScope
  readonly operatorWrite: boolean
  readonly mintId: () => string
  readonly deletes: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultMintId(): string {
  return globalThis.crypto.randomUUID()
}

/** Every marker ref anywhere under `value`. */
export function collectSecretMarkerRefs(value: unknown, out: string[] = []): string[] {
  if (isSecretMarker(value)) {
    out.push(value.$secret)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretMarkerRefs(item, out)
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectSecretMarkerRefs(child, out)
  }
  return out
}

async function storedValueEquals(
  secrets: SecretsAccess,
  marker: SecretMarker,
  candidate: string,
): Promise<boolean> {
  const resolved = (await secrets.resolve([marker.$secret]))[marker.$secret]
  return resolved?.kind === 'value' && resolved.value === candidate
}

async function writeLeaf(
  ctx: WriteContext,
  incoming: unknown,
  stored: unknown,
  fieldPath: string,
): Promise<NodeResult> {
  const intent = classifySecretWrite(incoming)
  const ref = ctx.secrets.ref(ctx.scope, fieldPath)
  const storedIsOurs = isSecretMarker(stored) && stored.$secret === ref
  if (intent.kind === 'keep') return KEEP
  // The SAME plaintext a pre-keychain blob already holds is written back by
  // any whole-config save. That is not a change, and converting it here would
  // be a silent migration — the operator's one-off script is the only
  // migrator. It stays inline until it is really changed.
  if (
    intent.kind === 'set' &&
    !ctx.operatorWrite &&
    typeof stored === 'string' &&
    stored === intent.value
  ) {
    return KEEP
  }
  if (intent.kind === 'clear') {
    if (storedIsOurs) ctx.deletes.push(ref)
    return { kind: 'value', value: null }
  }
  if (storedIsOurs && (await storedValueEquals(ctx.secrets, stored, intent.value))) {
    return { kind: 'value', value: stored }
  }
  try {
    await ctx.secrets.put(ref, intent.value)
  } catch (err: unknown) {
    throw new KeychainWriteRefusedError(fieldPath, err)
  }
  return { kind: 'value', value: makeSecretMarker(ref) }
}

/** Apply a member result onto `out`: KEEP restores the stored member, or removes it. */
function applyMember(
  out: Record<string, unknown>,
  key: string,
  result: NodeResult,
  storedParent: Record<string, unknown>,
): void {
  if (result.kind === 'value') {
    out[key] = result.value
    return
  }
  if (Object.prototype.hasOwnProperty.call(storedParent, key)) out[key] = storedParent[key]
  else delete out[key]
}

async function writeMembers(
  ctx: WriteContext,
  children: ReadonlyMap<string, SecretNode>,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
  pathOf: (member: string) => string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...incoming }
  for (const [member, node] of children) {
    const result = await writeNode(ctx, node, incoming[member], stored[member], pathOf(member))
    applyMember(out, member, result, stored)
  }
  return out
}

function rowId(row: Record<string, unknown>, idKey: string): string | null {
  const raw = row[idKey]
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

async function writeArray(
  ctx: WriteContext,
  node: Extract<SecretNode, { kind: 'array' }>,
  incoming: unknown,
  stored: unknown,
  fieldPath: string,
): Promise<NodeResult> {
  const storedRows = Array.isArray(stored) ? stored.filter(isRecord) : []
  if (!Array.isArray(incoming)) {
    // The whole list was replaced by a non-list: every ref it held goes.
    ctx.deletes.push(...collectSecretMarkerRefs(storedRows))
    return { kind: 'value', value: incoming }
  }
  const storedById = new Map<string, Record<string, unknown>>()
  for (const row of storedRows) {
    const id = rowId(row, node.idKey)
    if (id !== null) storedById.set(id, row)
  }
  const kept = new Set<string>()
  const rows: unknown[] = []
  for (const row of incoming) {
    if (!isRecord(row)) {
      rows.push(row)
      continue
    }
    const id = rowId(row, node.idKey) ?? ctx.mintId()
    kept.add(id)
    const withId: Record<string, unknown> = { ...row, [node.idKey]: row[node.idKey] ?? id }
    if (rowId(withId, node.idKey) === null) withId[node.idKey] = id
    const storedRow = storedById.get(id) ?? {}
    rows.push(
      await writeMembers(ctx, node.item, withId, storedRow, (member) =>
        arrayItemFieldPath(fieldPath, id, member),
      ),
    )
  }
  for (const [id, row] of storedById) {
    if (!kept.has(id)) ctx.deletes.push(...collectSecretMarkerRefs(row))
  }
  return { kind: 'value', value: rows }
}

async function writeNode(
  ctx: WriteContext,
  node: SecretNode,
  incoming: unknown,
  stored: unknown,
  fieldPath: string,
): Promise<NodeResult> {
  switch (node.kind) {
    case 'leaf':
      return writeLeaf(ctx, incoming, stored, fieldPath)
    case 'array':
      return writeArray(ctx, node, incoming, stored, fieldPath)
    case 'object': {
      if (!isRecord(incoming)) {
        if (incoming === undefined) return KEEP
        ctx.deletes.push(...collectSecretMarkerRefs(stored))
        return { kind: 'value', value: incoming }
      }
      const storedObj = isRecord(stored) ? stored : {}
      return {
        kind: 'value',
        value: await writeMembers(
          ctx,
          node.children,
          incoming,
          storedObj,
          (m) => `${fieldPath}.${m}`,
        ),
      }
    }
  }
}

/** Split a perNode-scoped key (`key@nodeId`). */
function splitNodeKey(key: string): { readonly base: string; readonly nodeId: string | null } {
  const at = key.indexOf('@')
  return at <= 0
    ? { base: key, nodeId: null }
    : { base: key.slice(0, at), nodeId: key.slice(at + 1) }
}

/** Rewrite a settings patch so no secret value reaches the blob. See the file doc. */
export async function transformSecretWrite(input: SecretWriteInput): Promise<SecretWriteResult> {
  const deletes: string[] = []
  const base: Omit<WriteContext, 'scope'> = {
    secrets: input.secrets,
    mintId: input.mintId ?? defaultMintId,
    deletes,
    operatorWrite: input.operatorWrite === true,
  }
  const out: Record<string, unknown> = {}
  for (const [key, incoming] of Object.entries(input.patch)) {
    const { base: baseKey, nodeId } = splitNodeKey(key)
    const node = input.tree.get(baseKey)
    if (node === undefined) {
      out[key] = incoming
      continue
    }
    const scope: SecretScope =
      nodeId !== null && nodeId.length > 0
        ? { kind: 'node', nodeId }
        : (input.scope ?? globalSecretScope())
    const result = await writeNode({ ...base, scope }, node, incoming, input.stored[key], baseKey)
    // A top-level KEEP leaves the key out of the patch: the store merges, so
    // the stored marker (or inline value) is untouched.
    if (result.kind === 'value') out[key] = result.value
  }
  return {
    patch: out,
    afterWrite: async () => {
      if (deletes.length === 0) return { orphaned: [] }
      try {
        await input.secrets.delete([...new Set(deletes)])
        return { orphaned: [] }
      } catch {
        return { orphaned: [...new Set(deletes)] }
      }
    },
  }
}

export type UnresolvedReason = KeychainUnavailableReason | 'missing' | 'forbidden'

export interface UnresolvedSecret {
  readonly ref: string
  readonly reason: UnresolvedReason
}

export interface ResolvedSecrets<T> {
  readonly value: T
  readonly unresolved: readonly UnresolvedSecret[]
}

/**
 * What a marker that cannot be resolved becomes:
 *  - `omit` (default) — the member is LEFT OUT, so a typed default applies
 *    (`config`, `state()`, a driver's device config);
 *  - `keep-marker` — the marker STAYS where it is. An addon-facing raw read
 *    (D798) answers "stored, but unavailable right now": present, not a string,
 *    `isSecretMarker()` true. Never `''`, never absent — both of those read as
 *    "nothing stored" and invite a regenerate-and-save over the kept value.
 */
export type UnresolvedMarkerMode = 'omit' | 'keep-marker'

export interface ResolveSecretMarkersOptions {
  readonly unresolved?: UnresolvedMarkerMode
  /**
   * Resolve only the markers this owner's refs: any other owner's marker is
   * left exactly as it is — not resolved, not reported. A system builtin that
   * keeps OTHER addons' markers in its own store (device-manager holds each
   * driver's) must not ask the keychain for values it may not read.
   */
  readonly ownedBy?: string
}

/** Is `ref` one of `owner`'s refs? */
export function isSecretRefOwnedBy(ref: string, owner: string): boolean {
  return parseSecretRef(ref)?.owner === owner
}

/**
 * Replace every marker in `value` with its keychain value. Returns the SAME
 * reference when there is no marker (no allocation, no keychain call).
 */
export async function resolveSecretMarkers<T>(
  value: T,
  secrets: SecretsAccess,
  options: ResolveSecretMarkersOptions = {},
): Promise<ResolvedSecrets<T>> {
  const keepMarker = options.unresolved === 'keep-marker'
  const owner = options.ownedBy
  const inScope = (ref: string): boolean => owner === undefined || isSecretRefOwnedBy(ref, owner)
  const refs = collectSecretMarkerRefs(value).filter(inScope)
  if (refs.length === 0) return { value, unresolved: [] }
  const answers = await secrets.resolve(refs)
  const unresolved: UnresolvedSecret[] = []
  for (const ref of new Set(refs)) {
    const answer = answers[ref]
    if (answer === undefined) unresolved.push({ ref, reason: 'not-initialized' })
    else if (answer.kind === 'unavailable') unresolved.push({ ref, reason: answer.reason })
    else if (answer.kind === 'missing' || answer.kind === 'forbidden') {
      unresolved.push({ ref, reason: answer.kind })
    }
  }
  const substitute = (v: unknown): { readonly keep: boolean; readonly value: unknown } => {
    if (isSecretMarker(v)) {
      if (!inScope(v.$secret)) return { keep: true, value: v }
      const answer = answers[v.$secret]
      if (answer?.kind === 'value') return { keep: true, value: answer.value }
      return keepMarker ? { keep: true, value: v } : { keep: false, value: undefined }
    }
    if (Array.isArray(v)) {
      const items: unknown[] = []
      for (const item of v) {
        const s = substitute(item)
        if (s.keep) items.push(s.value)
      }
      return { keep: true, value: items }
    }
    if (isRecord(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(v)) {
        const s = substitute(child)
        if (s.keep) out[k] = s.value
      }
      return { keep: true, value: out }
    }
    return { keep: true, value: v }
  }
  // Documented boundary: substitution keeps the shape of T and swaps markers
  // for the strings they stand for — exactly what T declared at those paths.
  return { value: substitute(value).value as T, unresolved }
}
