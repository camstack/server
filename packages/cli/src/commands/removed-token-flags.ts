/**
 * `--token` / `--token-file` were removed (D1101): a client reaches a hub in
 * exactly one way, the `dominevo login` session, which then renews itself.
 * Old scripts still pass them, so every hub command keeps them PARSEABLE and
 * refuses them here with a message that says what to do. A strict parse would
 * answer "Unknown option", which tells nobody anything. The value is never
 * echoed.
 */
import type { ParseArgsConfig } from 'node:util'

type FlagOptions = NonNullable<ParseArgsConfig['options']>

/** Spread into a command's `parseArgs` options so the removed flags reach {@link assertNoRemovedTokenFlags}. */
export const REMOVED_TOKEN_FLAG_OPTIONS = {
  token: { type: 'string', short: 't' },
  'token-file': { type: 'string' },
} as const satisfies FlagOptions

export const REMOVED_TOKEN_FLAG_MESSAGE =
  '--token and --token-file were removed: a client reaches a hub only through the login session. ' +
  'Run `dominevo login <host>` once, interactively; the session then refreshes unattended ' +
  '(a headless service is logged in once, then left alone).'

export class RemovedTokenFlagError extends Error {
  constructor() {
    super(REMOVED_TOKEN_FLAG_MESSAGE)
    this.name = 'RemovedTokenFlagError'
  }
}

/** Throws {@link RemovedTokenFlagError} when a parsed command carries a removed token flag. */
export function assertNoRemovedTokenFlags(
  values: Readonly<Record<string, string | boolean | undefined>>,
): void {
  if (values['token'] !== undefined || values['token-file'] !== undefined) {
    throw new RemovedTokenFlagError()
  }
}
