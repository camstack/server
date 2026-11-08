/**
 * The arguments a transition stores for the command that caused it (D1022).
 * Redacted by what the method's own schema declares secret, with a key-name net
 * for a method the schema lookup cannot find; routing keys are dropped; a bag
 * over {@link COMMAND_ARGS_MAX_BYTES} is replaced by a marker, never cut — a
 * half-stored value reads as the whole one.
 */
import { collectZodSecretPaths } from '@camstack/types'
import type { z } from 'zod'
import { isCredentialKeyName } from '../../../logging/log-redactor.js'

export const COMMAND_ARGS_MAX_BYTES = 1024
const REDACTED = '[redacted]'
const ROUTING_KEYS: ReadonlySet<string> = new Set(['deviceId', 'caller', 'nodeId'])

export type CommandArgsPreparer = (
  capName: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
) => Record<string, unknown>

/** The first segment of a secret path (`connection.password` -> `connection`, `rows[].token` -> `rows`). */
function topLevelKey(path: string): string {
  const cut = path.search(/[.[{]/)
  return cut === -1 ? path : path.slice(0, cut)
}

export function createCommandArgsPreparer(
  inputFor: (capName: string, method: string) => z.ZodType | undefined,
): CommandArgsPreparer {
  const secretKeys = new Map<string, ReadonlySet<string>>()
  const secretKeysOf = (capName: string, method: string): ReadonlySet<string> => {
    const id = `${capName}|${method}`
    const known = secretKeys.get(id)
    if (known !== undefined) return known
    const schema = inputFor(capName, method)
    const keys = new Set(
      schema === undefined ? [] : collectZodSecretPaths(schema).map((p) => topLevelKey(p)),
    )
    secretKeys.set(id, keys)
    return keys
  }
  return (capName, method, args) => {
    const secrets = secretKeysOf(capName, method)
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (ROUTING_KEYS.has(key)) continue
      out[key] = secrets.has(key) || isCredentialKeyName(key) ? REDACTED : value
    }
    if (JSON.stringify(out).length > COMMAND_ARGS_MAX_BYTES) return { _truncated: true }
    return out
  }
}
