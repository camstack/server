import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import { writeOwnerOnlyFileSync } from '@camstack/types/node'

/**
 * The agent's mesh mTLS material (Release A), issued by the hub CA at enrollment.
 * Persisted in `agent.json` (0600). Holding it is what "paired" means (D857).
 */
interface AgentMeshTls {
  readonly certPem: string
  readonly keyPem: string
  readonly caCertPem: string
}

interface AgentConfig {
  readonly nodeId: string
  readonly name: string
  readonly hubAddress?: string
  readonly dataDir: string
  readonly addonsDir: string
  readonly logLevel: string
  /**
   * Mesh mTLS material from pairing (D857). When present the agent is paired and the broker dials the hub's TLS
   * port (6443). An older `secret` field in the file is never read.
   */
  readonly meshTls?: AgentMeshTls
  /** Resolved path to the config file (for persisting renames). */
  readonly configPath: string
  /** HTTP port for the agent status API + optional UI (default: 4444). */
  readonly statusPort: number
}

/**
 * Generate a stable nodeId and persist it to the config file.
 *
 * Resolution order (first match wins, persisted on first boot):
 *   1. Existing `nodeId` in the config file — survives env var changes
 *      and host renames once seeded.
 *   2. `CAMSTACK_NODE_ID` env var on first boot — lets dev workflows
 *      pin a stable, human-readable nodeId (e.g. `dev-agent-0`)
 *      without clobbering already-persisted random ids.
 *   3. A fresh random hex (`agent-a1b2c3`) — production fallback when
 *      no env var is set.
 *
 * Seeded values get written to the config file so subsequent boots
 * round-trip exactly the same identity (Moleculer nodeID, capability
 * routing, persisted agentSettings — all keyed by this string).
 */
function ensurePersistedNodeId(configPath: string, dataDir: string): string {
  const resolvedPath = path.resolve(dataDir, configPath)
  let raw: Record<string, unknown> = {}
  if (fs.existsSync(resolvedPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as Record<string, unknown>
    } catch {
      /* corrupt file */
    }
  }
  if (typeof raw.nodeId === 'string' && raw.nodeId.length > 0) {
    return raw.nodeId
  }
  const envSeed = process.env.CAMSTACK_NODE_ID
  const id =
    envSeed && envSeed.length > 0 ? envSeed : `agent-${crypto.randomBytes(4).toString('hex')}`
  raw.nodeId = id
  try {
    // Owner-only: the same file holds the agent's private mesh key.
    writeOwnerOnlyFileSync(resolvedPath, JSON.stringify(raw, null, 2))
  } catch {
    /* best-effort */
  }
  return id
}

function parseMeshTls(value: unknown): AgentMeshTls | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const certPem: unknown = Reflect.get(value, 'certPem')
  const keyPem: unknown = Reflect.get(value, 'keyPem')
  const caCertPem: unknown = Reflect.get(value, 'caCertPem')
  if (typeof certPem !== 'string' || certPem.length === 0) return undefined
  if (typeof keyPem !== 'string' || keyPem.length === 0) return undefined
  if (typeof caCertPem !== 'string' || caCertPem.length === 0) return undefined
  return { certPem, keyPem, caCertPem }
}

/**
 * The name an agent without a chosen one carries: the host name up to its first dot (so
 * `.local` / `.localdomain` and a domain suffix drop out), then the architecture.
 */
function defaultAgentName(hostname: string, arch: string): string {
  const short = hostname.trim().split('.')[0] ?? ''
  return `${short.length > 0 ? short : 'agent'}-${arch}`
}

/**
 * The name before anyone renamed the agent: `CAMSTACK_AGENT_NAME` when set, else the default.
 * Never the node id - that is an identity, not a label.
 */
function seededAgentName(): string {
  const fromEnv = process.env.CAMSTACK_AGENT_NAME
  return fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv.trim()
    : defaultAgentName(os.hostname(), os.arch())
}

function loadAgentConfig(configPath?: string, dataDirOverride?: string): AgentConfig {
  const filePath = configPath ?? 'agent.json'
  const dataDir = dataDirOverride ?? process.env.CAMSTACK_DATA ?? './camstack-data'
  const resolvedDataDir = path.resolve(dataDir)

  // Name: config file takes priority over env (allows UI rename to stick).
  // Env is the initial seed, config file is the persisted override.
  const envName = seededAgentName()

  // Environment variable for the hub connection (optional — agent starts
  // without). Pairing material lives only in agent.json.
  const envHubAddress = process.env.CAMSTACK_HUB_ADDRESS || undefined
  const configFullPath = path.resolve(resolvedDataDir, filePath)
  const nodeId = ensurePersistedNodeId(filePath, resolvedDataDir)

  // Read persisted config — these override env vars
  let fileHubAddress: string | undefined
  let fileName: string | undefined
  let fileMeshTls: AgentMeshTls | undefined
  if (fs.existsSync(configFullPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFullPath, 'utf-8')) as Record<string, unknown>
      fileHubAddress = typeof raw.hubAddress === 'string' ? raw.hubAddress : undefined
      fileName = typeof raw.name === 'string' ? raw.name : undefined
      fileMeshTls = parseMeshTls(raw.meshTls)
    } catch {
      /* corrupt config */
    }
  }

  // Config file wins over env for all user-editable fields
  const effectiveName = fileName ?? envName
  const effectiveHub = fileHubAddress ?? envHubAddress

  return {
    nodeId,
    name: effectiveName,
    hubAddress: effectiveHub,
    dataDir: resolvedDataDir,
    addonsDir: path.resolve(resolvedDataDir, 'addons'),
    logLevel: process.env.CAMSTACK_LOG_LEVEL ?? 'info',
    ...(fileMeshTls !== undefined ? { meshTls: fileMeshTls } : {}),
    configPath: configFullPath,
    statusPort: Number(process.env.CAMSTACK_STATUS_PORT) || 4444,
  }
}

export { defaultAgentName, loadAgentConfig, seededAgentName }
export type { AgentConfig, AgentMeshTls }
