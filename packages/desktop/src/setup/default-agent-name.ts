/**
 * The name an agent carries until someone chooses one: the host name up to its
 * first dot (`.local`, `.localdomain` and a domain suffix drop out), then the
 * architecture. The agent computes the same string when `agent.json` holds no
 * name (`defaultAgentName` in `server/backend/src/agent/agent-config.ts`), so
 * the setup window's placeholder shows what the agent will really be called.
 */
export function defaultAgentName(hostname: string, arch: string): string {
  const short = hostname.trim().split('.')[0] ?? ''
  return `${short.length > 0 ? short : 'agent'}-${arch}`
}
