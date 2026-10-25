/**
 * Browse the LAN for agents over mDNS (D857): every agent publishes ONE
 * `_camstack-agent._tcp` service for its API port, paired or not. The hub lists
 * them so the operator picks an agent to pair instead of typing an address.
 *
 * The TXT record carries only public facts (node id, version, pairing state, and
 * a leaf fingerprint once paired) — finding an agent grants nothing.
 */
import { AGENT_MDNS_QUERY_NAME, AGENT_MDNS_TXT_KEYS } from '@camstack/types'
import {
  createRealMdnsSocket,
  type BrowseOptions,
  type MdnsRecord,
  type MdnsResponse,
} from './mdns-browse.js'

export type AgentMdnsState = 'unpaired' | 'pending' | 'paired'

export interface MdnsAgent {
  readonly nodeId: string
  /** Where the agent's API listens: the A record, else the packet's source. */
  readonly host: string
  readonly port: number
  readonly version: string | null
  readonly state: AgentMdnsState
  /** Short leaf fingerprint, once paired. */
  readonly fingerprint: string | null
}

function parseTxt(entries: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const entry of entries) {
    const at = entry.indexOf('=')
    if (at > 0) out.set(entry.slice(0, at), entry.slice(at + 1))
  }
  return out
}

function stateOf(value: string | undefined): AgentMdnsState {
  return value === 'paired' || value === 'pending' ? value : 'unpaired'
}

/** Fold the responses into agents. Pure, so it is tested without sockets. */
export function agentsFromResponses(responses: readonly MdnsResponse[]): readonly MdnsAgent[] {
  const found = new Map<string, MdnsAgent>()
  for (const { records, from } of responses) {
    for (const ptr of records) {
      if (ptr.kind !== 'ptr' || ptr.name.toLowerCase() !== AGENT_MDNS_QUERY_NAME) continue
      const srv = records.find((r) => r.kind === 'srv' && r.name === ptr.target)
      if (srv?.kind !== 'srv') continue
      const txtRecord = records.find((r) => r.kind === 'txt' && r.name === ptr.target)
      const txt =
        txtRecord?.kind === 'txt' ? parseTxt(txtRecord.entries) : new Map<string, string>()
      const nodeId = txt.get(AGENT_MDNS_TXT_KEYS.nodeId)
      // A service without a node id is not one of ours to list.
      if (nodeId === undefined || nodeId.length === 0) continue
      const a: MdnsRecord | undefined = records.find((r) => r.kind === 'a' && r.name === srv.target)
      const host = a?.kind === 'a' ? a.address : from
      found.set(nodeId, {
        nodeId,
        host,
        port: srv.port,
        version: txt.get(AGENT_MDNS_TXT_KEYS.version) ?? null,
        state: stateOf(txt.get(AGENT_MDNS_TXT_KEYS.state)),
        fingerprint: txt.get(AGENT_MDNS_TXT_KEYS.keyFingerprint) ?? null,
      })
    }
  }
  return [...found.values()]
}

/** Listen for `_camstack-agent._tcp` for `timeoutMs`; never throws (no multicast = no agents). */
export async function browseAgentsMdns(options: BrowseOptions): Promise<readonly MdnsAgent[]> {
  const responses: MdnsResponse[] = []
  const problem = (error: unknown): void =>
    options.onProblem?.(error instanceof Error ? error.message : String(error))
  let socket: ReturnType<NonNullable<BrowseOptions['createSocket']>>
  try {
    socket = (options.createSocket ?? createRealMdnsSocket)()
  } catch (err: unknown) {
    problem(err)
    return []
  }
  let requery: NodeJS.Timeout | null = null
  try {
    socket.onResponse((r) => responses.push(r))
    socket.onError(problem)
    socket.query(AGENT_MDNS_QUERY_NAME)
    requery = setInterval(() => socket.query(AGENT_MDNS_QUERY_NAME), options.requeryMs ?? 1000)
    await new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs))
  } catch (err: unknown) {
    problem(err)
  } finally {
    if (requery !== null) clearInterval(requery)
    socket.destroy()
  }
  return agentsFromResponses(responses)
}
