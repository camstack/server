import { MutationGate } from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'

/** The public-mode context: writes are allowed through the two-step gate, nothing is audited to disk. */
export function withWrites(ctx: McpContext): McpContext {
  return {
    ...ctx,
    gate: new MutationGate({ allowMutations: true, audit: () => {} }),
  }
}
