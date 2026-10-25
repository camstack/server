/**
 * What the decode worker may DISPOSE, and when — the D652 rules as pure
 * decisions, so they are tested without node-av.
 *
 * A native object freed while libav is still inside it is a use-after-free,
 * and a crash there takes the worker's last lines with it. Three moments:
 *
 * - **Drain**: the process lives on for the drain, so the network input is
 *   closed — but only once the decode loop has LEFT it, and the decoder stays
 *   (held GPU surfaces belong to its pool).
 * - **Exit** (SIGTERM / `stop` / a lost channel / an uncaught error): nothing
 *   native is disposed at all. The loop may still sit in native I/O for the
 *   ≤250 ms the exit waits for its lines, and process exit reclaims every
 *   native resource anyway — including the GPU pool (Task 0, reclaim-by-exit).
 * - **Ordinary re-dial**: everything the dial owned goes, after the loop.
 */

/** Which of the worker's shutdown modes is in force when the loop ends. */
export interface DecodeLoopShutdownState {
  readonly draining: boolean
  readonly exiting: boolean
}

/** What to close after the decode loop has left the input. */
export type InputCloseAfterLoop = 'all' | 'demuxer-only' | 'none'

export function inputCloseAfterLoop(state: DecodeLoopShutdownState): InputCloseAfterLoop {
  if (state.exiting) return 'none'
  if (state.draining) return 'demuxer-only'
  return 'all'
}

/** A decoded frame the stopped loop will not publish. */
export interface StrayFrame {
  free(): void
}

/**
 * The frame decoded after a drain/stop is nobody's: free it — unless the
 * worker is exiting, where exit reclaims it and no native call is made.
 */
export function releaseFrameAfterStop(
  frame: StrayFrame | null,
  state: DecodeLoopShutdownState,
): void {
  if (state.exiting || frame === null) return
  frame.free()
}
