/**
 * The command-origin claim of the cap call currently running (D1022).
 *
 * A provider method is invoked with its args only — the claim rides out of band,
 * the same way `commandOrigin` puts it on a tRPC call. The dispatch that is about
 * to call the provider enters this scope, and the provider reads it back with
 * {@link readCommandOrigin}. The store does not cross a process: the parent copies
 * the claim onto the child `cap-call`, and the child enters the scope again.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readCommandOrigin, type CommandOriginClaim } from '@camstack/types/addon'

const scope = new AsyncLocalStorage<unknown>()

/** The tRPC-shaped context of the cap call on this stack, or `undefined` outside one. */
export function currentCapCallContext(): unknown {
  return scope.getStore()
}

/** The command origin of the cap call on this stack, if the call carried a well-formed one. */
export function readCurrentCommandOrigin(): CommandOriginClaim | undefined {
  return readCommandOrigin(scope.getStore())
}

/**
 * Run `fn` as a cap call whose context is `context` (`commandOrigin(claim).context`,
 * or the raw `op.context`). `undefined` is a call that carried no claim.
 */
export function runWithCapCallContext<T>(context: unknown, fn: () => T): T {
  return scope.run(context, fn)
}
