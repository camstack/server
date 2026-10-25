/**
 * Serialize/deserialize non-Buffer TypedArrays for Moleculer MsgPack transport.
 *
 * MsgPack handles Buffer natively but serializes Float32Array, Int16Array etc.
 * as plain objects with numeric keys. These helpers convert them to Buffer
 * with a type tag for transport and reconstruct them on arrival.
 *
 * Used by:
 * - capability-bridge.ts (hub → child proxy calls)
 * - addon-service-factory.ts (child → provider param reconstruction)
 */

type TypedArrayCtor = { new (buffer: ArrayBuffer): ArrayBufferView; BYTES_PER_ELEMENT: number }
const TYPED_ARRAY_CTORS: Record<string, TypedArrayCtor> = {
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Uint8ClampedArray,
}

/**
 * Convert non-Buffer TypedArrays → `{ __typedArray, type, data: Buffer }` recursively.
 *
 * A WeakSet tracks objects already visited on the current descent path so a
 * cyclic input throws a precise error at the offending path instead of
 * blowing the stack with "Maximum call stack size exceeded". tRPC inputs
 * should never be cyclic in practice — this is a safety net for regressions
 * that accidentally introduce shared-reference loops (e.g. a config object
 * that holds a back-pointer into its own container).
 */
function serializeTypedArrays(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  path: string = '$',
): unknown {
  if (value === null || value === undefined) return value
  // Buffer is handled natively by MsgPack — pass through without modification.
  // Must check BEFORE the generic `typeof === 'object'` branch, because Buffer
  // is an object and Object.entries(buffer) would destructure it into numeric keys.
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const ta = value as Float32Array
    return {
      __typedArray: true,
      type: ta.constructor.name,
      data: Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength),
    }
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`serializeTypedArrays: circular reference at ${path} (array)`)
    }
    seen.add(value)
    const out = value.map((v, i) => serializeTypedArrays(v, seen, `${path}[${i}]`))
    seen.delete(value)
    return out
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error(`serializeTypedArrays: circular reference at ${path} (object)`)
    }
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeTypedArrays(v, seen, `${path}.${k}`)
    }
    seen.delete(value)
    return out
  }
  return value
}

/** Reconstruct TypedArrays from tagged objects. */
function deserializeTypedArrays(value: unknown): unknown {
  if (value === null || value === undefined) return value
  // Buffer/Uint8Array pass through — same guard as serializeTypedArrays.
  // Without this, Object.entries(buffer) would destructure binary data
  // into a plain object with numeric keys.
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value
  if (Array.isArray(value)) return value.map(deserializeTypedArrays)
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (rec['__typedArray'] === true && typeof rec['type'] === 'string') {
      const rawData = rec['data']
      // MsgPack may deserialize binary as Buffer or Uint8Array depending on the library.
      // Accept both to ensure cross-process round-trip works reliably.
      if (Buffer.isBuffer(rawData) || rawData instanceof Uint8Array) {
        const Ctor = TYPED_ARRAY_CTORS[rec['type'] as string]
        if (Ctor) {
          const buf = rawData as Uint8Array
          // Create a properly aligned copy — the underlying ArrayBuffer
          // may not be aligned to the TypedArray's BYTES_PER_ELEMENT boundary.
          const aligned = new ArrayBuffer(buf.byteLength)
          new Uint8Array(aligned).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))

          return new Ctor(aligned)
        }
      }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) {
      out[k] = deserializeTypedArrays(v)
    }
    return out
  }
  return value
}

export { serializeTypedArrays, deserializeTypedArrays }
