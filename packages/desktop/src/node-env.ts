/**
 * The environment the CamStack node process is started with — ONE builder for
 * both ways of starting it: the Electron shell spawning a child, and the
 * Windows service (`windows-service/`) running the same bundled Node.
 *
 * Pure (no `electron`, no `fs`) so it is unit-testable and so the two launch
 * paths cannot drift. No credential is here (D797, D857): an agent's identity
 * is the mesh certificate in its own `agent.json`, never an environment.
 */
import type { NodeRole } from './types'

export interface AgentConnectionInput {
  /** `host[:port]` of the hub, or null for automatic discovery. */
  readonly hubAddress: string | null
  readonly agentName: string | null
  /** The agent's local status/UI port — the window URL and the server agree. */
  readonly statusPort: number
}

export interface NodeEnvInput {
  readonly role: Exclude<NodeRole, 'viewer'>
  readonly dataDir: string
  readonly appVersion: string
  /** Required for the agent role, ignored for the hub. */
  readonly agent?: AgentConnectionInput
  /** The packaged closure's `@camstack` scope dir; null in dev. */
  readonly bundledAddonsDir: string | null
  /** The baked seed `@camstack/server` dir; null in dev. */
  readonly seedServerDir: string | null
}

export function buildNodeEnv(input: NodeEnvInput): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    // Role selects hub vs agent inside the server launcher.
    CAMSTACK_ROLE: input.role,
    // The one writable data dir — survives app updates and is the only
    // writable place inside a signed bundle. Read by the starter + launcher.
    CAMSTACK_DATA: input.dataDir,
    // Which wrapper build is running, for the node's status API / embedded UI.
    // This is the product version (`app.getVersion()`), not the server package.
    CAMSTACK_AGENT_APP_VERSION: input.appVersion,
    // Same number, read by hub and agent About lines. Distinct env so a
    // container can set it without looking like an Electron shell (D437).
    CAMSTACK_PRODUCT_VERSION: input.appVersion,
  }
  if (input.role === 'agent' && input.agent !== undefined) {
    env['CAMSTACK_STATUS_PORT'] = String(input.agent.statusPort)
    if (input.agent.hubAddress) env['CAMSTACK_HUB_ADDRESS'] = input.agent.hubAddress
    if (input.agent.agentName) env['CAMSTACK_AGENT_NAME'] = input.agent.agentName
  }
  if (input.bundledAddonsDir) env['CAMSTACK_BUNDLED_ADDONS_DIR'] = input.bundledAddonsDir
  if (input.seedServerDir) env['CAMSTACK_SEED_SERVER_DIR'] = input.seedServerDir
  return env
}
