import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeploySource, RegisterNodeParams, RegisterNodeResult } from '@camstack/system'
import {
  asBrokerLike,
  isAddonDeploySource,
  localSupportedPythonRuntimes,
  mapSignalsToInferenceHardware,
  probePlatform,
  resolveHwAccel,
} from '@camstack/system'
import type { AgentHealth, IMetricsProvider, IScopedLogger } from '@camstack/types'

/** What `$agent.status` and `$agent.health` read from the metrics provider. */
export type StatusMetricsSource = Pick<IMetricsProvider, 'getCached'>
import { coralUsableUnits } from '@camstack/types'
import type { Context, ServiceBroker, ServiceSchema } from 'moleculer'
import { Errors } from 'moleculer'
import { applyDeployedBundle } from './agent-deploy-swap.js'
import {
  type AgentRunnerRow,
  type AgentRunnerStopResult,
  type AgentUndeployRequest,
  undeployFromAgent,
} from './agent-undeploy.js'
import { applyModelDistribution, type ModelDistributionSeam } from './apply-model-distribution.js'
import { applyStageDevUploads, type StageDevUploadsSeam } from './apply-stage-dev-uploads.js'
import { unpackDevUploadVersionBundle } from '../api/dev-uploads-bundle.js'
import { fetchBundleFromHub } from './fetch-bundle-from-hub.js'

/**
 * Console-backed scoped logger for the deploy swap (the only consumer in this
 * file). `applyDeployedBundle` logs only on the rare restore-after-failed-swap
 * path, so a thin console adapter is sufficient.
 */
const DEFAULT_DRI_RENDER_NODE = '/dev/dri/renderD128'

/**
 * Light decode + detection hardware facts for the agent UI — cheap local
 * probes, no registry walk. `hwaccel` is the first preferred backend or
 * `software`; `detectionDevices` lists enabled accelerator keys.
 */
function buildDecodeDetectionSlice(): {
  readonly decode: {
    readonly hwaccel: string
    readonly driDevice: string | null
  }
  readonly detectionDevices: readonly string[]
} {
  const hw = resolveHwAccel()
  const signals = probePlatform()
  const inference = mapSignalsToInferenceHardware(signals)
  const driDevice = fs.existsSync(DEFAULT_DRI_RENDER_NODE) ? DEFAULT_DRI_RENDER_NODE : null
  const detectionDevices: string[] = []
  if (inference.gpu !== null) detectionDevices.push(inference.gpu.type)
  if (inference.npu !== null) detectionDevices.push(inference.npu.type)
  // Only a Coral with a usable unit detects; a driverless one is reported by the probe.
  if (inference.coral != null && coralUsableUnits(inference.coral).length > 0)
    detectionDevices.push(inference.coral.type)
  return {
    decode: {
      hwaccel: hw.preferred[0] ?? 'software',
      driDevice,
    },
    detectionDevices,
  }
}

const deploySwapLogger: IScopedLogger = {
  info: (msg) => console.log(`[Agent] ${msg}`),
  warn: (msg) => console.warn(`[Agent] ${msg}`),
  error: (msg) => console.error(`[Agent] ${msg}`),
  debug: (msg) => console.debug(`[Agent] ${msg}`),
  child: () => deploySwapLogger,
  withTags: () => deploySwapLogger,
}

/**
 * Shape of the `$process.restart` reply (see
 * `packages/system/src/kernel/moleculer/process-service.ts`). `pid` is present
 * on success, `reason` on failure (e.g. the runner could not be resolved).
 */
interface ProcessRestartResult {
  readonly success: boolean
  readonly reason?: string
  readonly pid?: number
}

/**
 * Packages an agent bootstraps itself when the bootstrap does not say
 * otherwise. Mirrors the hub reconcile's `AGENT_BOOTSTRAP_PACKAGES`.
 */
const DEFAULT_AGENT_BOOTSTRAP_PACKAGES: ReadonlySet<string> = new Set([
  '@camstack/system',
  '@camstack/addon-agent-ui',
])

/** Timeout for the agent-local `$process.restart` delegation. */
const AGENT_PROCESS_RESTART_TIMEOUT_MS = 30_000

function getLocalIps(): string[] {
  const interfaces = os.networkInterfaces()
  const ips: string[] = []
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.internal) continue
      ips.push(iface.address)
    }
  }
  return ips
}

/**
 * Resolve a promise but never block longer than `ms` — on timeout, resolve to
 * `fallback`. `$agent.status`/`$agent.health` MUST always answer promptly: the
 * hub drops a node from `nodes.topology` whenever `$agent.status` times out, so
 * a status RPC that hangs on a transiently-unavailable metrics provider (e.g.
 * mid-reload) makes the agent silently vanish from the cluster. Bounding the
 * metrics fetch keeps the node visible with a degraded (zeroed) metrics block
 * instead of disappearing.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Bound for the metrics snapshot inside status/health — see `withTimeout`. */
const METRICS_SNAPSHOT_TIMEOUT_MS = 2_000

interface LoadedAddonEntry {
  readonly id: string
  readonly status: string
  /** Addon DECLARATION version (from the addon manifest). */
  readonly version?: string
  readonly packageName?: string
  /**
   * npm PACKAGE version (from the package's package.json) — distinct from the
   * addon declaration `version`. The hub's per-node update check compares the
   * installed PACKAGE version against the registry, so it must be reported
   * here; reporting the declaration version (often `0.1.0` while the package
   * is `1.0.4`) makes `listUpdates` show a permanent phantom update.
   */
  readonly packageVersion?: string
  readonly addon?: {
    shutdown?(): Promise<void>
    onHubReachable?(): Promise<void> | void
  }
}

interface AgentServiceDeps {
  readonly addonsDir: string
  readonly dataDir: string
  /** Human-readable agent name from env/config (e.g. "dev-agent-0"). */
  agentName: string
  /** Path to the agent config file (for persisting renames). */
  readonly configPath: string
  readonly loadedAddons: Map<string, LoadedAddonEntry>
  /**
   * Resolver for the current metrics-provider cap. Looked up lazily so the
   * service still answers `$agent.status` even before the metrics addon has
   * finished initializing.
   */
  readonly getMetricsProvider?: () => StatusMetricsSource | null
  /** Package version of the agent runtime (informational, surfaced via `$agent.health`). */
  readonly agentVersion?: string
  /**
   * Re-runs the agent's `loadDeployedAddons` discovery pass — picks up new
   * tarballs written under `addonsDir/` by `$agent.deploy` and spawns/wires
   * them without an agent restart. Returns the addon IDs that were freshly
   * loaded this pass. Wired by `agent-bootstrap.ts`; left optional so test
   * harnesses can build a service without driving the full bootstrap.
   */
  readonly reloadDeployedAddons?: () => Promise<readonly string[]>
  /**
   * Re-derive this node's COMPLETE capability manifest from the live
   * capability registry and re-run the atomic `$hub.registerNode` handshake
   * (D3 — idempotent replace, retried until the hub acks).
   *
   * Why it must be called from `reload`: the hub's `HubNodeRegistry` is a pure
   * PUSH. The agent's registration fires on agent boot, on a child's
   * `$agent.registerNode`, on every settled mesh join and on the hub's
   * `$agent.requestRegistration` — and nowhere else.
   * `$agent.reload` (which every `camstack deploy` to this agent ends in)
   * mutates `loadedAddons` AND the capability registry without any of those
   * happening, so a capability the node GAINS after boot stays invisible
   * to the hub until the next agent restart or hub reconnect. The hub's
   * `CapRouteResolver.nodeKnowsCap` reads that manifest, so an unlearned cap
   * is not merely missing from a list — it is unroutable, and reports as
   * `no-provider` on a node that is demonstrably providing it.
   *
   * This is a reconcile against the registry, hung on an EXISTING trigger —
   * no timer, no poll, no shadow registry (D3).
   */
  readonly reconcileNodeRegistration?: () => void
  /**
   * `$agent.requestRegistration`: the hub saw this node (re)connect and asks
   * for its complete capability set. The hub drops a node's registration on
   * every `$node.disconnected` IT sees, and that event can fire on the hub
   * alone (gossip from a third node, a failed write) — the agent then never
   * learns it must re-register (2026-10-14). Wired to the agent's upward
   * registration.
   */
  readonly requestRegistration?: () => void
  /**
   * Called when a group-runner child calls `$agent.registerNode`. The
   * agent-bootstrap wires this to aggregate the child's manifest into the
   * agent's subtree registry and re-register the complete union upward with
   * the hub. Optional so test harnesses can build the service without the
   * full bootstrap subtree machinery.
   */
  readonly onChildRegistered?: (params: RegisterNodeParams) => void
  /** Pull-install a published addon from npm/GHCR (wired by agent-bootstrap). */
  readonly installFromNpm?: (packageName: string, version: string) => Promise<void>
  /**
   * Install a deployed `.tgz` bundle through the agent's `AddonInstaller`
   * (`installFromTgz`): staged extract → `@camstack/*` manifest strip →
   * runtime-deps `npm install` (FATAL on failure) → manifest-driven native
   * deps → atomic rename swap. Wired by agent-bootstrap. When absent the
   * deploy handler falls back to the plain tar swap (`applyDeployedBundle`) —
   * the pre-#17 path that silently LOSES native deps (sharp on the Mac
   * Electron agent) because it never runs the installer's post-install.
   */
  readonly installBundleTgz?: (tgzPath: string) => Promise<{ name: string; version: string }>
  /**
   * Packages this node bootstraps itself (`@camstack/system` +
   * `AddonInstaller.AGENT_PACKAGES`) — `$agent.undeploy` refuses them.
   */
  readonly bootstrapPackages?: ReadonlySet<string>
  /**
   * Drop a cap proxy from the agent's central registry (the ones
   * `registerGroupRunnerProviders` installs). Wired by agent-bootstrap.
   */
  readonly unregisterProvider?: (capName: string, addonId: string) => void
}

interface AgentConfigFileShape {
  readonly hubAddress?: string
}

/**
 * Pure seam for the deploy handler routing logic — injected in production from
 * real deps, stubbed in tests. Allows unit-testing source routing without
 * Moleculer.
 */
export interface DeployActionSeam {
  installFromNpm: (pkg: string, version: string) => Promise<void>
  applyBundle: (bundle: Buffer) => Promise<{ addonDir: string }>
  fetchBundle: (s: Extract<AddonDeploySource, { kind: 'hub-http' }>) => Promise<Buffer>
  onApplied: (addonDir: string) => void
}

/**
 * Pure factory that builds the deploy routing logic from a seam. Exported so
 * the routing can be unit-tested without Moleculer or a real filesystem.
 */
export interface AgentDeployActionResult {
  readonly success: true
  readonly addonId: string
  readonly path?: string
  /**
   * sha256 of the bundle bytes this node actually unpacked. The hub compares it
   * against the bundle it staged and refuses the deploy on a mismatch — the
   * only end-to-end evidence that the bytes running here are the bytes shipped.
   * Absent on the npm source (nothing was streamed).
   */
  readonly appliedSha256?: string
}

export function resolveDeployAction(seam: DeployActionSeam) {
  const applyAndReport = async (addonId: string, buf: Buffer): Promise<AgentDeployActionResult> => {
    const appliedSha256 = createHash('sha256').update(buf).digest('hex')
    const { addonDir } = await seam.applyBundle(buf)
    seam.onApplied(addonDir)
    return { success: true, addonId, path: addonDir, appliedSha256 }
  }
  return async (params: {
    addonId: string
    source?: AddonDeploySource
    bundle?: Buffer | string
  }): Promise<AgentDeployActionResult> => {
    const { addonId, source, bundle } = params
    if (source && isAddonDeploySource(source)) {
      if (source.kind === 'npm') {
        await seam.installFromNpm(addonId, source.version)
        // npm path installs to disk via AddonInstaller and returns no addonDir; the
        // loadedAddons eviction (onApplied) only applies to bundle-extracted installs.
        return { success: true, addonId }
      }
      return applyAndReport(addonId, await seam.fetchBundle(source))
    }
    // Legacy inline-bundle path (back-compat, removed next release).
    if (bundle === undefined) {
      throw new Error('$agent.deploy: no source descriptor and no legacy bundle provided')
    }
    return applyAndReport(
      addonId,
      typeof bundle === 'string' ? Buffer.from(bundle, 'base64') : bundle,
    )
  }
}

function readHubAddressFromConfig(configPath: string): string | null {
  if (!configPath) return null
  try {
    if (!fs.existsSync(configPath)) return null
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AgentConfigFileShape
    return typeof raw.hubAddress === 'string' && raw.hubAddress.length > 0 ? raw.hubAddress : null
  } catch {
    return null
  }
}

/**
 * Read the addon declaration ids contributed by a deployed package.
 *
 * `loadedAddons` is keyed by `camstack.addons[].id` (the declaration
 * id), not the package name. A redeploy's `$agent.deploy` param is the
 * package name, so the deploy handler reads the freshly-extracted
 * `package.json` to recover the real ids it must evict before
 * `$agent.reload`. Best-effort — returns `[]` on a missing/corrupt
 * manifest (the reload then just falls back to its on-disk scan).
 */
function readDeployedAddonIds(addonDir: string): readonly string[] {
  try {
    const manifestPath = path.join(addonDir, 'package.json')
    if (!fs.existsSync(manifestPath)) return []
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      camstack?: { addons?: readonly { id?: unknown }[] }
    }
    const entries = raw.camstack?.addons ?? []
    const ids: string[] = []
    for (const entry of entries) {
      if (typeof entry.id === 'string' && entry.id.length > 0) ids.push(entry.id)
    }
    return ids
  } catch {
    return []
  }
}

function isHubConnected(broker: ServiceBroker): boolean {
  try {
    const nodes = broker.registry.getNodeList({ onlyAvailable: true })
    return nodes.some((n) => n.id === 'hub')
  } catch {
    return false
  }
}

/**
 * The agent's name as persisted in `agent.json` — the single source of truth the agent UI
 * writes (`POST /api/agent/config`). The in-memory `deps.agentName` is only a fallback: the
 * UI's follow-up `$agent.rename` call is best-effort and can be lost (broker mid-reconnect
 * while pairing), which left the hub on the old name until a restart.
 */
function persistedAgentName(configPath: string, fallback: string): string {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf-8'))
    if (typeof raw === 'object' && raw !== null && 'name' in raw) {
      const name = raw.name
      if (typeof name === 'string' && name.trim().length > 0) return name.trim()
    }
  } catch {
    /* no file yet, or unreadable: the in-memory name stands */
  }
  return fallback
}

function createAgentService(deps: AgentServiceDeps): ServiceSchema {
  return {
    name: '$agent',
    actions: {
      status: {
        handler: async (ctx: Context) => {
          const { broker } = ctx
          const cpus = os.cpus()
          let cpuPercent = 0
          let memoryPercent: number | null = null
          let freeMemoryBytes: number | null = null
          const metrics = deps.getMetricsProvider?.()
          if (metrics) {
            // Bounded so $agent.status never hangs (and drops the node from
            // topology) when the metrics provider is mid-reload/unavailable.
            const snapshot = await withTimeout(
              metrics.getCached(),
              METRICS_SNAPSHOT_TIMEOUT_MS,
              null,
            )
            if (snapshot) {
              cpuPercent = snapshot.cpu.total
              memoryPercent = snapshot.memory.percent
              freeMemoryBytes = snapshot.memory.availableBytes
            }
          }
          const mem = process.memoryUsage()
          const decodeDetection = buildDecodeDetectionSlice()
          return {
            nodeId: broker.nodeID,
            name: persistedAgentName(deps.configPath, deps.agentName),
            platform: os.platform(),
            arch: os.arch(),
            hostname: os.hostname(),
            cpuCores: cpus.length,
            cpuModel: cpus[0]?.model,
            totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
            freeMemoryMB:
              freeMemoryBytes === null ? null : Math.round(freeMemoryBytes / 1024 / 1024),
            cpuPercent,
            memoryPercent,
            // The agent's own (core) process, so a topology row can attribute
            // the largest process on the node instead of showing 0.
            processRssBytes: process.memoryUsage().rss,
            uptime: os.uptime(),
            // The agent *process* itself (distinct from the host `uptime` /
            // memory above) — surfaced so the UI can show how long THIS agent
            // has been running and how much RAM its own runtime holds.
            agentProcess: {
              pid: process.pid,
              uptimeSeconds: Math.round(process.uptime()),
              rssMB: Math.round(mem.rss / 1024 / 1024),
              heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
              heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            },
            localIps: getLocalIps(),
            decode: decodeDetection.decode,
            detectionDevices: decodeDetection.detectionDevices,
            // Cluster topology `engines` — supported python runtime ids
            // (`onnx` / `openvino` / `coreml` / `edgetpu`). Was declared on
            // AgentInfo but never reported, so every node badge stayed empty.
            pythonRuntimes: localSupportedPythonRuntimes(),
            addons: [...deps.loadedAddons.values()].map((a) => ({
              id: a.id,
              status: a.status,
              // Report the PACKAGE version (falls back to the declaration
              // version) so the hub's per-node update check is accurate.
              version: a.packageVersion ?? a.version,
              packageName: a.packageName,
            })),
          }
        },
      },

      health: {
        handler: async (ctx: Context): Promise<AgentHealth> => {
          const { broker } = ctx
          let cpuPercent = 0
          let memoryPercent: number | null = null
          const metrics = deps.getMetricsProvider?.()
          if (metrics) {
            try {
              // Bounded — see $agent.status. Health must answer promptly too.
              const snapshot = await withTimeout(
                metrics.getCached(),
                METRICS_SNAPSHOT_TIMEOUT_MS,
                null,
              )
              if (snapshot) {
                cpuPercent = snapshot.cpu.total
                memoryPercent = snapshot.memory.percent
              }
            } catch {
              /* metrics may be transiently unavailable */
            }
          }
          let total = 0
          let running = 0
          let errored = 0
          for (const a of deps.loadedAddons.values()) {
            total++
            if (a.status === 'running') running++
            else if (a.status === 'error') errored++
          }
          const hubAddress = readHubAddressFromConfig(deps.configPath)
          return {
            ok: errored === 0,
            nodeId: broker.nodeID,
            name: persistedAgentName(deps.configPath, deps.agentName),
            version: deps.agentVersion ?? 'unknown',
            uptimeSeconds: Math.round(process.uptime()),
            pid: process.pid,
            hubConnected: isHubConnected(broker),
            hubAddress,
            addons: { total, running, error: errored },
            cpuPercent,
            memoryPercent,
            checkedAt: new Date().toISOString(),
          }
        },
      },

      shutdown: {
        handler() {
          // Graceful shutdown — schedule so the Moleculer response goes out first
          setTimeout(() => process.exit(0), 500)
          return { success: true }
        },
      },

      rename: {
        handler(ctx: Context<{ name: string }>) {
          const { params, broker } = ctx
          const newName = params.name
          if (!newName || typeof newName !== 'string') {
            throw new Error('$agent.rename: name is required')
          }
          const oldName = deps.agentName
          // Update in-memory name (affects subsequent $agent.status responses)
          deps.agentName = newName.trim()
          broker.logger.info(`Agent renamed: "${oldName}" → "${deps.agentName}"`)
          // Persist to config file
          try {
            const configFile = path.resolve(deps.configPath)
            let raw: Record<string, unknown> = {}
            if (fs.existsSync(configFile)) {
              try {
                raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>
              } catch {
                /* corrupt */
              }
            }
            raw.name = deps.agentName
            fs.mkdirSync(path.dirname(configFile), { recursive: true })
            fs.writeFileSync(configFile, JSON.stringify(raw, null, 2), 'utf-8')
            broker.logger.info(`Agent name persisted to ${configFile}`)
          } catch (err) {
            broker.logger.warn(
              'Agent rename: config file write failed (in-memory rename still active)',
              { error: String(err) },
            )
          }
          return { success: true, name: deps.agentName }
        },
      },

      listAddons: {
        handler() {
          return [...deps.loadedAddons.keys()]
        },
      },

      deploy: {
        handler: async (
          ctx: Context<{
            addonId: string
            source?: AddonDeploySource
            bundle?: Buffer | string
            config?: Record<string, unknown>
          }>,
        ) => {
          const { addonId, source, bundle } = ctx.params

          // execFile (no shell) instead of execSync — addonId comes from RPC
          // params and was previously interpolated into a shell command, which
          // is a command-injection vector. argv form doesn't go through a shell
          // so any payload in addonId stays a literal path arg. Use the ASYNC
          // form (not execFileSync): a synchronous extract blocks the agent
          // event loop for the whole untar, which on a large package starves
          // concurrent hub RPCs ($agent.status heartbeat) long enough for the
          // hub to time them out and drop the node from topology mid-deploy.
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)

          // Atomic install: extract into a temp dir then swap into place. The
          // old body `rm`'d the live dir THEN untarred — a killed/timed-out
          // untar (e.g. a redeploy whose RPC was cut) left the addon dir
          // MISSING. `applyDeployedBundle` never leaves the live dir absent
          // (the non-atomic-deploy fix).
          const extract = async (tgz: Buffer, destDir: string): Promise<void> => {
            const tgzPath = path.join(destDir, '..', `.${path.basename(destDir)}.tgz`)
            fs.writeFileSync(tgzPath, tgz)
            try {
              await execFileAsync('tar', ['-xzf', tgzPath, '-C', destDir, '--strip-components=1'], {
                timeout: 60000,
              })
            } finally {
              try {
                fs.unlinkSync(tgzPath)
              } catch {
                /* best-effort temp cleanup */
              }
            }
          }

          const seam: DeployActionSeam = {
            installFromNpm: (pkg, v) => {
              if (!deps.installFromNpm) {
                throw new Error('npm deploy source unsupported on this agent')
              }
              return deps.installFromNpm(pkg, v)
            },
            // #17: route the bundle through the agent's AddonInstaller when
            // wired — installFromTgz runs the FULL post-install (manifest
            // strip, runtime-deps npm install, manifest-driven NATIVE deps)
            // with its own staged extract + atomic swap. The plain tar swap
            // below never installed deps, so every pipeline/post-analysis
            // deploy on the Mac Electron agent silently shipped without
            // `sharp` et al. Fallback kept for agents without an installer
            // (test harnesses).
            applyBundle: async (buf) => {
              if (deps.installBundleTgz) {
                const tgzPath = path.join(
                  os.tmpdir(),
                  `camstack-deploy-${addonId.replace(/[^\w.-]/g, '_')}-${Date.now()}.tgz`,
                )
                fs.writeFileSync(tgzPath, buf)
                try {
                  const { name } = await deps.installBundleTgz(tgzPath)
                  return { addonDir: path.join(deps.addonsDir, name) }
                } finally {
                  try {
                    fs.unlinkSync(tgzPath)
                  } catch {
                    /* best-effort temp cleanup */
                  }
                }
              }
              return applyDeployedBundle({
                addonsDir: deps.addonsDir,
                addonId,
                bundle: buf,
                extract,
                logger: deploySwapLogger,
              })
            },
            fetchBundle: (s) => fetchBundleFromHub(s),
            // Evict every addon DECLARATION id this package contributes
            // from `loadedAddons` so the follow-up `$agent.reload` actually
            // re-instantiates it. `loadDeployedAddons` skips any addon
            // still present in `loadedAddons`; without this eviction a
            // redeploy would leave the agent pinned to the pre-update
            // version. The `deploy` param `addonId` is the PACKAGE name
            // (used only as the on-disk dir), whereas `loadedAddons` is
            // keyed by the addon DECLARATION id — they differ for scoped
            // packages, so we read the extracted manifest to bridge them.
            onApplied: (addonDir) => {
              for (const declId of readDeployedAddonIds(addonDir)) {
                deps.loadedAddons.delete(declId)
              }
            },
          }

          return resolveDeployAction(seam)({ addonId, source, bundle })
        },
      },

      /**
       * Stage a hub-packed `dev-uploads/<version>/` set under this node's
       * `server-root/dev-uploads/` so a subsequent `applyServerUpdate` for a
       * `-dev.<epoch>` version can promote locally (Path B fan-out). Does not
       * restart or promote — only writes the upload layout.
       */
      stageDevUploads: {
        handler: async (
          ctx: Context<{
            version: string
            source: Extract<AddonDeploySource, { kind: 'hub-http' }>
          }>,
        ) => {
          const params = ctx.params
          const seam: StageDevUploadsSeam = {
            dataDir: deps.dataDir,
            fetchBundle: (s) => fetchBundleFromHub(s),
            unpack: unpackDevUploadVersionBundle,
          }
          return applyStageDevUploads(seam, params)
        },
      },

      /**
       * Pull a staged model tarball from the hub and untar it into this node's
       * `<dataDir>/models` (Model Studio P2). Reuses the agent-pull machinery:
       * `fetchBundleFromHub` verifies bytes + sha256 before extraction. The
       * existing `isModelDownloaded` then reports the model present, so the
       * detection-pipeline can load it locally.
       */
      distributeModel: {
        handler: async (
          ctx: Context<{
            modelId: string
            format: string
            source: Extract<AddonDeploySource, { kind: 'hub-http' }>
          }>,
        ) => {
          const params = ctx.params
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)
          const modelsDir = path.join(deps.dataDir, 'models')
          const seam: ModelDistributionSeam = {
            modelsDir,
            fetchBundle: (s) => fetchBundleFromHub(s),
            extract: async (tgz, destDir) => {
              const tmp = path.join(
                destDir,
                `.dist-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`,
              )
              fs.writeFileSync(tmp, tgz)
              try {
                await execFileAsync('tar', ['-xzf', tmp, '-C', destDir], { timeout: 60000 })
              } finally {
                try {
                  fs.unlinkSync(tmp)
                } catch {
                  /* best-effort temp cleanup */
                }
              }
            },
            mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
          }
          return applyModelDistribution(seam, params)
        },
      },

      /**
       * Genuinely drop a deployed addon — or a whole package — from this agent.
       * `{ packageName }` is the operator's uninstall (`addons.uninstallPackage
       * ({ nodeId })`); `{ addonId }` is the stale-addon reconcile. Both stop the
       * runner(s) hosting the addon, which the old body never did: on an agent
       * nearly every addon lives in a group runner, so deleting its folder left
       * the process running and advertising its caps. See `agent-undeploy.ts`.
       */
      undeploy: {
        handler: async (ctx: Context<AgentUndeployRequest>) => {
          const { params, broker } = ctx
          const bkr = asBrokerLike(broker)
          return undeployFromAgent(
            {
              addonsDir: deps.addonsDir,
              loadedAddons: deps.loadedAddons,
              bootstrapPackages: deps.bootstrapPackages ?? DEFAULT_AGENT_BOOTSTRAP_PACKAGES,
              listRunnersByAddon: (addonId) =>
                bkr.call<readonly AgentRunnerRow[]>(
                  '$process.listByAddon',
                  { addonId },
                  { nodeID: broker.nodeID, timeout: AGENT_PROCESS_RESTART_TIMEOUT_MS },
                ),
              stopRunner: (name) =>
                bkr.call<AgentRunnerStopResult>(
                  '$process.stop',
                  { name },
                  { nodeID: broker.nodeID, timeout: AGENT_PROCESS_RESTART_TIMEOUT_MS },
                ),
              destroyService: (addonId) => broker.destroyService(addonId),
              unregisterProvider: (capName, addonId) => deps.unregisterProvider?.(capName, addonId),
              respawnSurvivors: deps.reloadDeployedAddons,
              reconcileNodeRegistration: deps.reconcileNodeRegistration,
              logger: deploySwapLogger,
            },
            { addonId: params.addonId, packageName: params.packageName },
          )
        },
      },

      /**
       * Re-run `loadDeployedAddons` so addons just dropped onto disk via
       * `$agent.deploy` (or via the hub broadcasting an upload) start
       * immediately. Without this the agent only discovers them on boot.
       * Returns the ids that were newly loaded — the hub uses this to
       * surface a per-agent diff in the upload response.
       */
      reload: {
        handler: async (): Promise<{ success: boolean; loaded: readonly string[] }> => {
          if (!deps.reloadDeployedAddons) {
            return { success: false, loaded: [] }
          }
          const loaded = await deps.reloadDeployedAddons()
          // The reload just changed this node's capability set. Re-run the
          // atomic registerNode so the hub's routing authority learns it now,
          // instead of at the next restart / reconnect. Unconditional: an
          // empty `loaded` still covers a RE-load of an existing addon whose
          // manifest gained a capability, and registerNode is an idempotent
          // replace (D3), so a no-op re-register costs one acked RPC.
          deps.reconcileNodeRegistration?.()
          return { success: true, loaded }
        },
      },

      restart: {
        handler: async (ctx: Context<{ addonId: string }>) => {
          const { params, broker } = ctx
          const bkr = asBrokerLike(broker)
          const { addonId } = params
          // Delegate to THIS agent's own `$process` service — the SAME primitive
          // the hub uses for a local forked addon (AddonRegistryService.restartAddon
          // → `$process.restart`). `resolveRunnerName` maps `addonId` to its hosting
          // runner (direct runner key OR `runnerAddons` membership), so the child is
          // respawned, the crash streak reset (`crashSupervisor.reset`), the stale
          // Moleculer node evicted, and the addon's caps re-registered — identical
          // semantics to a hub-local restart. Pin to the agent's own node so the
          // call always hits THIS agent's `$process`, never the hub's.
          const result = await bkr.call<ProcessRestartResult>(
            '$process.restart',
            { name: addonId },
            { nodeID: broker.nodeID, timeout: AGENT_PROCESS_RESTART_TIMEOUT_MS },
          )
          if (!result.success) {
            // Fail loudly so the hub's `nodes.restartAddon` surfaces the real
            // error instead of the old fire-and-forget phantom success.
            throw new Errors.MoleculerError(
              `$agent.restart: process restart failed for "${addonId}": ${result.reason ?? 'unknown'}`,
              500,
              'AGENT_RESTART_FAILED',
            )
          }
          return { success: true, addonId, pid: result.pid }
        },
      },

      /**
       * The hub asks for this node's complete capability set (sent on the
       * hub's `$node.connected`). Answers at once; the registration itself
       * goes out through the atomic `$hub.registerNode` (D3), after a fresh
       * mesh join when the hub has forgotten this node's.
       */
      requestRegistration: {
        handler(): { ok: boolean } {
          if (deps.requestRegistration === undefined) return { ok: false }
          deps.requestRegistration()
          return { ok: true }
        },
      },

      /**
       * D3 subtree aggregation: a forked group-runner child calls this action
       * to deliver its complete capability manifest to the agent. The agent
       * then re-registers the UNION of its own in-process addons + all children
       * with the hub via `$hub.registerNode`.
       */
      registerNode: {
        handler(ctx: Context<RegisterNodeParams>): RegisterNodeResult {
          const { params } = ctx
          deps.onChildRegistered?.(params)
          return { ok: true }
        },
      },
    },
  }
}

export type { AgentServiceDeps, LoadedAddonEntry }
export { createAgentService }
