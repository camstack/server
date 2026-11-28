import { errMsg } from '@dominevo/types'

/** A cause chain is short; the bound only protects against a cyclic `.cause`. */
const MAX_CHAIN_DEPTH = 5

/**
 * The message of an error followed by every `.cause` below it, as
 * `outer <- Name: inner`. matter.js wraps the real reason (a
 * `PeerUnreachableError`) in an `AbortedError("Operation aborted")`, so the
 * top message alone hides why a dial failed.
 */
export function describeErrorChain(err: unknown): string {
  const parts: string[] = [errMsg(err)]
  let current: unknown = err instanceof Error ? err.cause : undefined
  for (let depth = 0; current !== undefined && depth < MAX_CHAIN_DEPTH; depth += 1) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' <- ')
}
