/**
 * The arguments a transition stores for the command that caused it (D1022).
 * Redacted by what the method's own schema declares secret, with a key-name net
 * for a method the schema lookup cannot find; routing keys are dropped; a bag
 * over {@link COMMAND_ARGS_MAX_BYTES} is replaced by a marker, never cut — a
 * half-stored value reads as the whole one.
 */
import { collectZodSecretPaths } from '@camstack/types'
import type { z } from 'zod'
import { isSecretArgumentKey, redactLogMeta } from '../../../logging/log-redactor.js'

export const COMMAND_ARGS_MAX_BYTES = 1024
const REDACTED = '***'
const ROUTING_KEYS: ReadonlySet<string> = new Set(['deviceId', 'caller', 'nodeId'])

export type CommandArgsPreparer = (
  capName: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
) => Record<string, unknown>

type PathToken =
  | { readonly kind: 'key'; readonly name: string }
  | { readonly kind: 'each' }
  | { readonly kind: 'values' }

/** `rows[].token` -> key rows, each, key token. `applianceSecrets{}` -> key, values. */
function parsePath(path: string): readonly PathToken[] {
  const tokens: PathToken[] = []
  for (const m of path.matchAll(/\[\]|\{\}|[^.[\]{}]+/g)) {
    const t = m[0]
    tokens.push(
      t === '[]' ? { kind: 'each' } : t === '{}' ? { kind: 'values' } : { kind: 'key', name: t },
    )
  }
  return tokens
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Replace what `tokens` reaches inside `value`; an object or array declared secret goes whole. */
function redactAt(value: unknown, tokens: readonly PathToken[]): unknown {
  const [head, ...rest] = tokens
  if (head === undefined) return REDACTED
  if (head.kind === 'each') {
    return Array.isArray(value) ? value.map((item: unknown) => redactAt(item, rest)) : value
  }
  if (!isPlainObject(value)) return value
  if (head.kind === 'values') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAt(v, rest)]))
  }
  if (!Object.hasOwn(value, head.name)) return value
  return { ...value, [head.name]: redactAt(value[head.name], rest) }
}

const WORD_NET_MAX_DEPTH = 8

/** The key-name net for values of ANY type, to a bounded depth. */
function redactSecretKeys(value: unknown, depth: number): unknown {
  if (depth >= WORD_NET_MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((item: unknown) => redactSecretKeys(item, depth + 1))
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      v !== null && v !== undefined && isSecretArgumentKey(k)
        ? REDACTED
        : redactSecretKeys(v, depth + 1),
    ]),
  )
}

export function createCommandArgsPreparer(
  inputFor: (capName: string, method: string) => z.ZodType | undefined,
): CommandArgsPreparer {
  const secretPaths = new Map<string, readonly (readonly PathToken[])[]>()
  const secretPathsOf = (capName: string, method: string): readonly (readonly PathToken[])[] => {
    const id = `${capName}|${method}`
    const known = secretPaths.get(id)
    if (known !== undefined) return known
    const schema = inputFor(capName, method)
    const paths = schema === undefined ? [] : collectZodSecretPaths(schema).map(parsePath)
    secretPaths.set(id, paths)
    return paths
  }
  return (capName, method, args) => {
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (!ROUTING_KEYS.has(key)) kept[key] = value
    }
    // What the schema declares secret first (nested, an object or array whole), then the key-name net
    // for values of any type, then the log redactor's text nets (URL credentials).
    let bag: unknown = kept
    for (const path of secretPathsOf(capName, method)) bag = redactAt(bag, path)
    const named = redactSecretKeys(bag, 0)
    const out = isPlainObject(named) ? redactLogMeta(named) : {}
    if (JSON.stringify(out).length > COMMAND_ARGS_MAX_BYTES) return { _truncated: true }
    return isPlainObject(out) ? out : {}
  }
}
