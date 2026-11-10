/**
 * What an agent boots at start (D857, D5).
 *
 * An UNPAIRED agent has no mesh transport at all, so there is no hub to read
 * settings from: booting the core infra addons would block on the hub's
 * `settings-store` for the discovery deadline and then abort the process,
 * which the supervisor respawns forever (the pairing window never opens long
 * enough). It serves pairing, health, the static UI and its mDNS advertisement
 * only. Once pairing installs the certificate the process is relaunched
 * (lifecycle = respawn, D5) and boots in full with the hub reachable.
 *
 * A PAIRED agent with no hub address (and none found over mDNS by its hub id)
 * is the same case (#494): it dials nobody, so the core addons would abort the
 * process the same way. It boots like an unpaired one, reports `unconfigured`,
 * and relaunches once an address is set or found.
 */
export type AgentBootMode = 'full' | 'pairing-only' | 'awaiting-hub'

export interface AgentBootModeInput {
  readonly paired: boolean
  /** The hub address the agent will dial; empty, `null` or `undefined` = none. */
  readonly hubAddress: string | null | undefined
}

export function decideAgentBootMode(input: AgentBootModeInput): AgentBootMode {
  if (!input.paired) return 'pairing-only'
  const hasAddress = typeof input.hubAddress === 'string' && input.hubAddress.trim().length > 0
  return hasAddress ? 'full' : 'awaiting-hub'
}
