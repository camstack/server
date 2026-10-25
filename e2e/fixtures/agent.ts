/**
 * CamStack agent spawn fixture for E2E tests.
 *
 * Spawns the agent runtime (`packages/agent/dist/cli.js`) as a child
 * process with an isolated data dir + a unique node id, configured
 * entirely via env vars. Mirrors the style of `spawnHub` in
 * `electron.ts`.
 *
 * The agent is configured to connect EXPLICITLY to the test hub's
 * Moleculer TCP endpoint (`CAMSTACK_HUB_ADDRESS=host:port`). An
 * explicit hub URL disables UDP multicast discovery in the broker
 * factory (`packages/kernel/src/moleculer/broker-factory.ts`), so the
 * test agent can never cross-talk with a developer's `dev:full`
 * cluster on the LAN. There is no cluster secret (D857): after start the
 * fixture PAIRS the agent with the hub through the same API an operator uses
 * (hub `agentPairing.*` + the agent's loopback pairing routes), typing each
 * side's code into the other, and only then waits for the agent to appear.
 *
 * Readiness is gated HUB-SIDE: the fixture polls the hub's
 * `nodes.topology` tRPC query until the agent's `nodeId` shows up as
 * an online, non-hub node. That is the only reliable signal that the
 * agent has fully joined the cluster mesh — the agent's own HTTP
 * status port comes up well before the broker handshake completes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestDataDir, type TestDataDir } from './test-data-dir.ts'
import { trpcMutation, trpcQuery, type AuthorizedClient } from './api-client.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const AGENT_ENTRY = path.resolve(REPO_ROOT, 'packages/agent/dist/cli.js')

export interface SpawnedAgent {
  readonly proc: ChildProcess
  /** The agent's cluster node id (matches `CAMSTACK_NODE_ID`). */
  readonly nodeId: string
  readonly dataDir: string
  /** The agent's HTTP status port. */
  readonly statusPort: number
  /** Ring buffer of stdout lines (last 500). */
  readonly stdoutBuf: readonly string[]
  /** Ring buffer of stderr lines (last 500). */
  readonly stderrBuf: readonly string[]
  stop(): Promise<void>
}

export interface SpawnAgentOptions {
  /** Cluster node id. Required — use a unique per-test id. */
  readonly nodeId: string
  /**
   * Hub Moleculer TCP endpoint as `host:port`. MUST include the port
   * — the broker factory's `normalizeHubUrl` only defaults the port
   * to 6000, which collides with a developer's dev cluster.
   */
  readonly hubAddress: string
  /** Authorized hub client used to poll `nodes.topology` for readiness. */
  readonly hubClient: AuthorizedClient
  /** Agent HTTP status port. Default: 4544 (non-default, avoids 4444). */
  readonly statusPort?: number
  /** Override the temp data dir. Default: mktemp. */
  readonly dataDir?: string
  /** Connect-readiness timeout in ms. Default: 60_000. */
  readonly readyTimeoutMs?: number
  /** Extra env vars layered on top of process.env. */
  readonly env?: Record<string, string>
}

const DEFAULT_STATUS_PORT = 4544
const DEFAULT_READY_TIMEOUT_MS = 60_000
const TOPOLOGY_POLL_INTERVAL_MS = 1_000

interface TopologyNodeLite {
  readonly id: string
  readonly isHub: boolean
  readonly isOnline: boolean
}

function pushBounded(buf: string[], line: string, limit = 500): void {
  buf.push(line)
  if (buf.length > limit) buf.splice(0, buf.length - limit)
}

/**
 * Poll the hub's `nodes.topology` until `nodeId` appears as an online,
 * non-hub node. Resolves `true` on success, `false` on timeout.
 */
async function waitForAgentOnline(
  hubClient: AuthorizedClient,
  nodeId: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const nodes = await trpcQuery<readonly TopologyNodeLite[]>(
        hubClient.port,
        'nodes.topology',
        undefined,
        hubClient.token,
      )
      const agent = nodes.find((n) => n.id === nodeId)
      if (agent && !agent.isHub && agent.isOnline) return true
    } catch {
      // Hub may transiently reject — keep polling.
    }
    await new Promise((res) => setTimeout(res, TOPOLOGY_POLL_INTERVAL_MS))
  }
  return false
}

interface PairingViewLite {
  readonly pairingId: string
  readonly code: string
  readonly state: string
}

async function agentJson<T>(statusPort: number, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${statusPort}${urlPath}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return (await res.json()) as T
}

/**
 * Pair the freshly started agent with the hub (D857): the hub offers its CA, each operator
 * types the code the OTHER screen shows. Resolves `false` when the agent never accepted an
 * offer within `timeoutMs`.
 */
async function pairWithHub(
  hubClient: AuthorizedClient,
  statusPort: number,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now()
  let hubView: PairingViewLite | null = null
  while (Date.now() - start < timeoutMs && hubView === null) {
    try {
      hubView = await trpcMutation<PairingViewLite>(
        hubClient.port,
        'agentPairing.beginPairing',
        { host: '127.0.0.1', port: statusPort },
        hubClient.token,
      )
    } catch {
      // The agent's API port is not up yet - keep trying.
      await new Promise((res) => setTimeout(res, TOPOLOGY_POLL_INTERVAL_MS))
    }
  }
  if (hubView === null) return false
  const agentView = await agentJson<{ code: string | null }>(
    statusPort,
    '/api/agent/pairing/status',
  )
  if (agentView.code === null) return false
  await agentJson(statusPort, '/api/agent/pairing/confirm', {
    pairingId: hubView.pairingId,
    code: hubView.code,
  })
  const done = await trpcMutation<PairingViewLite>(
    hubClient.port,
    'agentPairing.confirmPairing',
    { pairingId: hubView.pairingId, code: agentView.code },
    hubClient.token,
  )
  return done.state === 'paired'
}

export async function spawnAgent(opts: SpawnAgentOptions): Promise<SpawnedAgent> {
  if (!fs.existsSync(AGENT_ENTRY)) {
    throw new Error(
      `[spawnAgent] Agent CLI not built at ${AGENT_ENTRY}. ` +
        `Run \`npm run build -w packages/agent\` first.`,
    )
  }

  const statusPort = opts.statusPort ?? DEFAULT_STATUS_PORT
  const readyTimeout = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const ownDataDir: TestDataDir | null = opts.dataDir
    ? null
    : createTestDataDir('camstack-e2e-agent-')
  const dataDir = opts.dataDir ?? ownDataDir!.path

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CAMSTACK_NODE_ID: opts.nodeId,
    CAMSTACK_HUB_ADDRESS: opts.hubAddress,
    CAMSTACK_DATA_DIR: dataDir,
    CAMSTACK_STATUS_PORT: String(statusPort),
    NODE_ENV: 'test',
    ...opts.env,
  }

  const proc = spawn('node', [AGENT_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  const stdoutBuf: string[] = []
  const stderrBuf: string[] = []

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line) pushBounded(stdoutBuf, line)
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line) pushBounded(stderrBuf, line)
    }
  })

  let exited = false
  proc.on('exit', () => {
    exited = true
  })

  const cleanup = (): void => {
    if (ownDataDir) ownDataDir.cleanup()
  }

  const paired = await pairWithHub(opts.hubClient, statusPort, readyTimeout)
  const online = paired && (await waitForAgentOnline(opts.hubClient, opts.nodeId, readyTimeout))
  if (!online) {
    proc.kill('SIGTERM')
    cleanup()
    const stderrTail = stderrBuf.slice(-40).join('\n')
    const stdoutTail = stdoutBuf.slice(-80).join('\n')
    throw new Error(
      `[spawnAgent] Agent "${opts.nodeId}" did not appear online in the hub's ` +
        `topology within ${readyTimeout}ms (hub=${opts.hubAddress}).\n` +
        `--- agent stderr tail ---\n${stderrTail}\n` +
        `--- agent stdout tail ---\n${stdoutTail}`,
    )
  }

  return {
    proc,
    nodeId: opts.nodeId,
    dataDir,
    statusPort,
    stdoutBuf,
    stderrBuf,
    async stop() {
      if (exited) {
        cleanup()
        return
      }
      proc.kill('SIGTERM')
      // Give the agent's graceful shutdown ~3s; SIGKILL fallback otherwise.
      const killed = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve(true)
        })
      })
      if (!killed) {
        proc.kill('SIGKILL')
        await new Promise((res) => setTimeout(res, 1_000))
      }
      cleanup()
    },
  }
}
