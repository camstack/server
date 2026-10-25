/** Returns true when `x` is a non-null, non-array plain object. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** Read a dot-path (`a.b.c`) out of an object. Returns `undefined` for any
 *  missing/non-object segment — never throws. */
export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (!isRecord(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

/** Immutably set a dot-path on an object, returning a new object. Intermediate
 *  objects are created when a segment is missing or null. Arrays are NOT
 *  traversed (P1 has no array-index syntax — see `itemKey` grouping in P2): if a
 *  segment resolves to an array it is replaced by a fresh object, so the array
 *  is discarded — the only caller (`mergeLinkedStatus`) re-validates the result
 *  with the target cap's Zod schema and rejects a malformed overlay.
 *  The return type `T` preserves the OUTER shape; the rewritten key is not
 *  narrowed, so callers should re-validate against the status schema. */
export function setByPath<T extends Record<string, unknown>>(
  obj: T,
  path: string,
  value: unknown,
): T {
  const dotIndex = path.indexOf('.')
  if (dotIndex === -1) {
    // Leaf — set the key directly.
    return { ...obj, [path]: value }
  }
  const head = path.slice(0, dotIndex)
  const tail = path.slice(dotIndex + 1)
  const child: unknown = obj[head]
  const childObj: Record<string, unknown> = isRecord(child) ? child : {}
  return { ...obj, [head]: setByPath(childObj, tail, value) }
}
