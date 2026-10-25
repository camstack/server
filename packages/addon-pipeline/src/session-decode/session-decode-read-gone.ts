/**
 * A session-decode `toBuffer` the worker will never answer (D656).
 *
 * Named refusals after teardown (`SessionDecodeReadRefusedError`) and the
 * in-flight waiter rejection when the child exits mid-read. Live Mac bursts
 * (frameId 1–8 at session end) used to surface these as `runInference failed`.
 */
import {
  SessionDecodeReadRefusedError,
  TO_BUFFER_REFUSED_EXITED,
  TO_BUFFER_REFUSED_KILLED,
} from './session-decode-coordinator.js'

export function isSessionDecodeReadGone(err: unknown): boolean {
  if (err instanceof SessionDecodeReadRefusedError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes(TO_BUFFER_REFUSED_EXITED) ||
    msg.includes(TO_BUFFER_REFUSED_KILLED) ||
    msg.includes('worker exited before toBuffer reply') ||
    msg.includes('local frameRef miss:')
  )
}
