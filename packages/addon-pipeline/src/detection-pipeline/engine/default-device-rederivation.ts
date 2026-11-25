/**
 * Which device the node default moves to when the one it was derived on is
 * terminally failed (planning#720).
 *
 * The node default is derived once, from the hardware probe. The probe can list
 * an accelerator the runtime then refuses to open (an Intel iGPU OpenVINO no
 * longer enumerates): the default pool is that corpse, and every dispatch that
 * carries no device key — a detail step, a capability fallback — lands on it.
 * A device marked failed or absent is never used, so the default follows the
 * same ordered list the derivation read, skipping what is failed.
 *
 * Pure. `backoff` is not a reason to move: it ends by itself in seconds.
 */
export interface NextDefaultDeviceInput {
  /** The node's enumerated device keys, best first — what the derivation chose from. */
  readonly candidates: readonly string[]
  /** The pool key of the current default (`deviceKeyOf(currentEngine)`). */
  readonly currentKey: string
  /** The pool key a candidate resolves to (`cpu` → `cpu:cpu`). */
  readonly poolKeyOf: (candidate: string) => string
  /** Terminally failed, under either spelling of its key. */
  readonly failed: (deviceKey: string) => boolean
}

/** The first candidate that is not the current default and not failed, or `null`. */
export function nextUsableDefaultDevice(input: NextDefaultDeviceInput): string | null {
  for (const candidate of input.candidates) {
    const poolKey = input.poolKeyOf(candidate)
    if (poolKey === input.currentKey) continue
    if (input.failed(candidate) || input.failed(poolKey)) continue
    return candidate
  }
  return null
}
