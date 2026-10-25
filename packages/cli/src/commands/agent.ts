import * as os from 'node:os'
import { parseArgs } from 'node:util'

export interface AgentOptions {
  readonly hub: string
  readonly token: string
  readonly name?: string
  readonly port?: string
}

/**
 * Build environment variables for starting an agent process.
 * Constructs a WS URL from the hub IP/hostname.
 */
export function buildAgentEnv(opts: AgentOptions): Record<string, string> {
  const hubPort = opts.port ?? '4443'
  const agentName = opts.name ?? `${os.hostname()}-${os.arch()}`

  return {
    // `CAMSTACK_ROLE`, not `CAMSTACK_MODE`. Nothing in server/backend has ever
    // read `CAMSTACK_MODE` — the role switch is `resolveNodeRole`
    // (server/backend/src/node-role.ts), which returns 'hub' for an EMPTY
    // value. So `camstack agent` set a variable no one reads and booted a HUB.
    CAMSTACK_ROLE: 'agent',
    CAMSTACK_HUB_URL: `ws://${opts.hub}:${hubPort}/agent`,
    CAMSTACK_HUB_TOKEN: opts.token,
    CAMSTACK_AGENT_NAME: agentName,
  }
}

export async function runAgent(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      hub: { type: 'string' },
      token: { type: 'string' },
      name: { type: 'string' },
      port: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (typeof values.hub !== 'string' || values.hub.length === 0) {
    throw new Error('--hub is required (e.g. --hub 192.168.10.10)')
  }
  if (typeof values.token !== 'string' || values.token.length === 0) {
    throw new Error('--token is required')
  }
  const opts: AgentOptions = {
    hub: values.hub,
    token: values.token,
    ...(typeof values.name === 'string' ? { name: values.name } : {}),
    ...(typeof values.port === 'string' ? { port: values.port } : {}),
  }
  Object.assign(process.env, buildAgentEnv(opts))
  // The LAUNCHER, not `main.js`. `main.js` is the hub bootstrap and runs on
  // import; the launcher is what reads the role and branches to the agent
  // runtime. Importing main.js also skipped the launcher's framework/NODE_PATH
  // wiring entirely.
  await import('@camstack/server/launcher.js')
}
