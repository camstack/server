/**
 * Secret fields of a record, addressed the way a Zod schema declares them
 * (`collectZodSecretPaths`): dotted keys, `[]` for "each element of this array"
 * (`auth.accessToken`, `headers[].value`).
 *
 * Array elements are matched by a DECLARED id key (`secretArrayKeys`:
 * `{ headers: 'name' }`), never by index, so reordering a list keeps every
 * keychain ref (the same rule as `arrayItemFieldPath`). The concrete path of a
 * leaf names its element: `headers[X-Api].value`.
 *
 * Pure and browser-safe. Nothing here mutates: every transform returns a new value.
 */
import { arrayItemFieldPath, buildSecretRef } from '../keychain/secret-ref.js'
import { RECORD_SECRET_COLLECTION_PREFIX } from './constants.js'
import { InvalidRecordError } from './errors.js'

/** One segment of a declared path. */
export interface SecretPathSegment {
  readonly key: string
  /** `true` when the key holds an array and the path continues into each element. */
  readonly each: boolean
}

/** The array prefixes (declared form, e.g. `headers` or `a.headers`) of a path. */
export function parseSecretPath(path: string): readonly SecretPathSegment[] {
  if (path.length === 0) throw new InvalidRecordError('an empty secret path')
  return path.split('.').map((raw) => {
    const each = raw.endsWith('[]')
    const key = each ? raw.slice(0, -2) : raw
    if (key.length === 0) throw new InvalidRecordError(`secret path "${path}" has an empty segment`)
    return { key, each }
  })
}

/** The declared array prefixes of `path` that need an id key (`headers`, `a.rows`). */
export function secretArrayPrefixes(path: string): readonly string[] {
  const segments = parseSecretPath(path)
  const prefixes: string[] = []
  const walked: string[] = []
  for (const segment of segments) {
    walked.push(segment.key)
    if (segment.each) prefixes.push(walked.join('.'))
  }
  return prefixes
}

/** One secret leaf found in a record body. */
export interface SecretLeaf {
  /** The declared path it matched (`headers[].value`). */
  readonly declared: string
  /** Its concrete path, naming array elements by id (`headers[X-Api].value`). */
  readonly concrete: string
  readonly value: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function elementId(element: unknown, idKey: string, declared: string, prefix: string): string {
  const id = isRecord(element) ? element[idKey] : undefined
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidRecordError(
      `"${declared}": every element of "${prefix}" needs a non-empty string "${idKey}" to carry a secret`,
    )
  }
  return id
}

/**
 * Visit every secret leaf PRESENT in `data` (an absent branch has nothing to
 * visit). `replace` returns the new leaf value, or {@link REMOVE_LEAF}; the
 * result is a new body, `data` is untouched.
 */
export const REMOVE_LEAF: unique symbol = Symbol('remove-leaf')

export type LeafReplacement = unknown | typeof REMOVE_LEAF

function mapAt(
  node: unknown,
  segments: readonly SecretPathSegment[],
  index: number,
  walkedKeys: readonly string[],
  concretePrefix: string,
  declared: string,
  arrayKeys: Readonly<Record<string, string>>,
  visit: (leaf: SecretLeaf) => LeafReplacement,
): unknown {
  if (!isRecord(node)) return node
  const segment = segments[index]
  if (segment === undefined) return node
  const present = Object.prototype.hasOwnProperty.call(node, segment.key)
  if (!present) return node
  const child = node[segment.key]
  const keys = [...walkedKeys, segment.key]
  const last = index === segments.length - 1

  if (segment.each) {
    if (!Array.isArray(child)) return node
    const prefix = keys.join('.')
    const idKey = arrayKeys[prefix]
    if (idKey === undefined) {
      throw new InvalidRecordError(`"${declared}": no id key declared for the array "${prefix}"`)
    }
    const mapped = child.map((element: unknown) => {
      const id = elementId(element, idKey, declared, prefix)
      const concrete = `${concretePrefix}${concretePrefix.length > 0 ? '.' : ''}${segment.key}[${encodeURIComponent(id)}]`
      return last
        ? element
        : mapAt(element, segments, index + 1, keys, concrete, declared, arrayKeys, visit)
    })
    return { ...node, [segment.key]: mapped }
  }

  const concrete = `${concretePrefix}${concretePrefix.length > 0 ? '.' : ''}${segment.key}`
  if (last) {
    const replacement = visit({ declared, concrete, value: child })
    if (replacement === REMOVE_LEAF) {
      return Object.fromEntries(Object.entries(node).filter(([key]) => key !== segment.key))
    }
    return { ...node, [segment.key]: replacement }
  }
  return {
    ...node,
    [segment.key]: mapAt(child, segments, index + 1, keys, concrete, declared, arrayKeys, visit),
  }
}

/** Replace/remove every present secret leaf; returns a NEW body. */
export function mapSecretLeaves(
  data: unknown,
  paths: readonly string[],
  arrayKeys: Readonly<Record<string, string>>,
  visit: (leaf: SecretLeaf) => LeafReplacement,
): unknown {
  let current = data
  for (const declared of paths) {
    current = mapAt(current, parseSecretPath(declared), 0, [], '', declared, arrayKeys, visit)
  }
  return current
}

/** Every present secret leaf, read-only. */
export function collectSecretLeaves(
  data: unknown,
  paths: readonly string[],
  arrayKeys: Readonly<Record<string, string>>,
): readonly SecretLeaf[] {
  const found: SecretLeaf[] = []
  mapSecretLeaves(data, paths, arrayKeys, (leaf) => {
    found.push(leaf)
    return leaf.value
  })
  return found
}

/**
 * The keychain collection name a kind's secrets live under. Prefixed so a
 * record's refs never collide with the refs a legacy collection of the same name
 * already holds during an adoption.
 */
export function recordSecretCollection(kind: string): string {
  return `${RECORD_SECRET_COLLECTION_PREFIX}${kind}`
}

/** The ONE ref a row's secret field may carry: the engine and the facade both build it here. */
export function recordSecretRef(
  owner: string,
  kind: string,
  rowId: string,
  concretePath: string,
): string {
  return buildSecretRef({
    owner,
    scope: { kind: 'row', collection: recordSecretCollection(kind), rowId },
    fieldPath: concretePath,
  })
}

/** A concrete path built from a flat array item, re-exported for adoption tooling. */
export const recordArrayItemPath = arrayItemFieldPath
