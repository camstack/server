/**
 * A deterministic Init refusal (D877): an addon that says, in a typed way,
 * "I will not start, and here is why" - as opposed to a crash.
 *
 * The difference matters to the supervisor. A crash may be transient (a camera
 * dropping mid-handshake) and is bounded by the D6 circuit-breaker; a refusal
 * repeats identically until somebody changes the world (runs a migration,
 * fixes a setting), so counting it toward the breaker only turns "waiting for
 * the operator" into a terminal `failed` with a stack trace nobody needed.
 * On 2026-10-17 twenty-eight addons refused on an unmigrated store, exited five
 * times in ten seconds and were marked `failed` as if they had crashed.
 *
 * The runner reports a refusal to its parent (see `runner-refusal.ts`); the
 * process service parks the runner in `refused` with the reason and retries it
 * only when an operator acts.
 */
export class AddonRefusedError extends Error {
  /** Stable, greppable cause, e.g. `unmigrated-settings`. */
  readonly code: string
  /** What the operator does about it. */
  readonly remedy: string

  constructor(code: string, message: string, remedy: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AddonRefusedError'
    this.code = code
    this.remedy = remedy
  }
}

/**
 * The refusal in `err`'s cause chain, if any. An addon that wraps the error it
 * got from the kernel (`new Error('init failed', { cause })`) is still refusing.
 */
export function findAddonRefusal(err: unknown): AddonRefusedError | null {
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current instanceof AddonRefusedError) return current
    seen.add(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return null
}
