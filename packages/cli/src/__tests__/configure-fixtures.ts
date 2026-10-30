import { MutationGate, type ConnectOutcome } from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'
import { fakeHub, type FakeHub } from './ops-fake-hub.js'

export interface GatedHub {
  readonly ctx: McpContext
  readonly calls: FakeHub['calls']
}

/** A fake hub whose gate is armed, as in public mode. */
export function gatedHub(
  answers: { readonly [path: string]: unknown },
  fetchBody: unknown = {},
): GatedHub {
  const base = fakeHub(answers)
  return {
    calls: base.calls,
    ctx: {
      ...base.ctx,
      gate: new MutationGate({ allowMutations: true }),
      fetch: async () => new Response(JSON.stringify(fetchBody)),
    },
  }
}

/** The same hub seen through a credential that is not admin-scoped. */
export async function asProtectedTier(ctx: McpContext): Promise<McpContext> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return ctx
  const demoted: ConnectOutcome = {
    ok: true,
    connection: {
      ...outcome.connection,
      tier: 'protected',
      adminHint: 'log in as admin',
    },
  }
  return { ...ctx, hub: async () => demoted }
}

export const ADDRESSES = {
  roles: { appConnections: { resolved: ['https://hub.example.test'] } },
}

export function writes(calls: FakeHub['calls']): FakeHub['calls'] {
  return calls.filter((c) => c.method === 'POST')
}

export interface DryRunView {
  readonly token: string | undefined
  readonly describe: unknown
}

/** The token and description of a gated dry run, read without casts. */
export function dryRunOf(result: unknown): DryRunView {
  if (typeof result !== 'object' || result === null) throw new Error('not an object')
  const token =
    'confirm_token' in result && typeof result.confirm_token === 'string'
      ? result.confirm_token
      : undefined
  return { token, describe: 'dryRun' in result ? result.dryRun : undefined }
}
