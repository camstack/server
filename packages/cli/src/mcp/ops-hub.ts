/**
 * The read doorway of the `ops` toolset. Every tool here asks the hub a FIXED,
 * named query through the CLI's credential chain; nothing in this file can
 * write (`GET` only) and nothing reads a secret-bearing method.
 *
 * A read that fails is a typed `{ ok: false, reason }`, never a thrown error
 * and never a zero: the caller must say "unknown", not "absent" (D315, D393).
 */
import {
  isSecretBearing,
  type HubClient,
  type HubConnection,
  type NoSessionOutcome,
} from '@camstack/develop'
import type { z } from 'zod'
import type { McpContext } from './context.js'

export interface NoSessionResult {
  readonly status: 'no-session'
  readonly message: string
  readonly action: string
}

export function noSessionResult(outcome: NoSessionOutcome): NoSessionResult {
  return {
    status: 'no-session',
    message: outcome.message,
    action: outcome.action,
  }
}

export interface RefusedResult {
  readonly status: 'refused'
  readonly reason: string
}

export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One validated GET. Never throws: a refusal, a hub error or a shape mismatch is a reason. */
export async function readQuery<S extends z.ZodType>(
  client: HubClient,
  path: string,
  input: unknown,
  schema: S,
): Promise<Read<z.infer<S>>> {
  if (isSecretBearing(path)) {
    return {
      ok: false,
      reason: `${path} returns secret material; the ops toolset never reads it`,
    }
  }
  let raw: unknown
  try {
    raw = await client.call('GET', path, input)
  } catch (err) {
    return { ok: false, reason: `${path}: ${reasonOf(err)}` }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first ? `${first.path.join('.')}: ${first.message}` : 'unexpected shape'
    return {
      ok: false,
      reason: `${path}: unexpected answer (${where}) — the hub and this tool may be on different versions`,
    }
  }
  return { ok: true, value: parsed.data }
}

/** Resolve the hub for one tool call and run `body` with it, or answer "no session". */
export async function withHub<T>(
  ctx: McpContext,
  body: (connection: HubConnection) => Promise<T>,
): Promise<T | NoSessionResult> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  return body(outcome.connection)
}

/** Cap a list and say how many were left out. */
export interface Capped<T> {
  readonly items: readonly T[]
  readonly truncated: number
}

export function cap<T>(items: readonly T[], max: number): Capped<T> {
  return {
    items: items.slice(0, max),
    truncated: Math.max(0, items.length - max),
  }
}

export const ADMIN_ONLY_NOTE = (path: string, hint: string | null): string =>
  `${path} is admin-tier and this credential is not admin-scoped.${hint ? ` ${hint}` : ''}`
