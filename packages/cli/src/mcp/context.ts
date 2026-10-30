/**
 * What every toolset of `camstack mcp` is handed. Tests inject a fake hub
 * connection and a fake registry; production wires the CLI's credential chain.
 */
import type { ConnectOutcome, MutationGate } from '@camstack/develop'

export interface ToolTextResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: true
}

/** Resolves the hub for ONE tool call. Never throws for a missing login. */
export type HubProvider = () => Promise<ConnectOutcome>

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export interface McpContext {
  /** The running `camstack` CLI version. */
  readonly cliVersion: string
  readonly hub: HubProvider
  readonly gate: MutationGate
  readonly fetch: FetchFn
}
