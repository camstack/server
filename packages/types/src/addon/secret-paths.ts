/**
 * WHERE an addon's secrets live in its settings blob — derived from the
 * field TYPE (`type: 'password'` or `secret: true`, `storage` not `'inline'`)
 * and from the addon's declared `secretStatePaths`, NEVER from a key's name
 * (operator decision, D787). A text field called `password` is not secret; a
 * textarea holding a PEM key with `secret: true` is.
 *
 * The result is a small tree over the blob's top-level keys:
 *  - `leaf`   — the value at this key is a secret;
 *  - `object` — descend into a nested object (`identity.pincode`);
 *  - `array`  — every item, matched by its id field, has secret members
 *               (`providers[id].clientSecret`, `tokens[userId].accessToken`).
 *
 * `secretStatePaths` syntax: dot-separated keys, an array segment written
 * `key[<idField>]`: `'snapshotSigningKey'`, `'identity.pincode'`,
 * `'tokens[userId].accessToken'`.
 */
import type { ConfigField, ConfigUISchema } from '../interfaces/config-ui.js'
import { isKeychainStoredField } from '../interfaces/config-ui-secrets.js'

export type SecretNode =
  | { readonly kind: 'leaf' }
  | { readonly kind: 'object'; readonly children: ReadonlyMap<string, SecretNode> }
  | {
      readonly kind: 'array'
      readonly idKey: string
      readonly item: ReadonlyMap<string, SecretNode>
    }

export type SecretTree = ReadonlyMap<string, SecretNode>

const LEAF: SecretNode = { kind: 'leaf' }
const DEFAULT_ITEM_ID_KEY = 'id'

export { isKeychainStoredField }

function collectFields(fields: readonly ConfigField[], out: Map<string, SecretNode>): void {
  for (const field of fields) {
    if (field.type === 'group') {
      collectFields(field.fields, out)
      continue
    }
    if (field.type === 'sub-tabs') {
      for (const tab of field.tabs) collectFields(tab.fields, out)
      continue
    }
    if (field.type === 'editable-array') {
      const item = new Map<string, SecretNode>()
      for (const itemField of field.itemFields) {
        if ('key' in itemField && isKeychainStoredField(itemField)) item.set(itemField.key, LEAF)
      }
      if (item.size > 0) {
        out.set(field.key, { kind: 'array', idKey: field.itemIdKey ?? DEFAULT_ITEM_ID_KEY, item })
      }
      continue
    }
    if (!('key' in field) || typeof field.key !== 'string') continue
    if (isKeychainStoredField(field)) out.set(field.key, LEAF)
  }
}

/** The secret tree a settings schema declares. */
export function secretTreeFromSchema(schema: ConfigUISchema | null): SecretTree {
  const out = new Map<string, SecretNode>()
  if (schema === null) return out
  for (const section of schema.sections) collectFields(section.fields, out)
  return out
}

interface PathSegment {
  readonly key: string
  /** Set when the segment is an array: the item id field. */
  readonly idKey?: string
}

/** Parse `a.b[id].c` into segments; throws on a malformed path (a declaration bug). */
export function parseSecretStatePath(path: string): readonly PathSegment[] {
  const segments: PathSegment[] = []
  for (const raw of path.split('.')) {
    const m = /^([^[\]]+)(?:\[([^[\]]+)\])?$/.exec(raw)
    if (m === null || m[1] === undefined) {
      throw new Error(`secretStatePaths: malformed path "${path}"`)
    }
    segments.push(m[2] !== undefined ? { key: m[1], idKey: m[2] } : { key: m[1] })
  }
  if (segments.length === 0) throw new Error(`secretStatePaths: empty path`)
  const last = segments[segments.length - 1]
  if (last?.idKey !== undefined) {
    throw new Error(`secretStatePaths: "${path}" ends on an array — name the member that is secret`)
  }
  return segments
}

function insert(into: Map<string, SecretNode>, segments: readonly PathSegment[]): void {
  const [head, ...rest] = segments
  if (head === undefined) return
  if (rest.length === 0) {
    into.set(head.key, LEAF)
    return
  }
  const existing = into.get(head.key)
  if (head.idKey !== undefined) {
    const item = new Map(existing?.kind === 'array' ? existing.item : [])
    insert(item, rest)
    into.set(head.key, { kind: 'array', idKey: head.idKey, item })
    return
  }
  const children = new Map(existing?.kind === 'object' ? existing.children : [])
  insert(children, rest)
  into.set(head.key, { kind: 'object', children })
}

/** Add hidden-state paths (`secretStatePaths`) to a schema-derived tree. */
export function mergeSecretStatePaths(tree: SecretTree, paths: readonly string[]): SecretTree {
  if (paths.length === 0) return tree
  const out = new Map(tree)
  for (const path of paths) insert(out, parseSecretStatePath(path))
  return out
}

/**
 * The tree of a DECLARED path list — a device's `secretConfigPaths`
 * (`collectZodSecretPaths`: dotted, `[]` for array items). An array segment
 * without a named id field is addressed by the item's `id`.
 */
export function secretTreeFromPaths(paths: readonly string[]): SecretTree {
  const out = new Map<string, SecretNode>()
  for (const path of paths) {
    if (path.length === 0) continue
    insert(out, parseSecretStatePath(path.replace(/\[\]/g, `[${DEFAULT_ITEM_ID_KEY}]`)))
  }
  return out
}
