/**
 * Vector wire codec — base64 of little-endian Float32.
 *
 * The `vector-store` capability carries vectors as base64 rather than
 * `number[]` or a typed array, and both rejected alternatives have a scar here:
 *
 *  - a `Float32Array` does NOT survive msgpack across the UDS transport (it
 *    arrived as an empty object and froze audio dBFS until the payload was
 *    changed to carry bytes);
 *  - `number[]` is the ~5x-larger encoding the capability exists to stop paying
 *    — a 512-dim vector is 2,048 bytes raw and 2,732 as base64, against roughly
 *    10-12 KB rendered as JSON text.
 *
 * Endianness is pinned to little-endian explicitly instead of inheriting the
 * platform's, so a vector written on one node decodes correctly on another.
 */

/** Encode a vector as base64 of little-endian Float32. */
export function encodeVectorBase64(vector: Float32Array | readonly number[]): string {
  const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  const bytes = new Uint8Array(floats.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < floats.length; i += 1) {
    view.setFloat32(i * 4, floats[i] ?? 0, true)
  }
  return Buffer.from(bytes).toString('base64')
}

/**
 * Decode base64 little-endian Float32 back into a vector.
 *
 * Throws on a byte length that is not a multiple of 4 — a truncated vector
 * would otherwise silently rank against a shorter one and produce a plausible
 * score, which is worse than an error.
 */
export function decodeVectorBase64(encoded: string): Float32Array {
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.byteLength % 4 !== 0) {
    throw new Error(
      `decodeVectorBase64: ${buffer.byteLength} bytes is not a whole number of Float32 values`,
    )
  }
  const out = new Float32Array(buffer.byteLength / 4)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = buffer.readFloatLE(i * 4)
  }
  return out
}

/** Vector length implied by a base64 payload, without decoding it. */
export function vectorDimFromBase64(encoded: string): number {
  return Math.floor(Buffer.from(encoded, 'base64').byteLength / 4)
}
