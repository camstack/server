/**
 * The address of one keychain value: `secret://<owner>/<scope>/<fieldPath>`.
 *
 * A ref is DETERMINISTIC from where the value lives — the owner addon, the
 * scope (global, one node, one device, one integration, one row of a business
 * collection) and the field path inside that scope — so saving the same field
 * twice updates the same ref, and the ref itself says which settings blob
 * points at it. It is also the AAD of the value's ciphertext: a ciphertext
 * copied onto another ref does not decrypt.
 *
 * Array items are addressed by ITEM ID, never by index
 * (`providers[authentik].clientSecret`), so reordering a list keeps every ref.
 *
 * Pure and browser-safe: no node builtins, no I/O.
 */

/** The URI scheme of every keychain ref. */
export const SECRET_REF_SCHEME = 'secret://'

/** Where, inside its owner, a secret lives. */
export type SecretScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'device'; readonly deviceId: number }
  | { readonly kind: 'integration'; readonly integrationId: string }
  | { readonly kind: 'row'; readonly collection: string; readonly rowId: string }

/** A ref, taken apart. */
export interface SecretRefParts {
  readonly owner: string
  readonly scope: SecretScope
  readonly fieldPath: string
}

const GLOBAL_SCOPE: SecretScope = { kind: 'global' }

/** The scope every addon-wide (not per-node, not per-device) setting lives in. */
export function globalSecretScope(): SecretScope {
  return GLOBAL_SCOPE
}

/**
 * An addon id as a ref owner. A hub in-process builtin's context id is
 * `addon:<id>`; the owner of its secrets is `<id>`, exactly as for the same
 * addon running forked.
 */
export function normalizeSecretOwner(addonId: string): string {
  return addonId.startsWith('addon:') ? addonId.slice('addon:'.length) : addonId
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** The scope as it appears inside a ref (`global`, `node/<id>`, …). */
export function formatSecretScope(scope: SecretScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global'
    case 'node':
      return `node/${encodeSegment(scope.nodeId)}`
    case 'device':
      return `device/${scope.deviceId}`
    case 'integration':
      return `integration/${encodeSegment(scope.integrationId)}`
    case 'row':
      return `row/${encodeSegment(scope.collection)}/${encodeSegment(scope.rowId)}`
  }
}

/**
 * The field path of a value inside an array item, addressed by the item's id:
 * `arrayItemFieldPath('providers', 'authentik', 'clientSecret')` →
 * `providers[authentik].clientSecret`.
 */
export function arrayItemFieldPath(arrayKey: string, itemId: string, fieldKey: string): string {
  return `${arrayKey}[${encodeSegment(itemId)}].${fieldKey}`
}

/** Build a ref. Throws on an empty owner or field path — both are bugs. */
export function buildSecretRef(parts: SecretRefParts): string {
  const owner = normalizeSecretOwner(parts.owner)
  if (owner.length === 0) throw new Error('buildSecretRef: owner is empty')
  if (parts.fieldPath.length === 0) throw new Error('buildSecretRef: fieldPath is empty')
  return `${SECRET_REF_SCHEME}${encodeSegment(owner)}/${formatSecretScope(parts.scope)}/${parts.fieldPath}`
}

/** True when `value` is shaped like a keychain ref (not that it exists). */
export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && parseSecretRef(value) !== null
}

function parseScope(
  segments: readonly string[],
): { readonly scope: SecretScope; readonly used: number } | null {
  const head = segments[0]
  switch (head) {
    case 'global':
      return { scope: GLOBAL_SCOPE, used: 1 }
    case 'node': {
      const nodeId = segments[1] !== undefined ? decodeSegment(segments[1]) : null
      return nodeId === null || nodeId.length === 0
        ? null
        : { scope: { kind: 'node', nodeId }, used: 2 }
    }
    case 'device': {
      const raw = segments[1]
      if (raw === undefined || !/^\d+$/.test(raw)) return null
      return { scope: { kind: 'device', deviceId: Number(raw) }, used: 2 }
    }
    case 'integration': {
      const id = segments[1] !== undefined ? decodeSegment(segments[1]) : null
      return id === null || id.length === 0
        ? null
        : { scope: { kind: 'integration', integrationId: id }, used: 2 }
    }
    case 'row': {
      const collection = segments[1] !== undefined ? decodeSegment(segments[1]) : null
      const rowId = segments[2] !== undefined ? decodeSegment(segments[2]) : null
      if (collection === null || rowId === null || collection.length === 0 || rowId.length === 0) {
        return null
      }
      return { scope: { kind: 'row', collection, rowId }, used: 3 }
    }
    default:
      return null
  }
}

/** Take a ref apart; `null` when it is not a well-formed ref. */
export function parseSecretRef(ref: string): SecretRefParts | null {
  if (!ref.startsWith(SECRET_REF_SCHEME)) return null
  const rest = ref.slice(SECRET_REF_SCHEME.length)
  const segments = rest.split('/')
  const owner = segments[0] !== undefined ? decodeSegment(segments[0]) : null
  if (owner === null || owner.length === 0) return null
  const parsed = parseScope(segments.slice(1))
  if (parsed === null) return null
  const fieldPath = segments.slice(1 + parsed.used).join('/')
  if (fieldPath.length === 0) return null
  return { owner, scope: parsed.scope, fieldPath }
}
