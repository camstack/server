/**
 * Bounded-retry + failure-description helpers for `stage-deps.mjs`.
 *
 * PURE + zero-dep (the sleep is injected) so both behaviours are unit-testable
 * without spawning a real process.
 *
 * Problem this addresses (release v1.2.104, linux x64 desktop leg): the closure
 * install (`npm install @camstack/server@<version>`) was terminated 124 s in by
 * an EXTERNAL SIGTERM on the self-hosted agent-a runner — npm's own arborist
 * signal handler caught it, rolled the reify back and exited 1. The exact same
 * command on the exact same runner had succeeded in 90 s eighteen hours before
 * with a byte-identical `packages/desktop`, and the host had >8 GiB free at the
 * moment of the kill, so nothing about the build was wrong. Yet ONE transient
 * kill failed the whole leg, which skipped `publish-release` and left the
 * GitHub Release stuck as a draft with the mac + docker artifacts already
 * built.
 *
 * Two separate defects, one helper each:
 *
 *  - `runWithRetry` — a transient external kill of a ~90 s network step must
 *    not cost a release. The bound is small and explicit: a genuine failure
 *    (an unpublished version, a 404) still fails, just one attempt later.
 *  - `describeExecFailure` — `execSync(..., { stdio: 'inherit' })` throws an
 *    error whose `stderr` is `null`, so the operator got a bare node stack
 *    trace and no line naming the command or its exit status. A step that
 *    aborts a release says WHAT failed.
 */

/**
 * @typedef {object} RetryOptions
 * @property {number} attempts Maximum number of attempts (>= 1). The bound.
 * @property {number} delayMs Pause between attempts.
 * @property {(info: RetryInfo) => void} [onRetry] Called before each retry.
 * @property {(ms: number) => void} sleep Injected synchronous sleep.
 */

/**
 * @typedef {object} RetryInfo
 * @property {number} attempt The attempt number that just failed (1-based).
 * @property {number} attempts The configured bound.
 * @property {unknown} error The failure that triggered the retry.
 */

/**
 * Run `attempt` until it succeeds or the bound is exhausted, rethrowing the
 * LAST failure. Returns whatever the successful attempt returned.
 *
 * @template T
 * @param {() => T} attempt
 * @param {RetryOptions} options
 * @returns {T}
 */
export function runWithRetry(attempt, options) {
  const { attempts, delayMs, onRetry, sleep } = options
  let lastError
  for (let n = 1; n <= attempts; n++) {
    try {
      return attempt()
    } catch (err) {
      lastError = err
      if (n === attempts) break
      if (onRetry) onRetry({ attempt: n, attempts, error: err })
      sleep(delayMs)
    }
  }
  throw lastError
}

/**
 * One line naming the command and HOW it failed — the exit status, the signal,
 * or the raw message. Never throws on a non-Error value.
 *
 * @param {unknown} error
 * @param {string} command
 * @returns {string}
 */
export function describeExecFailure(error, command) {
  if (error !== null && typeof error === 'object') {
    const status = 'status' in error ? error.status : undefined
    const signal = 'signal' in error ? error.signal : undefined
    if (typeof status === 'number') return `${command} — exited with status ${status}`
    if (typeof signal === 'string') return `${command} — terminated by ${signal}`
    if ('message' in error) return `${command} — ${String(error.message)}`
  }
  return `${command} — ${String(error)}`
}

/**
 * Synchronous sleep — the staging script is a straight-line `execSync` pipeline
 * with no event loop to await on.
 *
 * @param {number} ms
 * @returns {void}
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
