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
 */
export type AgentBootMode = 'full' | 'pairing-only'

export function decideAgentBootMode(input: { readonly paired: boolean }): AgentBootMode {
  return input.paired ? 'full' : 'pairing-only'
}
